/**
 * One Durable Object per vault.
 *
 * The Node server had to build two things by hand that this gets for free:
 *
 *   1. `withVaultLock` — a promise chain serialising read-modify-write, because
 *      two devices syncing at the same instant would otherwise lose one side's
 *      edits. A Durable Object is single-threaded and there is exactly one
 *      instance per vault, so the lock *is* the object.
 *   2. Atomic writes via write-to-tmp-then-rename, because a droplet losing
 *      power mid-write could leave a half-written vault. SQLite gives us that.
 *
 * Storage is SQL rather than the key-value API on purpose: a vault is capped by
 * MAX_TOTAL (2000) sprites with names and notes, so a legitimate document can
 * reach roughly 1.2 MB — an order of magnitude past the 128 KB ceiling on a
 * key-value value. A TEXT column has no such limit.
 */

import { DurableObject } from 'cloudflare:workers';

import { mergeDocs, normalizeDoc, compactDoc } from '../public/lib/vault.js';

/** Per-vault write budget. A human syncing two devices never approaches this. */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_WRITES = 60;

export class VaultObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);

    this.sql = ctx.storage.sql;
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS vault (id INTEGER PRIMARY KEY CHECK (id = 1), doc TEXT NOT NULL)',
    );

    // Held in memory only. Eviction resets the window, which fails open — the
    // right direction for a rate limit whose job is to blunt hammering, not to
    // be an access control.
    this.writeWindowStart = 0;
    this.writeCount = 0;
  }

  /** @returns the stored document, or null when this vault does not exist yet. */
  async read() {
    const rows = this.sql.exec('SELECT doc FROM vault WHERE id = 1').toArray();
    if (rows.length === 0) return null;

    try {
      return normalizeDoc(JSON.parse(rows[0].doc));
    } catch (err) {
      // A corrupted row must not take the endpoint down; treat it as absent so
      // the client's own copy wins on the next write.
      console.error('[vault] read failed:', err.message);
      return null;
    }
  }

  /**
   * Merge `incoming` into whatever is stored and return the result.
   *
   * @returns {{ ok: true, doc: object } | { ok: false, status: number, error: string }}
   */
  async write(incoming) {
    const now = Date.now();
    if (now - this.writeWindowStart > RATE_LIMIT_WINDOW_MS) {
      this.writeWindowStart = now;
      this.writeCount = 0;
    }
    this.writeCount += 1;
    if (this.writeCount > RATE_LIMIT_MAX_WRITES) {
      return { ok: false, status: 429, error: 'slow down' };
    }

    const existing = await this.read();
    // Existing goes first so a tie resolves to what is already stored; the
    // client always stamps updatedAt on a real edit, so real edits still win.
    const merged = compactDoc(existing ? mergeDocs(existing, incoming) : normalizeDoc(incoming));

    this.sql.exec(
      'INSERT INTO vault (id, doc) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET doc = excluded.doc',
      JSON.stringify(merged),
    );

    return { ok: true, doc: merged };
  }
}
