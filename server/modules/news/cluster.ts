/**
 * Groups articles that describe the same development so that corroboration
 * across independent outlets can be measured. Greedy single-pass clustering
 * on headline token overlap, which is cheap, deterministic and easy to audit.
 */
const STOP = new Set(
  `a an the and or but of in on at to for from by with as is are was were be been it its this that these those
   after before over under into out up down off new says say said will would could should may might has have had
   not no than then more most amid about against how why what who when where his her their our your us we he she they
   live updates latest news video watch report reports analysis opinion first two one year years day days week amp`.split(/\s+/),
);

export function titleTokens(title: string): Set<string> {
  const tokens = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]s\b/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOP.has(t))
    .map((t) => (t.length > 4 && t.endsWith('s') ? t.slice(0, -1) : t));
  return new Set(tokens);
}

function overlap(a: Set<string>, b: Set<string>): { jaccard: number; shared: number } {
  let shared = 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) shared++;
  const union = a.size + b.size - shared;
  return { jaccard: union === 0 ? 0 : shared / union, shared };
}

export interface Clusterable {
  id: number;
  title: string;
  publishedAt: number;
}

/**
 * Returns article id -> story id (the smallest article id in its cluster, so
 * ids are stable as later coverage joins). Articles only join a story whose
 * most recent coverage is within `windowMs`.
 */
export function clusterArticles(items: Clusterable[], windowMs = 48 * 3_600_000): Map<number, number> {
  const sorted = [...items].sort((a, b) => a.publishedAt - b.publishedAt || a.id - b.id);
  const clusters: { storyId: number; members: Set<string>[]; lastAt: number }[] = [];
  const assignment = new Map<number, number>();

  for (const item of sorted) {
    const tokens = titleTokens(item.title);
    let best: (typeof clusters)[number] | undefined;
    let bestScore = 0;
    if (tokens.size >= 3) {
      for (const c of clusters) {
        if (item.publishedAt - c.lastAt > windowMs) continue;
        // Compare against each member headline; best link decides.
        for (const m of c.members) {
          const { jaccard, shared } = overlap(tokens, m);
          const match = jaccard >= 0.5 || (shared >= 4 && jaccard >= 0.34);
          if (match && jaccard > bestScore) {
            best = c;
            bestScore = jaccard;
          }
        }
      }
    }
    if (best) {
      best.members.push(tokens);
      best.lastAt = Math.max(best.lastAt, item.publishedAt);
      best.storyId = Math.min(best.storyId, item.id);
      assignment.set(item.id, -1 - clusters.indexOf(best));
    } else {
      clusters.push({ storyId: item.id, members: [tokens], lastAt: item.publishedAt });
      assignment.set(item.id, -clusters.length);
    }
  }
  // Resolve placeholder cluster indexes to final (minimum) story ids.
  for (const [id, placeholder] of assignment) {
    assignment.set(id, (clusters[-placeholder - 1] as { storyId: number }).storyId);
  }
  return assignment;
}

export interface SignificanceInput {
  sourceCount: number;
  articleCount: number;
  maxSeverity: number;
  latestAt: number;
  now?: number;
}

export interface Significance {
  score: number;
  corroboration: number;
  severity: number;
  volume: number;
  recency: number;
}

/**
 * Transparent 0-100 significance score. Each component is returned so the UI
 * can show exactly why a story ranks where it does.
 */
export function significance(i: SignificanceInput): Significance {
  const ageH = Math.max(0, ((i.now ?? Date.now()) - i.latestAt) / 3_600_000);
  const corroboration = (Math.min(i.sourceCount, 5) / 5) * 40;
  const severity = i.maxSeverity * 30;
  const volume = Math.min(1, Math.log1p(i.articleCount) / Math.log1p(8)) * 10;
  const recency = Math.exp(-ageH / 24) * 20;
  const r = (n: number) => Math.round(n * 10) / 10;
  return {
    score: Math.round(corroboration + severity + volume + recency),
    corroboration: r(corroboration),
    severity: r(severity),
    volume: r(volume),
    recency: r(recency),
  };
}
