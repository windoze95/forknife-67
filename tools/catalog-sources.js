/** Parsers for the live watchdog. Only read data; never execute source JS. */
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  .replace(/&amp;/g, '&').replace(/&#(?:39|x27);/gi, "'").trim();

export function parseRosterIndex(html, url) {
  const visible = text(html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ''));
  const season = visible.match(/Chapter\s+(\d+)\s+Season\s+(\d+)/i);
  const count = visible.match(/(\d+)\s+Sprites across\s+(\d+)\s+released\s+variants/i);
  if (!season || !count) throw new Error('Roster season or collection count is missing');
  const links = new Map();
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const target = new URL(match[1], url);
    if (target.origin !== new URL(url).origin || !/^\/sprites\/[^/]+\/$/.test(target.pathname)) continue;
    const name = text(match[2]).match(/^(.*?) Sprite\b/)?.[1];
    if (!name) throw new Error(`Sprite link has no readable name: ${target.pathname}`);
    links.set(target.href, { url: target.href, name });
  }
  if (links.size !== Number(count[1]) || !links.size) {
    throw new Error(`Incomplete roster: read ${links.size} families, page declares ${count[1]}`);
  }
  return { season: `C${season[1]} S${season[2]}`, families: [...links.values()], publishedTotal: Number(count[2]) };
}

/** Require every row of the actual variant table, including upcoming entries. */
export function parseVariantTable(html) {
  const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)];
  const table = tables.find((match) => /<th\b[^>]*>\s*Variant\s*<\/th>/i.test(match[1]));
  if (!table) throw new Error('Variant table is missing');
  const rows = [...table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .filter((match) => /<td\b/i.test(match[1]));
  if (!rows.length) throw new Error('Variant table is empty');
  return rows.map((row) => {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => text(cell[1]));
    if (cells.length !== 4 || !cells[0] || !['Released', 'Upcoming'].includes(cells[3])) {
      throw new Error('Variant table layout or release status changed');
    }
    return { name: cells[0], released: cells[3] === 'Released' };
  });
}

export function parseBuild(json) {
  const data = JSON.parse(json);
  const match = data.status === 200 && data.data?.build?.match(/\+Release-(\d+\.\d+)(?:-|\b)/);
  if (!match) throw new Error('Live game build is missing or malformed');
  return `v${match[1]}`;
}
