/**
 * Zuordnung Launch -> YouTube-Video.
 *
 * Grundregel: im Zweifel kein Link. Ein falscher Link ist schlimmer als ein
 * fehlender, deshalb gilt zugeordnet wird nur, wenn
 *   1. der Missionsname eindeutige Kennungen enthaelt, die im Videotitel
 *      auftauchen, UND
 *   2. das Video zeitlich zum Start passt.
 * Reine Raketennamen ("Starship", "Falcon 9") sind generisch und zaehlen nicht
 * als Kennung - sie stehen in zu vielen Titeln.
 *
 * Beispiele der Regel:
 *   "SatNet LEO Group 26" -> {satnet, 26}  -> "…Group 24" passt NICHT
 *   "Progress MS-35"      -> {progress, 35} -> "MS-32" passt NICHT
 *   "9 satellites"        -> {}             -> gar keine Zuordnung
 *
 * Reine Funktionen ohne Netzwerkzugriff, damit das Verhalten pruefbar bleibt.
 */

/** Kanal, aus dem die Videos stammen. */
export const CHANNEL = {
  id: 'UCjU6ZwoTQtKWfz1urL7XcbA',
  handle: '@SciNewsRo',
  label: 'SciNews',
};

/** Woerter, die eine Mission nicht eindeutig benennen. */
const GENERIC = new Set([
  'launch', 'launches', 'launched', 'group', 'groups', 'mission', 'missions',
  'flight', 'flights', 'satellite', 'satellites', 'sat', 'constellation',
  'deployment', 'deploys', 'deploy', 'leo', 'geo', 'gso', 'meo', 'heo', 'gto',
  'and', 'the', 'of', 'to', 'with', 'for', 'on', 'in', 'a', 'an', 'at', 'no',
  'stage', 'stages', 'booster', 'rocket', 'first', 'second', 'upper', 'lower',
  'static', 'fire', 'test', 'spacecraft', 'payload', 'reentry', 'landing',
  'service', 'module', 'dragon', 'new', 'alpha',
  // Raketennamen: stehen in vielen Titeln, kennzeichnen aber keine Mission.
  'falcon', 'heavy', 'starship', 'super', 'electron', 'vega', 'soyuz',
  'kuaizhou', 'gslv', 'zhuque', 'gravity', 'spectrum', 'pallas', 'kinetica',
  'atlas', 'vulcan', 'ariane', 'glenn', 'h3', 'h2a', 'h2', 'nuri', 'ceres',
  'gmlv', 'sylvara', 'asana', 'ariel', 'lijian', 'jielong', 'smart', 'tauros',
  'long', 'march', 'block', '2a', '5b', '7a', '8a', '6a', '2d', '2c', '4b',
  '1b', 'mk',
]);

/** Ordinalendung abschneiden: "13th" -> "13". */
function stripOrdinal(word) {
  return word.replace(/^(\d+)(st|nd|rd|th)$/, '$1');
}

/** Fuehrende Nullen abschneiden: "04" -> "4", damit 04 und 4 dasselbe sind. */
function stripLeadingZeros(word) {
  if (!/^\d+$/.test(word)) return word;
  const trimmed = word.replace(/^0+(?=\d)/, '');
  return trimmed === '' ? '0' : trimmed;
}

/** Text auf vergleichbare Form bringen. */
export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[''`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => stripLeadingZeros(stripOrdinal(w)))
    .filter(Boolean)
    .join(' ');
}

export function tokens(text) {
  const n = normalize(text);
  return n ? n.split(' ') : [];
}

/**
 * Generisch: Fuellwoerter, Raketennamen, sehr kurze Worte und reine Zahlen.
 * Woerter mit Ziffern ("k1", "3c", "96p") sind nie generisch - sie sind Teil
 * einer Kennung.
 */
export function isGeneric(token) {
  if (!token) return true;
  if (/\d/.test(token)) return false;
  if (GENERIC.has(token)) return true;
  return token.length <= 2;
}

/** Traegt ein Token genug Information, um einen Start zu benennen? */
export function isAnchorToken(token) {
  if (isGeneric(token)) return false;
  return /[a-z]/.test(token) && token.length >= 3;
}

/**
 * Kennungen eines Missionstexts: alle nicht generischen Woerter, Zahlen
 * eingeschlossen - genau die machen "Group 26" von "Group 24" unterscheidbar.
 */
export function requiredTokens(text) {
  const out = [];
  for (const t of tokens(text)) {
    if (isGeneric(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** Missionsanteil des Startnamens: alles nach dem Raketennamen, ohne Klammern. */
export function missionText(launch) {
  const name = String(launch?.name ?? '');
  const parts = name.split('|');
  const tail = parts.length > 1 ? parts.slice(1).join('|') : parts[0];
  return tail.replace(/\([^)]*\)/g, ' ').replace(/\?/g, ' ').trim();
}

/** Klammerzusaetze des Startnamens, z. B. "StriX Launch 13". */
export function noteText(launch) {
  const name = String(launch?.name ?? '');
  return [...name.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]).join(' ');
}

/**
 * Kandidatengruppen fuer einen Start, in der Reihenfolge der Pruefung.
 * Der Missionsname zuerst; Klammerzusaetze dienen nur als Rueckfall und nur,
 * wenn sie eine Nummer enthalten - "Dedicated SSO Rideshare" waere sonst
 * eine zu freie Zuordnung.
 */
export function missionGroups(launch) {
  const groups = [];
  const main = requiredTokens(missionText(launch));
  if (main.some(isAnchorToken)) groups.push({ source: 'mission', tokens: main });
  const note = requiredTokens(noteText(launch));
  if (
    note.some((t) => /\d/.test(t)) &&
    note.some(isAnchorToken) &&
    !note.every((t) => main.includes(t))
  ) {
    groups.push({ source: 'note', tokens: note });
  }
  return groups;
}

/**
 * Altersangabe aus dem Kanalraster. YouTube schreibt gekuerzt:
 * "2d ago", "3w ago", "1mo ago", "2y ago" - daneben auch ausgeschrieben.
 * Rueckgabe in Tagen mit Streuung, weil "1 month ago" ein Zeitraum ist.
 */
const AGE_UNITS = {
  s: [1 / 86400, 0.5],
  sec: [1 / 86400, 0.5],
  second: [1 / 86400, 0.5],
  m: [1 / 1440, 0.5],
  min: [1 / 1440, 0.5],
  minute: [1 / 1440, 0.5],
  h: [1 / 24, 0.5],
  hour: [1 / 24, 0.5],
  d: [1, 2],
  day: [1, 2],
  w: [7, 6],
  wk: [7, 6],
  week: [7, 6],
  mo: [30, 16],
  mon: [30, 16],
  month: [30, 16],
  y: [365, 200],
  yr: [365, 200],
  year: [365, 200],
};

export function parseAgeHint(text) {
  const m = String(text ?? '')
    .toLowerCase()
    .match(/(\d+)\s*([a-z]+)\.?\s*ago/);
  if (!m) return null;
  const unit = AGE_UNITS[m[2].replace(/s$/, '')] ?? AGE_UNITS[m[2]];
  if (!unit) return null;
  return { days: Number(m[1]) * unit[0], spread: unit[1] };
}

const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6,
  august: 7, september: 8, october: 9, november: 10, december: 11,
  januar: 0, februar: 1, maerz: 2, mrz: 2, juni: 5, juli: 6, oktober: 9,
};

/** "28 September 2026" oder "September 28, 2026" aus einem Titel ziehen. */
export function titleDate(text) {
  const s = String(text ?? '');
  const dmy = s.match(/\b(\d{1,2})\s+([A-Za-z]{3,10})\.?\s+(\d{4})\b/);
  if (dmy) {
    const month = MONTHS[dmy[2].toLowerCase()];
    if (month !== undefined) return Date.UTC(+dmy[3], month, +dmy[1]);
  }
  const mdy = s.match(/\b([A-Za-z]{3,10})\.?\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (mdy) {
    const month = MONTHS[mdy[1].toLowerCase()];
    if (month !== undefined) return Date.UTC(+mdy[3], month, +mdy[2]);
  }
  return null;
}

/** Videos erscheinen hoechstens wenige Tage nach dem Start. */
const PUBLISH_SLACK_DAYS = 5;

/**
 * Altersbereich eines Videos in Tagen (vor now).
 * Beispiel: "2 weeks ago" -> [8, 27]; ein Start, der 11 Tage her ist, passt.
 */
export function videoAgeRange(video, now = Date.now()) {
  // Das exakte Datum des Feeds schlaegt jede Altersangabe. Der Titel kann ein
  // Datum nennen ("28 September 2026"), sonst liefert der Feed published_at.
  const fromTitle = titleDate(video.title);
  const fromFeed = video.published_at ? Date.parse(video.published_at) : NaN;
  const exact = fromTitle ?? (Number.isFinite(fromFeed) ? fromFeed : null);
  if (exact !== null) {
    const days = (now - exact) / 86400000;
    return { lo: days - 3, hi: days + 3 + PUBLISH_SLACK_DAYS, exact: true };
  }
  // Sonst die Altersangabe aus dem Kanalraster ("2d ago", "2 weeks ago").
  const hint = parseAgeHint(video.published_hint ?? video.publishedHint ?? video.when);
  if (!hint) return null;
  return {
    lo: hint.days - hint.spread,
    hi: hint.days + hint.spread + PUBLISH_SLACK_DAYS,
    exact: false,
  };
}

/** Liegt das Alter eines Starts im Altersbereich des Videos? */
export function ageCompatible(video, launchAgeDays, now = Date.now()) {
  const range = videoAgeRange(video, now);
  if (!range) return false;
  return launchAgeDays >= range.lo && launchAgeDays <= range.hi;
}

/**
 * Kommen alle geforderten Kennungen in einem nahen Fenster des Titels vor?
 * Das Fenster laesst zwei Fuellwoerter zu ("launches", "and") und eine
 * Vertauschung, wie sie der Kanal in Titeln schreibt ("13th StriX").
 */
export function titleMatches(required, titleToks) {
  if (required.length === 0) return false;
  const span = required.length + 2;
  for (const anchor of required) {
    const start = titleToks.indexOf(anchor);
    if (start === -1) continue;
    const window = titleToks.slice(Math.max(0, start - 1), start + span);
    if (required.every((t) => window.includes(t))) return true;
  }
  return false;
}

/**
 * Woertliche Phasen: zusammenhaengende Folgen von mindestens drei kennenden
 * Woertern im Missionsnamen. Nur fuer Namen ohne Nummern gedacht - bei
 * "Yaogan 40 Group 04" waere die Phase "Yaogan 40" zu unscharf, weil sie die
 * 04 unterschlaegt. Ohne Nummern gibt es nichts zu unterscheiden, und dann
 * traegt die Wortfolge: "Nancy Grace Roman Space Telescope" findet den Titel
 * "Roman Space Telescope launch".
 */
const MIN_PHRASE = 3;

export function missionPhrases(launch) {
  const main = missionText(launch);
  if (/\d/.test(main)) return []; // nummernbestimmte Mission: nur Kennungen
  const runs = [];
  let run = [];
  for (const t of tokens(main)) {
    if (isGeneric(t)) {
      if (run.length >= MIN_PHRASE) runs.push(run);
      run = [];
      continue;
    }
    run.push(t);
  }
  if (run.length >= MIN_PHRASE) runs.push(run);
  return runs;
}

function indexOfSlice(haystack, needle) {
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((t, k) => haystack[i + k] === t)) return i;
  }
  return -1;
}

/** Enthaelt der Titel eine Phase der Laenge 3 oder mehr woertlich und lueckenlos? */
export function phraseMatches(phrases, titleToks) {
  for (const run of phrases) {
    for (let len = run.length; len >= MIN_PHRASE; len--) {
      for (let i = 0; i + len <= run.length; i++) {
        const slice = run.slice(i, i + len);
        if (indexOfSlice(titleToks, slice) !== -1) return { phrase: slice.join(' '), length: len };
      }
    }
  }
  return null;
}

/** "launch" im Titel hebt das eigentliche Startvideo hervor. */
const LAUNCH_WORDS = new Set(['launch', 'launches', 'launched', 'liftoff']);

/** Titel, die nicht den Start selbst zeigen, sondern ein Problem. */
const NEGATIVE_WORDS = new Set([
  'abort', 'aborted', 'abortive', 'scrub', 'scrubbed', 'delay', 'delayed',
  'static', 'anomaly', 'explosion', 'explode', 'failure', 'failed', 'problem',
  'issue', 'problematic', 'hold', 'on', 'pad', 'countdown', 'preview',
  'history', ' retrospective', 'revisit', 'anniversary', 'how', 'why', 'what',
]);

function launchBonus(titleToks) {
  return titleToks.some((t) => LAUNCH_WORDS.has(t)) ? 5 : 0;
}

function hasNegativeWord(titleToks) {
  return titleToks.some((t) => NEGATIVE_WORDS.has(t));
}

/**
 * Raketensignatur aus dem Raketennamen, ohne Bloecke und Versionen:
 * "Falcon 9 Block 5" -> "falcon 9", "Starship V3" -> "starship".
 */
export function rocketSignature(launch) {
  const name = String(launch?.rocket?.name ?? '').trim();
  if (!name) return null;
  const list = tokens(name);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    if (ROCKET_NOISE.has(list[i])) {
      if (list[i] === 'block') i += 1; // "Block 5" ist die Blockversion
      continue;
    }
    if (/^v\d$/.test(list[i])) continue;
    out.push(list[i]);
  }
  return out.length > 0 ? out : null;
}

/** Bloecke, Ausfuehrungsstufen und roemische Zahlen sind keine Rakete. */
const ROCKET_NOISE = new Set(['block', 'mk', 'ii', 'iii', 'iv', 'v', 'va', 'vb']);

function signaturePresent(signature, titleToks) {
  for (let i = 0; i + signature.length <= titleToks.length; i++) {
    if (signature.every((t, k) => titleToks[i + k] === t)) return true;
  }
  return false;
}

/**
 * Stufe 3: nur Raketenname und "launch" im Titel.
 *
 * Zwei Bedingungen machen das eindeutig: Es gab im Zeitfenster nur EINEN Start
 * dieser Rakete, und es gibt nur EIN Video dieser Rakete mit "launch" im Titel.
 * Fuellt sich das Fenster mit Falcon-9-Starts, greift die Regel nicht - dann
 * waere sie eine Vermutung. Genau die Starts, bei denen sie greift, sind
 * Einzelgänger wie Pallas-1, Spectrum oder Starship.
 *
 * @param {object[]} siblings andere Starts derselben Rakete im Fenster
 */
export function familyMatch(launch, videos, siblings, options = {}) {
  const now = options.now ?? Date.now();
  const netMs = Date.parse(launch?.net ?? '');
  if (!Number.isFinite(netMs)) return [];
  const signature = rocketSignature(launch);
  if (!signature) return [];
  if ((siblings ?? []).length > 0) return [];

  const launchAgeDays = (now - netMs) / 86400000;
  const candidates = [];
  for (const video of videos) {
    if (!ageCompatible(video, launchAgeDays, now)) continue;
    const titleToks = tokens(video.title);
    if (!launchBonus(titleToks)) continue;
    if (hasNegativeWord(titleToks)) continue;
    if (!signaturePresent(signature, titleToks)) continue;
    candidates.push(video);
  }
  if (candidates.length !== 1) return [];

  const video = candidates[0];
  const range = videoAgeRange(video, now);
  const mid = range ? (range.lo + range.hi) / 2 : launchAgeDays;
  return [
    {
      videoId: video.id,
      title: video.title,
      url: `https://www.youtube.com/watch?v=${video.id}`,
      score: 20 - Math.abs(launchAgeDays - mid),
      anchor: signature.join(' '),
      tier: 3,
    },
  ];
}

/**
 * Videos zu einem Start finden, bestes zuerst.
 *
 * Zwei Stufen, die strengere zuerst: alle Kennungen des Missionsnamens muessen
 * im Titel stehen (Stufe 1). Nur wenn das nirgends gelingt, darf eine woertliche
 * Phrase genuegen (Stufe 2, nur bei Namen ohne Nummern).
 *
 * @returns {{videoId:string,title:string,url:string,score:number,anchor:string,tier:number}[]}
 */
export function matchLaunch(launch, videos, options = {}) {
  const now = options.now ?? Date.now();
  const netMs = Date.parse(launch?.net ?? '');
  if (!Number.isFinite(netMs)) return [];
  const launchAgeDays = (now - netMs) / 86400000;
  const groups = missionGroups(launch);
  if (groups.length === 0) return [];

  const hits = [];
  const seen = new Set();
  const consider = (video, tier, anchor, weight) => {
    if (seen.has(video.id)) return;
    const range = videoAgeRange(video, now);
    if (!range) return;
    const mid = (range.lo + range.hi) / 2;
    seen.add(video.id);
    hits.push({
      videoId: video.id,
      title: video.title,
      url: `https://www.youtube.com/watch?v=${video.id}`,
      score: weight + launchBonus(tokens(video.title)) - Math.abs(launchAgeDays - mid),
      anchor,
      tier,
    });
  };

  for (const video of videos) {
    if (!ageCompatible(video, launchAgeDays, now)) continue;
    const titleToks = tokens(video.title);
    const group = groups.find((g) => titleMatches(g.tokens, titleToks));
    if (group) consider(video, 1, group.tokens.join(' '), 100 + group.tokens.length * 2);
  }

  if (hits.length === 0) {
    const phrases = missionPhrases(launch);
    if (phrases.length > 0) {
      for (const video of videos) {
        if (!ageCompatible(video, launchAgeDays, now)) continue;
        const found = phraseMatches(phrases, tokens(video.title));
        if (found) consider(video, 2, found.phrase, 50 + found.length * 2);
      }
    }
  }

  const candidates = videos.filter((v) => !seen.has(v.id));
  if (hits.length === 0 && candidates.length > 0) {
    for (const hit of familyMatch(launch, candidates, options.siblings, { now })) {
      seen.add(hit.videoId);
      hits.push(hit);
    }
  }

  hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return hits;
}

/** Zeitfenster, in dem zwei Starts derselben Rakete nicht mehr eindeutig sind. */
export const SIBLING_WINDOW_DAYS = 10;

/**
 * Andere Starts derselben Rakete im Fensters des Starts. Fuellt sich das
 * Fenster, waere eine Zuordnung ueber den Raketennamen nur eine Vermutung.
 */
export function siblingsOf(launch, launches, now = Date.now()) {
  const signature = rocketSignature(launch);
  if (!signature) return [];
  const netMs = Date.parse(launch?.net ?? '');
  if (!Number.isFinite(netMs)) return [];
  const age = (now - netMs) / 86400000;
  const out = [];
  for (const other of launches) {
    if (!other || other.id === launch.id) continue;
    const otherMs = Date.parse(other.net ?? '');
    if (!Number.isFinite(otherMs)) continue;
    if (Math.abs((now - otherMs) / 86400000 - age) > SIBLING_WINDOW_DAYS) continue;
    const otherSignature = rocketSignature(other);
    if (!otherSignature) continue;
    if (otherSignature.join(' ') !== signature.join(' ')) continue;
    out.push(other);
  }
  return out;
}

/**
 * Zuordnung fuer eine ganze Startliste aufbauen.
 * @returns {{links: Record<string, object[]>, stats: object}}
 */
export function buildVideoLinks(launches, videos, options = {}) {
  const links = {};
  const byTier = { 1: 0, 2: 0, 3: 0 };
  let matchable = 0;
  let linkedVideos = 0;
  const now = options.now ?? Date.now();
  for (const launch of launches) {
    if (!launch?.id) continue;
    if (missionGroups(launch).length > 0 || missionPhrases(launch).length > 0) matchable++;
    const hits = matchLaunch(launch, videos, {
      now,
      siblings: siblingsOf(launch, launches, now),
    });
    if (hits.length === 0) continue;
    links[launch.id] = hits;
    linkedVideos += hits.length;
    for (const hit of hits) byTier[hit.tier] = (byTier[hit.tier] ?? 0) + 1;
  }
  return {
    links,
    stats: {
      launches: launches.length,
      videos: videos.length,
      matchable,
      linked: Object.keys(links).length,
      linkedVideos,
      byTier,
    },
  };
}
