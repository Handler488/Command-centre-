import { detectCountries } from './gazetteer.ts';

export const TOPICS = [
  { id: 'conflict', label: 'Conflict & security' },
  { id: 'politics', label: 'Politics & governance' },
  { id: 'diplomacy', label: 'Diplomacy' },
  { id: 'economy', label: 'Economy & markets' },
  { id: 'energy', label: 'Energy & climate' },
  { id: 'technology', label: 'Technology & cyber' },
  { id: 'health', label: 'Health' },
  { id: 'disaster', label: 'Disasters & humanitarian' },
  { id: 'science', label: 'Science & space' },
] as const;

export type TopicId = (typeof TOPICS)[number]['id'];
export type ArticleKind = 'report' | 'analysis' | 'opinion' | 'live';

const w = (words: string) => new RegExp(`\\b(?:${words})\\b`, 'i');

const TOPIC_RULES: Record<TopicId, RegExp> = {
  conflict: w(
    'war|wars|warfare|airstrikes?|air strikes?|strikes? on|missiles?|drones?|troops|military|army|navy|soldiers?|militants?|rebels?|insurgen\\w+|ceasefire|truce|invasion|invaded?|offensive|shelling|bomb\\w*|attack(?:s|ed)?|hostages?|terror\\w*|gunmen|killed in|frontline|artillery|nuclear weapons?|defen[cs]e ministry|coup',
  ),
  politics: w(
    'elections?|vot(?:e|es|ers|ing)|ballot|parliament\\w*|prime minister|president(?:ial)?|senate|congress|minister|cabinet|coalition|opposition|referendum|impeach\\w*|resign\\w*|protest\\w*|court rules?|supreme court|legislation|lawmakers?|government|campaign|polls?',
  ),
  diplomacy: w(
    'summit|talks|negotiat\\w+|diploma\\w+|ambassador|embassy|treaty|sanctions?|united nations|security council|nato|g7|g20|brics|bilateral|peace deal|peace plan|foreign minister|envoy|alliance',
  ),
  economy: w(
    'econom\\w+|inflation|interest rates?|central bank|federal reserve|\\bfed\\b|ecb|gdp|recession|stocks?|shares|markets?|tariffs?|trade war|trade deal|exports?|imports?|unemployment|jobs report|currency|dollar|euro|yuan|bonds?|debt|budget|earnings|profits?|investors?|ipo|merger|acquisition|bankrupt\\w*',
  ),
  energy: w(
    'oil|crude|opec|natural gas|lng|pipeline|energy|electricity|power grid|renewables?|solar|wind farm|nuclear plant|climate|emissions|carbon|cop\\d{2}|global warming|heatwave|fossil fuels?',
  ),
  technology: w(
    'ai|artificial intelligence|chips?|semiconductors?|cyber\\w*|hack(?:ed|ers?|ing)?|data breach|ransomware|software|tech giants?|social media|big tech|quantum|robot\\w*|startup|openai|nvidia|google|apple|microsoft|meta|tiktok|encryption|surveillance',
  ),
  health: w(
    'health|hospital\\w*|virus|outbreak|pandemic|epidemic|vaccin\\w+|disease|cholera|ebola|measles|covid\\w*|who says|world health organization|cancer|drug approval|medical|doctors?|nhs',
  ),
  disaster: w(
    'earthquake|quake|tsunami|hurricane|typhoon|cyclone|floods?|flooding|wildfires?|landslide|drought|famine|volcano|eruption|refugees?|displaced|humanitarian|aid convoy|evacuat\\w+|death toll|rescue\\w*|survivors?',
  ),
  science: w(
    'nasa|spacex|space station|rocket launch|satellite|astronauts?|moon|mars|telescope|scientists?|researchers?|study finds|discovery|physics|genome|fossil|species',
  ),
};

/** Terms signalling consequential events, with a 0..1 weight. Highest hit wins. */
const SEVERITY_RULES: [RegExp, number][] = [
  [w('declares? war|invasion|invades?|nuclear (?:strike|test|attack)|coup|assassinat\\w+|genocide|state of emergency|martial law'), 1.0],
  [w('killed|dead|deaths?|death toll|massacre|airstrikes?|missile (?:strike|attack)|bombing|explosion|earthquake|tsunami|famine|pandemic|default(?:s|ed)?|collapse[sd]?'), 0.8],
  [w('ceasefire|truce|peace deal|sanctions|resigns?|impeach\\w+|election results?|wins election|rate (?:cut|hike|rise)|crash(?:es|ed)?|recession|outbreak|evacuat\\w+|hostages?'), 0.6],
  [w('attack(?:s|ed)?|clashes|protests?|strikes?|tariffs?|summit|emergency|arrest(?:s|ed)?|warns?|crisis|floods?|wildfires?|hurricane|typhoon|cyclone'), 0.4],
];

export function detectTopics(text: string): TopicId[] {
  const out: TopicId[] = [];
  for (const t of TOPICS) if (TOPIC_RULES[t.id].test(text)) out.push(t.id);
  return out;
}

export function severityOf(text: string): number {
  for (const [re, weight] of SEVERITY_RULES) if (re.test(text)) return weight;
  return 0;
}

/**
 * Separate straight reporting from commentary. Deliberately conservative:
 * only label something analysis/opinion when the publisher signals it in the
 * URL section or headline convention; everything else is treated as reporting.
 */
export function detectKind(title: string, url: string): ArticleKind {
  const u = url.toLowerCase();
  if (/\/(opinions?|commentisfree|commentary|editorials?|columnists?|voices|letters)\//.test(u)) return 'opinion';
  if (/^(opinion|comment|editorial|the guardian view|letters?)\b\s*[:|]/i.test(title)) return 'opinion';
  if (/\/live(blog)?\/|\/live-|-live-updates/.test(u) || /\b(live updates|as it happened)\b|[–-] live$|^live[:\s]/i.test(title)) return 'live';
  if (/\/(analysis|explainers?|features?|in-depth|longform|the-big-picture|interactive)\//.test(u)) return 'analysis';
  if (/^(analysis|explainer|explained|fact check|q&a)\b\s*[:|]/i.test(title)) return 'analysis';
  if (/^(why|how|what|who|is|are|can|could|will|does|did)\b.*\?$/i.test(title)) return 'analysis';
  if (/\b(what we know|what to know|explained|five things|key takeaways|in charts|what it means|what next)\b/i.test(title)) return 'analysis';
  return 'report';
}

export interface Classification {
  countries: string[];
  topics: TopicId[];
  kind: ArticleKind;
  severity: number;
}

export function classify(title: string, summary: string, url: string): Classification {
  const text = `${title}. ${summary}`;
  return {
    countries: detectCountries(text),
    topics: detectTopics(text),
    kind: detectKind(title, url),
    severity: severityOf(text),
  };
}
