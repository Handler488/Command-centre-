import { XMLParser } from 'fast-xml-parser';

export interface FeedItem {
  title: string;
  url: string;
  summary: string;
  publishedAt: Date;
}

/** Feeds enabled on first run. All are public RSS endpoints from established newsrooms. */
export const DEFAULT_SOURCES = [
  { id: 'bbc-world', name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', homepage: 'https://www.bbc.com/news/world', region: 'UK' },
  { id: 'bbc-business', name: 'BBC Business', url: 'https://feeds.bbci.co.uk/news/business/rss.xml', homepage: 'https://www.bbc.com/news/business', region: 'UK' },
  { id: 'guardian-world', name: 'The Guardian', url: 'https://www.theguardian.com/world/rss', homepage: 'https://www.theguardian.com/world', region: 'UK' },
  { id: 'aljazeera', name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', homepage: 'https://www.aljazeera.com', region: 'Qatar' },
  { id: 'npr-world', name: 'NPR', url: 'https://feeds.npr.org/1004/rss.xml', homepage: 'https://www.npr.org/sections/world/', region: 'US' },
  { id: 'nyt-world', name: 'The New York Times', url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', homepage: 'https://www.nytimes.com/section/world', region: 'US' },
  { id: 'dw-world', name: 'Deutsche Welle', url: 'https://rss.dw.com/rdf/rss-en-world', homepage: 'https://www.dw.com/en/world/s-1429', region: 'Germany' },
  { id: 'france24', name: 'France 24', url: 'https://www.france24.com/en/rss', homepage: 'https://www.france24.com/en/', region: 'France' },
  { id: 'un-news', name: 'UN News', url: 'https://news.un.org/feed/subscribe/en/news/all/rss.xml', homepage: 'https://news.un.org/en/', region: 'International' },
];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
});

const asArray = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

function text(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if ('#text' in o) return text(o['#text']);
    if ('__cdata' in o) return text(o['__cdata']);
  }
  return '';
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', hellip: '…' };

/** Reduce feed HTML to plain text: drop tags, decode entities, collapse whitespace. */
export function cleanText(raw: string, max = 600): string {
  const s = raw
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED[name.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 40))}…`;
}

function atomLink(link: unknown): string {
  const links = asArray(link) as (string | Record<string, unknown>)[];
  for (const l of links) {
    if (typeof l === 'string') return l;
    const rel = l['@_rel'];
    if ((!rel || rel === 'alternate') && typeof l['@_href'] === 'string') return l['@_href'];
  }
  const first = links[0];
  return first && typeof first === 'object' && typeof first['@_href'] === 'string' ? first['@_href'] : '';
}

function normaliseUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|at_|ns_|traffic_source|CMP|ref$|ocid|cmpid|xtor|smid)/i.test(key)) u.searchParams.delete(key);
    }
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Parse RSS 2.0, RSS 1.0/RDF or Atom into normalised items. Items without a
 * usable link, title or publication date are dropped rather than guessed at.
 */
export function parseFeed(xml: string, now = new Date()): FeedItem[] {
  let doc: Record<string, any>;
  try {
    doc = parser.parse(xml);
  } catch {
    throw new Error('feed is not well-formed XML');
  }
  const rawItems: Record<string, unknown>[] = [
    ...asArray(doc?.rss?.channel?.item),
    ...asArray(doc?.['rdf:RDF']?.item),
    ...asArray(doc?.feed?.entry),
  ];
  if (!doc?.rss && !doc?.['rdf:RDF'] && !doc?.feed) throw new Error('not an RSS or Atom feed');

  const out: FeedItem[] = [];
  const seen = new Set<string>();
  for (const it of rawItems) {
    const title = cleanText(text(it.title), 300);
    const linkRaw = typeof it.link === 'string' ? it.link : atomLink(it.link) || text(it.link) || text(it.guid);
    const url = normaliseUrl(linkRaw);
    const dateRaw = text(it.pubDate) || text(it['dc:date']) || text(it.published) || text(it.updated);
    const publishedAt = new Date(dateRaw);
    if (!title || !url || !dateRaw || Number.isNaN(publishedAt.getTime())) continue;
    // Clock-skewed or scheduled items: ignore anything dated over an hour ahead.
    if (publishedAt.getTime() > now.getTime() + 3_600_000) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const summary = cleanText(text(it.description) || text(it.summary) || text(it['content:encoded']) || text(it.content));
    out.push({ title, url, summary: summary === title ? '' : summary, publishedAt });
  }
  return out;
}
