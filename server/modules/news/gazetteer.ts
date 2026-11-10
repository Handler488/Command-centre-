/**
 * Country gazetteer used to geo-tag headlines.
 * Row: [iso3, ISO-numeric (matches world-atlas ids), display name, lat, lon, aliases...]
 * Aliases are matched case-sensitively on word boundaries. The display name is
 * matched too unless listed in AMBIGUOUS (handled with extra context checks).
 */
type Row = [string, string, string, number, number, ...string[]];

const ROWS: Row[] = [
  ['AFG', '004', 'Afghanistan', 33.9, 67.7, 'Afghan', 'Kabul', 'Taliban'],
  ['ALB', '008', 'Albania', 41.2, 20.2, 'Albanian', 'Tirana'],
  ['DZA', '012', 'Algeria', 28.0, 1.7, 'Algerian', 'Algiers'],
  ['AGO', '024', 'Angola', -11.2, 17.9, 'Angolan', 'Luanda'],
  ['ARG', '032', 'Argentina', -38.4, -63.6, 'Argentine', 'Argentinian', 'Buenos Aires'],
  ['ARM', '051', 'Armenia', 40.1, 45.0, 'Armenian', 'Yerevan'],
  ['AUS', '036', 'Australia', -25.3, 133.8, 'Australian', 'Canberra', 'Sydney', 'Melbourne'],
  ['AUT', '040', 'Austria', 47.5, 14.6, 'Austrian', 'Vienna'],
  ['AZE', '031', 'Azerbaijan', 40.1, 47.6, 'Azerbaijani', 'Baku'],
  ['BHR', '048', 'Bahrain', 26.0, 50.6, 'Bahraini', 'Manama'],
  ['BGD', '050', 'Bangladesh', 23.7, 90.4, 'Bangladeshi', 'Dhaka'],
  ['BLR', '112', 'Belarus', 53.7, 27.9, 'Belarusian', 'Minsk', 'Lukashenko'],
  ['BEL', '056', 'Belgium', 50.5, 4.5, 'Belgian'],
  ['BOL', '068', 'Bolivia', -16.3, -63.6, 'Bolivian', 'La Paz'],
  ['BIH', '070', 'Bosnia and Herzegovina', 43.9, 17.7, 'Bosnia', 'Bosnian', 'Sarajevo'],
  ['BWA', '072', 'Botswana', -22.3, 24.7, 'Gaborone'],
  ['BRA', '076', 'Brazil', -14.2, -51.9, 'Brazilian', 'Brasilia', 'Brasília', 'Rio de Janeiro', 'São Paulo', 'Sao Paulo', 'Lula'],
  ['BGR', '100', 'Bulgaria', 42.7, 25.5, 'Bulgarian', 'Sofia'],
  ['BFA', '854', 'Burkina Faso', 12.2, -1.6, 'Burkinabe', 'Ouagadougou'],
  ['KHM', '116', 'Cambodia', 12.6, 105.0, 'Cambodian', 'Phnom Penh'],
  ['CMR', '120', 'Cameroon', 7.4, 12.4, 'Cameroonian', 'Yaoundé', 'Yaounde'],
  ['CAN', '124', 'Canada', 56.1, -106.3, 'Canadian', 'Ottawa', 'Toronto'],
  ['CAF', '140', 'Central African Republic', 6.6, 20.9, 'Bangui'],
  ['TCD', '148', 'Chad', 15.5, 18.7, 'Chadian', "N'Djamena"],
  ['CHL', '152', 'Chile', -35.7, -71.5, 'Chilean', 'Santiago'],
  ['CHN', '156', 'China', 35.9, 104.2, 'Chinese', 'Beijing', 'Shanghai', 'Xi Jinping', 'Hong Kong', 'Xinjiang'],
  ['COL', '170', 'Colombia', 4.6, -74.3, 'Colombian', 'Bogotá', 'Bogota'],
  ['COD', '180', 'DR Congo', -4.0, 21.8, 'Democratic Republic of Congo', 'Democratic Republic of the Congo', 'DRC', 'Congolese', 'Kinshasa', 'Goma'],
  ['CRI', '188', 'Costa Rica', 9.7, -83.8, 'Costa Rican'],
  ['HRV', '191', 'Croatia', 45.1, 15.2, 'Croatian', 'Zagreb'],
  ['CUB', '192', 'Cuba', 21.5, -77.8, 'Cuban', 'Havana'],
  ['CYP', '196', 'Cyprus', 35.1, 33.4, 'Cypriot', 'Nicosia'],
  ['CZE', '203', 'Czechia', 49.8, 15.5, 'Czech Republic', 'Czech', 'Prague'],
  ['DNK', '208', 'Denmark', 56.3, 9.5, 'Danish', 'Copenhagen'],
  ['ECU', '218', 'Ecuador', -1.8, -78.2, 'Ecuadorian', 'Quito'],
  ['EGY', '818', 'Egypt', 26.8, 30.8, 'Egyptian', 'Cairo'],
  ['SLV', '222', 'El Salvador', 13.8, -88.9, 'Salvadoran'],
  ['EST', '233', 'Estonia', 58.6, 25.0, 'Estonian', 'Tallinn'],
  ['ETH', '231', 'Ethiopia', 9.1, 40.5, 'Ethiopian', 'Addis Ababa', 'Tigray'],
  ['FIN', '246', 'Finland', 61.9, 25.7, 'Finnish', 'Helsinki'],
  ['FRA', '250', 'France', 46.2, 2.2, 'French', 'Paris', 'Macron'],
  ['GEO', '268', 'Georgia', 42.3, 43.4, 'Tbilisi'],
  ['DEU', '276', 'Germany', 51.2, 10.5, 'German', 'Berlin', 'Bundestag'],
  ['GHA', '288', 'Ghana', 7.9, -1.0, 'Ghanaian', 'Accra'],
  ['GRC', '300', 'Greece', 39.1, 21.8, 'Greek', 'Athens'],
  ['GTM', '320', 'Guatemala', 15.8, -90.2, 'Guatemalan'],
  ['HTI', '332', 'Haiti', 19.0, -72.3, 'Haitian', 'Port-au-Prince'],
  ['HND', '340', 'Honduras', 15.2, -86.2, 'Honduran'],
  ['HUN', '348', 'Hungary', 47.2, 19.5, 'Hungarian', 'Budapest', 'Orbán', 'Orban'],
  ['ISL', '352', 'Iceland', 64.9, -19.0, 'Icelandic', 'Reykjavik'],
  ['IND', '356', 'India', 20.6, 79.0, 'Indian', 'New Delhi', 'Delhi', 'Mumbai', 'Modi'],
  ['IDN', '360', 'Indonesia', -0.8, 113.9, 'Indonesian', 'Jakarta'],
  ['IRN', '364', 'Iran', 32.4, 53.7, 'Iranian', 'Tehran'],
  ['IRQ', '368', 'Iraq', 33.2, 43.7, 'Iraqi', 'Baghdad'],
  ['IRL', '372', 'Ireland', 53.4, -8.2, 'Irish', 'Dublin'],
  ['ISR', '376', 'Israel', 31.0, 34.9, 'Israeli', 'Tel Aviv', 'Jerusalem', 'Netanyahu'],
  ['ITA', '380', 'Italy', 41.9, 12.6, 'Italian', 'Rome', 'Meloni'],
  ['CIV', '384', "Côte d'Ivoire", 7.5, -5.5, 'Ivory Coast', 'Ivorian', 'Abidjan'],
  ['JPN', '392', 'Japan', 36.2, 138.3, 'Japanese', 'Tokyo'],
  ['JOR', '400', 'Jordan', 30.6, 36.2, 'Jordanian', 'Amman'],
  ['KAZ', '398', 'Kazakhstan', 48.0, 66.9, 'Kazakh', 'Astana'],
  ['KEN', '404', 'Kenya', -0.02, 37.9, 'Kenyan', 'Nairobi'],
  ['PRK', '408', 'North Korea', 40.3, 127.5, 'North Korean', 'Pyongyang', 'Kim Jong Un'],
  ['KOR', '410', 'South Korea', 35.9, 127.8, 'South Korean', 'Seoul'],
  ['XKX', '-99', 'Kosovo', 42.6, 20.9, 'Kosovan', 'Pristina'],
  ['KWT', '414', 'Kuwait', 29.3, 47.5, 'Kuwaiti'],
  ['KGZ', '417', 'Kyrgyzstan', 41.2, 74.8, 'Kyrgyz', 'Bishkek'],
  ['LAO', '418', 'Laos', 19.9, 102.5, 'Laotian', 'Vientiane'],
  ['LVA', '428', 'Latvia', 56.9, 24.6, 'Latvian', 'Riga'],
  ['LBN', '422', 'Lebanon', 33.9, 35.9, 'Lebanese', 'Beirut', 'Hezbollah'],
  ['LBY', '434', 'Libya', 26.3, 17.2, 'Libyan', 'Tripoli', 'Benghazi'],
  ['LTU', '440', 'Lithuania', 55.2, 23.9, 'Lithuanian', 'Vilnius'],
  ['MDG', '450', 'Madagascar', -18.8, 46.9, 'Malagasy', 'Antananarivo'],
  ['MYS', '458', 'Malaysia', 4.2, 102.0, 'Malaysian', 'Kuala Lumpur'],
  ['MLI', '466', 'Mali', 17.6, -4.0, 'Malian', 'Bamako'],
  ['MEX', '484', 'Mexico', 23.6, -102.6, 'Mexican', 'Mexico City'],
  ['MDA', '498', 'Moldova', 47.4, 28.4, 'Moldovan', 'Chisinau', 'Transnistria'],
  ['MNG', '496', 'Mongolia', 46.9, 103.8, 'Mongolian', 'Ulaanbaatar'],
  ['MAR', '504', 'Morocco', 31.8, -7.1, 'Moroccan', 'Rabat'],
  ['MOZ', '508', 'Mozambique', -18.7, 35.5, 'Mozambican', 'Maputo'],
  ['MMR', '104', 'Myanmar', 21.9, 95.9, 'Burma', 'Burmese', 'Naypyidaw', 'Yangon', 'Rohingya'],
  ['NPL', '524', 'Nepal', 28.4, 84.1, 'Nepali', 'Nepalese', 'Kathmandu'],
  ['NLD', '528', 'Netherlands', 52.1, 5.3, 'Dutch', 'Amsterdam', 'The Hague'],
  ['NZL', '554', 'New Zealand', -40.9, 174.9, 'Wellington', 'Auckland'],
  ['NIC', '558', 'Nicaragua', 12.9, -85.2, 'Nicaraguan'],
  ['NER', '562', 'Niger', 17.6, 8.1, 'Nigerien', 'Niamey'],
  ['NGA', '566', 'Nigeria', 9.1, 8.7, 'Nigerian', 'Abuja', 'Lagos'],
  ['NOR', '578', 'Norway', 60.5, 8.5, 'Norwegian', 'Oslo'],
  ['OMN', '512', 'Oman', 21.5, 55.9, 'Omani', 'Muscat'],
  ['PAK', '586', 'Pakistan', 30.4, 69.3, 'Pakistani', 'Islamabad', 'Karachi', 'Lahore'],
  ['PSE', '275', 'Palestine', 31.9, 35.2, 'Palestinian', 'Palestinians', 'Gaza', 'West Bank', 'Hamas', 'Rafah'],
  ['PAN', '591', 'Panama', 8.5, -80.8, 'Panamanian'],
  ['PRY', '600', 'Paraguay', -23.4, -58.4, 'Paraguayan'],
  ['PER', '604', 'Peru', -9.2, -75.0, 'Peruvian', 'Lima'],
  ['PHL', '608', 'Philippines', 12.9, 121.8, 'Philippine', 'Filipino', 'Manila'],
  ['POL', '616', 'Poland', 51.9, 19.1, 'Polish', 'Warsaw'],
  ['PRT', '620', 'Portugal', 39.4, -8.2, 'Portuguese', 'Lisbon'],
  ['QAT', '634', 'Qatar', 25.4, 51.2, 'Qatari', 'Doha'],
  ['ROU', '642', 'Romania', 45.9, 25.0, 'Romanian', 'Bucharest'],
  ['RUS', '643', 'Russia', 61.5, 105.3, 'Russian', 'Moscow', 'Kremlin', 'Putin'],
  ['RWA', '646', 'Rwanda', -1.9, 29.9, 'Rwandan', 'Kigali'],
  ['SAU', '682', 'Saudi Arabia', 23.9, 45.1, 'Saudi', 'Riyadh'],
  ['SEN', '686', 'Senegal', 14.5, -14.5, 'Senegalese', 'Dakar'],
  ['SRB', '688', 'Serbia', 44.0, 21.0, 'Serbian', 'Belgrade'],
  ['SGP', '702', 'Singapore', 1.35, 103.8, 'Singaporean'],
  ['SVK', '703', 'Slovakia', 48.7, 19.7, 'Slovak', 'Bratislava'],
  ['SVN', '705', 'Slovenia', 46.2, 15.0, 'Slovenian', 'Ljubljana'],
  ['SOM', '706', 'Somalia', 5.2, 46.2, 'Somali', 'Mogadishu', 'al-Shabab'],
  ['ZAF', '710', 'South Africa', -30.6, 22.9, 'South African', 'Johannesburg', 'Pretoria', 'Cape Town'],
  ['SSD', '728', 'South Sudan', 6.9, 31.3, 'South Sudanese', 'Juba'],
  ['ESP', '724', 'Spain', 40.5, -3.7, 'Spanish', 'Madrid', 'Barcelona'],
  ['LKA', '144', 'Sri Lanka', 7.9, 80.8, 'Sri Lankan', 'Colombo'],
  ['SDN', '729', 'Sudan', 12.9, 30.2, 'Sudanese', 'Khartoum', 'Darfur'],
  ['SWE', '752', 'Sweden', 60.1, 18.6, 'Swedish', 'Stockholm'],
  ['CHE', '756', 'Switzerland', 46.8, 8.2, 'Swiss', 'Geneva', 'Zurich', 'Davos'],
  ['SYR', '760', 'Syria', 34.8, 39.0, 'Syrian', 'Damascus', 'Aleppo'],
  ['TWN', '158', 'Taiwan', 23.7, 121.0, 'Taiwanese', 'Taipei'],
  ['TJK', '762', 'Tajikistan', 38.9, 71.3, 'Tajik', 'Dushanbe'],
  ['TZA', '834', 'Tanzania', -6.4, 34.9, 'Tanzanian', 'Dar es Salaam'],
  ['THA', '764', 'Thailand', 15.9, 101.0, 'Thai', 'Bangkok'],
  ['TUN', '788', 'Tunisia', 33.9, 9.5, 'Tunisian', 'Tunis'],
  ['TUR', '792', 'Türkiye', 39.0, 35.2, 'Turkey', 'Turkish', 'Ankara', 'Istanbul', 'Erdogan', 'Erdoğan'],
  ['TKM', '795', 'Turkmenistan', 38.9, 59.6, 'Turkmen', 'Ashgabat'],
  ['UGA', '800', 'Uganda', 1.4, 32.3, 'Ugandan', 'Kampala'],
  ['UKR', '804', 'Ukraine', 48.4, 31.2, 'Ukrainian', 'Kyiv', 'Zelensky', 'Zelenskyy', 'Kharkiv', 'Odesa', 'Donbas', 'Crimea'],
  ['ARE', '784', 'United Arab Emirates', 23.4, 53.8, 'UAE', 'Emirati', 'Dubai', 'Abu Dhabi'],
  ['GBR', '826', 'United Kingdom', 55.4, -3.4, 'UK', 'Britain', 'British', 'England', 'Scotland', 'Scottish', 'Wales', 'Welsh', 'Northern Ireland', 'London', 'Downing Street', 'Westminster'],
  ['USA', '840', 'United States', 39.8, -98.6, 'US', 'U.S.', 'USA', 'America', 'American', 'Americans', 'Washington', 'White House', 'Pentagon', 'Congress', 'Trump', 'New York', 'California', 'Texas', 'Florida'],
  ['URY', '858', 'Uruguay', -32.5, -55.8, 'Uruguayan', 'Montevideo'],
  ['UZB', '860', 'Uzbekistan', 41.4, 64.6, 'Uzbek', 'Tashkent'],
  ['VEN', '862', 'Venezuela', 6.4, -66.6, 'Venezuelan', 'Caracas', 'Maduro'],
  ['VNM', '704', 'Vietnam', 14.1, 108.3, 'Vietnamese', 'Hanoi'],
  ['YEM', '887', 'Yemen', 15.6, 48.5, 'Yemeni', 'Sanaa', "Sana'a", 'Houthi', 'Houthis'],
  ['ZMB', '894', 'Zambia', -13.1, 27.8, 'Zambian', 'Lusaka'],
  ['ZWE', '716', 'Zimbabwe', -19.0, 29.2, 'Zimbabwean', 'Harare'],
];

/** Names that are also common words or personal names; need context to count. */
const AMBIGUOUS = new Set(['Georgia', 'Jordan', 'Chad', 'Turkey', 'Niger', 'Mali', 'Congress', 'Washington', 'Wales', 'Lima', 'Sofia', 'Santiago']);
/** Capitalised words that may legitimately precede a country name. */
const LEAD_INS = new Set(['In', 'From', 'To', 'And', 'With', 'Of', 'At', 'For', 'The', 'But', 'As', 'On', 'Into', 'Near', 'Across', 'After', 'Before', 'While', 'How', 'Why', 'What', 'Is', 'Will', 'Can', 'Did', 'Does', 'Has', 'Inside', 'Over', 'By', 'Against', 'Between', 'North', 'South', 'East', 'West', 'Northern', 'Southern', 'Eastern', 'Western', 'Central']);

export interface Country {
  iso3: string;
  numeric: string;
  name: string;
  lat: number;
  lon: number;
}

interface Matcher {
  country: Country;
  strong: RegExp | null;
  weak: { term: string; re: RegExp }[];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Unicode-aware boundaries so "Türkiye" or "Bogotá" match and "US" does not hit "USB".
const termRe = (terms: string[]) =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${terms.map(escapeRe).join('|')})(?![\\p{L}\\p{N}])`, 'u');

export const COUNTRIES: Country[] = ROWS.map(([iso3, numeric, name, lat, lon]) => ({ iso3, numeric, name, lat, lon }));
export const COUNTRY_BY_ISO = new Map(COUNTRIES.map((c) => [c.iso3, c]));

const MATCHERS: Matcher[] = ROWS.map((row, i) => {
  const [, , name, , , ...aliases] = row;
  const terms = [name, ...aliases];
  const strongTerms = terms.filter((t) => !AMBIGUOUS.has(t)).sort((a, b) => b.length - a.length);
  const weakTerms = terms.filter((t) => AMBIGUOUS.has(t));
  return {
    country: COUNTRIES[i] as Country,
    strong: strongTerms.length ? termRe(strongTerms) : null,
    weak: weakTerms.map((term) => ({
      term,
      re: new RegExp(`(?:([\\p{Lu}][\\p{L}'-]+) )?(?<![\\p{L}\\p{N}])${escapeRe(term)}(?![\\p{L}\\p{N}])(?: ([\\p{Lu}][\\p{L}'-]+))?`, 'gu'),
    })),
  };
});

/** Words that turn an ambiguous term into a clear non-country reference. */
const VETO_AFTER: Record<string, RegExp> = {
  Georgia: /^(Tech|State|Bulldogs|governor|senator|Republican|Democrat)/,
  Washington: /^(Post|Commanders|State|Nationals|Wizards)/,
  Turkey: /^(dinner|sandwich|breast)/,
};

function weakHit(text: string, m: Matcher): boolean {
  for (const { term, re } of m.weak) {
    re.lastIndex = 0;
    let hit: RegExpExecArray | null;
    while ((hit = re.exec(text))) {
      const before = hit[1];
      const after = hit[2];
      // "Michael Jordan", "Jordan Peterson": a neighbouring capitalised word
      // that is not a sentence lead-in means this is probably a person.
      if (before && !LEAD_INS.has(before)) continue;
      if (after && VETO_AFTER[term]?.test(after)) continue;
      if (after && ['Jordan', 'Chad', 'Georgia', 'Sofia', 'Santiago'].includes(term) && !LEAD_INS.has(after)) continue;
      if (term === 'Georgia' && /\b(Atlanta|US state|U\.S\. state|Savannah)\b/.test(text)) continue;
      if (term === 'Turkey' && /\b(Thanksgiving|roast)\b/i.test(text)) continue;
      return true;
    }
  }
  return false;
}

/**
 * Phrases that lexically contain another country's name. They are masked
 * before testing the shorter country so "South Sudan" does not tag Sudan.
 */
const MASKS: Record<string, RegExp> = {
  SDN: /South Sudan(ese)?/g,
  IRL: /Northern Ireland/g,
  NER: /Niger (Delta|State|River)/g,
};

/** ISO3 codes of every country referenced in the text. */
export function detectCountries(text: string): string[] {
  const found: string[] = [];
  for (const m of MATCHERS) {
    const mask = MASKS[m.country.iso3];
    const t = mask ? text.replace(mask, ' ') : text;
    if ((m.strong && m.strong.test(t)) || weakHit(t, m)) found.push(m.country.iso3);
  }
  return found;
}
