/**
 * Holt echte Startdaten von der oeffentlichen Launch-Library-2-API und schreibt
 * sie normalisiert nach src/data/launches.json.
 *
 * Grundregel: es wird NICHTS erfunden. Jedes Feld kommt entweder direkt aus der
 * Quelle oder bleibt null - die UI zeigt dann "nicht erfasst".
 *
 * Zu den Booster-Daten (Abweichung von der urspruenglichen Vorgabe):
 * Die Vorgabe ging davon aus, dass die Quelle keine Booster-IDs liefert, und
 * verlangte deshalb ein hartes false/null. Das galt fuer den damals vorliegenden
 * Datensatz. `mode=detailed` liefert jedoch `rocket.launcher_stage[]` mit
 * `reused`, `launcher.serial_number`, `launcher_flight_number` und `landing`.
 * Ein hartes false waere an dieser Stelle eine Falschaussage, deshalb werden die
 * echten Werte uebernommen. Fehlt der Eintrag (29 von 43 Starts, u.a. Electron,
 * Long March, Ariane), bleibt es bei "nicht erfasst".
 *
 * Achtung Falle: `landing.success` ist bei ZUKUENFTIGEN Starts immer false -
 * die Landung hat einfach noch nicht stattgefunden. Die UI darf das erst nach
 * dem Start als Fehlschlag darstellen; der Decoder liefert deshalb
 * direction und landing getrennt aus.
 *
 * Aufruf:  node scripts/fetch-launches.mjs
 *          node scripts/fetch-launches.mjs --from-file /tmp/lt/raw_p1.json
 *          node scripts/fetch-launches.mjs --out /pfad/launches.json
 *
 * --out schreibt an einen anderen Ort als src/data/launches.json. Davon
 * Gebrauch macht scripts/refresh-data.mjs, das die Live-Daten ausserhalb des
 * ausgelieferten www-Verzeichnisses ablegt.
 */
import { writeFile, readFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeWindow } from './lib/window.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const OUT_DEFAULT = resolve(ROOT, 'data', 'launches.json')

/** Ausgabeort: --out <pfad> schlaegt den Standardpfad. */
function resolveOut() {
  const index = process.argv.indexOf('--out')
  const value = index >= 0 ? process.argv[index + 1] : null
  return value && !value.startsWith('--') ? resolve(value) : OUT_DEFAULT
}

/** Ganzzahliger Schalter, sonst null. */
function intArg(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return null
  const value = Number.parseInt(process.argv[index + 1] ?? '', 10)
  return Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * Das Archivfenster laeuft mit der Zeit mit: 30 Tage zurueck, 14 Tage voraus
 * (siehe scripts/lib/window.mjs). Ueberschreiben mit --past-days / --future-days.
 */
const WINDOW = computeWindow(Date.now(), {
  pastDays: intArg('--past-days') ?? undefined,
  futureDays: intArg('--future-days') ?? undefined,
})
const API =
  'https://ll.thespacedevs.com/2.3.0/launches/' +
  `?net__gte=${encodeURIComponent(WINDOW.past_from)}` +
  `&net__lte=${encodeURIComponent(WINDOW.future_to)}` +
  '&limit=100&mode=detailed'

const MAX_WEBCASTS = 3
const MAX_INFO_URLS = 4

/* ------------------------------------------------------------------ Helfer */

/** Nur https:-URLs ueberleben (Sicherheits-Gate M1-M10). */
function httpsOnly(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  shy: '',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  deg: '°',
  times: '×',
}

/**
 * Fremdtext aus der Quelle aufraeumen: Markup entfernen, Entities aufloesen,
 * Leerraum normalisieren. Die UI rendert den Text ausschliesslich als
 * Textknoten - hier wird nur Muell entfernt, nie Inhalt erfunden.
 */
function cleanText(value) {
  if (typeof value !== 'string') return null
  let s = value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, name) => {
    const key = String(name).toLowerCase()
    if (key.startsWith('#x')) {
      const code = Number.parseInt(key.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (key.startsWith('#')) {
      const code = Number.parseInt(key.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : match
  })
  s = s.replace(/<[^>]*>/g, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > 0 ? s : null
}

/** ISO-8601-Dauer ("-PT53M", "P0D", "P104DT17H24M30S") -> Sekunden. */
const DURATION_RE = /^(-)?P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/

function durationSeconds(value) {
  if (typeof value !== 'string') return null
  const m = DURATION_RE.exec(value.trim())
  if (!m) return null
  const sign = m[1] === '-' ? -1 : 1
  const [, , d, h, min, s] = m
  const total =
    (Number(d ?? 0) * 86400) + (Number(h ?? 0) * 3600) + (Number(min ?? 0) * 60) + Number(s ?? 0)
  return Number.isFinite(total) ? Math.round(sign * total) : null
}

function num(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function str(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function boolOrNull(value) {
  return typeof value === 'boolean' ? value : null
}

/** Sortiert nach priority (aufsteigend = wichtiger) und begrenzt. */
function byPriority(list, limit) {
  if (!Array.isArray(list)) return []
  return [...list]
    .sort((a, b) => (num(a?.priority) ?? 99) - (num(b?.priority) ?? 99))
    .slice(0, limit)
}

/* ------------------------------------------------------------- Statusabbild */

const STATUS_MAP = {
  Success: 'Launch Success',
  'Launch Successful': 'Launch Success',
  Failure: 'Launch Failure',
  'Launch Failure': 'Launch Failure',
  'Partial Failure': 'Partial Failure',
  Go: 'Go',
  TBD: 'TBD',
  TBC: 'TBC',
  Hold: 'Hold',
  'In Flight': 'In Flight',
}

const PAST_STATUSES = new Set(['Launch Success', 'Launch Failure', 'Partial Failure'])
/** Genauigkeiten, die einen Termin nur grob festlegen. */
const ESTIMATED_PRECISION = new Set(['Day', 'Month', 'Year', 'Quarter'])

/* ------------------------------------------------------------------ Abbild */

function mapStage(stage) {
  if (!stage || typeof stage !== 'object') return null
  const launcher = stage.launcher && typeof stage.launcher === 'object' ? stage.launcher : {}
  const landing = stage.landing && typeof stage.landing === 'object' ? stage.landing : null
  const landingLocation =
    landing && landing.landing_location && typeof landing.landing_location === 'object'
      ? landing.landing_location
      : null

  const mapped = {
    type: str(stage.type),
    reused: boolOrNull(stage.reused),
    flightNumber: num(stage.launcher_flight_number),
    serial: str(launcher.serial_number),
    // Gesamtfluege dieses Exemplars laut Quelle (nicht hochgerechnet).
    flights: num(launcher.flights),
    successfulLandings: num(launcher.successful_landings),
    attemptedLandings: num(launcher.attempted_landings),
    firstLaunch: str(launcher.first_launch_date),
    lastLaunch: str(launcher.last_launch_date),
    previousFlight: str(stage.previous_flight_date),
    turnaround: str(stage.turn_around_time) ?? str(launcher.fastest_turnaround),
    landing: landing
      ? {
          attempt: boolOrNull(landing.attempt),
          success: boolOrNull(landing.success),
          description: cleanText(landing.description),
          downrangeKm: num(landing.downrange_distance),
          location: landingLocation
            ? {
                name: str(landingLocation.name),
                abbrev: str(landingLocation.abbrev),
                site: landingLocation.location ? str(landingLocation.location.name) : null,
              }
            : null,
        }
      : null,
  }

  // Ein Eintrag ohne jede verwertbare Angabe ist wertlos -> verwerfen.
  const useful =
    mapped.type ||
    mapped.reused !== null ||
    mapped.flightNumber !== null ||
    mapped.serial ||
    mapped.landing
  return useful ? mapped : null
}

function mapInfoUrls(item) {
  const merged = [
    ...(Array.isArray(item?.info_urls) ? item.info_urls : []),
    ...(Array.isArray(item?.mission?.info_urls) ? item.mission.info_urls : []),
  ]
  const seen = new Set()
  const out = []
  for (const entry of byPriority(merged, 12)) {
    const url = httpsOnly(entry?.url)
    if (!url || seen.has(url)) continue
    seen.add(url)
    out.push({
      url,
      title: cleanText(entry?.title),
      type: str(entry?.type?.name),
      source: str(entry?.source),
    })
    if (out.length >= MAX_INFO_URLS) break
  }
  return out
}

function mapWebcasts(item) {
  const merged = [
    ...(Array.isArray(item?.vid_urls) ? item.vid_urls : []),
    ...(Array.isArray(item?.mission?.vid_urls) ? item.mission.vid_urls : []),
  ]
  const seen = new Set()
  const out = []
  for (const entry of byPriority(merged, 12)) {
    const url = httpsOnly(entry?.url)
    if (!url || seen.has(url)) continue
    seen.add(url)
    out.push({
      url,
      title: cleanText(entry?.title),
      publisher: str(entry?.publisher),
      source: str(entry?.source),
      type: str(entry?.type?.name),
      language: str(entry?.language?.code),
      startTime: str(entry?.start_time),
      live: entry?.live === true,
    })
    if (out.length >= MAX_WEBCASTS) break
  }
  return out
}

function mapTimeline(item) {
  const raw = Array.isArray(item?.timeline) ? item.timeline : []
  const out = []
  for (const entry of raw) {
    const offsetS = durationSeconds(entry?.relative_time)
    if (offsetS === null) continue
    const abbrev = cleanText(entry?.type?.abbrev)
    if (!abbrev) continue
    out.push({
      abbrev,
      description: cleanText(entry?.type?.description),
      offset_s: offsetS,
    })
  }
  // chronologisch: T-53M ... T-0 ... T+31M
  out.sort((a, b) => a.offset_s - b.offset_s)
  return out
}

function mapPatches(item) {
  const raw = Array.isArray(item?.mission_patches) ? item.mission_patches : []
  const out = []
  for (const entry of byPriority(raw, 4)) {
    const url = httpsOnly(entry?.image_url)
    if (!url) continue
    out.push({
      name: cleanText(entry?.name),
      url,
      agency: str(entry?.agency?.name),
    })
  }
  return out
}

function mapPrograms(item) {
  const raw = Array.isArray(item?.program) ? item.program : []
  const out = []
  for (const entry of raw) {
    const name = cleanText(entry?.name)
    if (!name) continue
    out.push({ name, image: httpsOnly(entry?.image?.image_url) })
  }
  return out
}

function transform(raw) {
  const launches = []

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue

    const statusAbbrev = str(item?.status?.abbrev) ?? 'TBD'
    const status = STATUS_MAP[statusAbbrev] ?? statusAbbrev
    const precision = str(item?.net_precision?.name)
    const pad = item?.pad && typeof item.pad === 'object' ? item.pad : {}
    const location = pad.location && typeof pad.location === 'object' ? pad.location : {}
    const mission = item?.mission && typeof item.mission === 'object' ? item.mission : null
    const rocket = item?.rocket && typeof item.rocket === 'object' ? item.rocket : {}
    const configuration =
      rocket.configuration && typeof rocket.configuration === 'object' ? rocket.configuration : {}
    const providerRaw =
      item?.launch_service_provider && typeof item.launch_service_provider === 'object'
        ? item.launch_service_provider
        : {}
    const provider =
      str(providerRaw.name) ??
      str(configuration.launch_service_provider?.name) ??
      'Unbekannt'

    const family = Array.isArray(configuration.families)
      ? str(configuration.families[0]?.name)
      : null

    const stages = (Array.isArray(rocket.launcher_stage) ? rocket.launcher_stage : [])
      .map(mapStage)
      .filter((s) => s !== null)

    // Abgeleitet, aber ausschliesslich aus echten Werten (nie erfunden):
    const anyReused = stages.some((s) => s.reused === true)
    const flightNumbers = stages.map((s) => s.flightNumber).filter((n) => typeof n === 'number')

    const infoUrls = mapInfoUrls(item)
    const webcasts = mapWebcasts(item)
    const patches = mapPatches(item)

    const windowStart = str(item.window_start)
    const windowEnd = str(item.window_end)
    const windowDuration =
      windowStart && windowEnd ? Math.round((Date.parse(windowEnd) - Date.parse(windowStart)) / 1000) : null

    launches.push({
      id: String(item.id),
      slug: str(item.slug),
      name: cleanText(item.name) ?? 'Unbenannter Start',

      status,
      status_raw: statusAbbrev,
      status_name: cleanText(item?.status?.name),
      status_description: cleanText(item?.status?.description),

      net: item.net,
      net_precision: precision,
      date_is_estimated: precision ? ESTIMATED_PRECISION.has(precision) : false,
      direction: PAST_STATUSES.has(status) ? 'past' : 'future',
      last_updated: str(item.last_updated),
      launch_designator: str(item.launch_designator),
      hashtag: str(item.hashtag),
      webcast_live: item.webcast_live === true,
      probability: num(item.probability),
      weather_concerns: cleanText(item.weather_concerns),
      failreason: cleanText(item.failreason),

      window: windowStart
        ? {
            start: windowStart,
            end: windowEnd,
            duration_s: Number.isFinite(windowDuration) ? windowDuration : null,
          }
        : null,

      rocket: {
        name: cleanText(configuration.full_name) ?? cleanText(configuration.name) ?? 'Unbekannt',
        provider,
        provider_abbrev: str(providerRaw.abbrev),
        provider_type: str(providerRaw.type?.name),
        provider_country: Array.isArray(providerRaw.country)
          ? str(providerRaw.country[0]?.name)
          : str(providerRaw.country?.name),
        provider_logo: httpsOnly(providerRaw.logo?.image_url),
        family,
        stages,
      },

      launch_site: {
        name: cleanText(pad.name) ?? cleanText(location.name) ?? 'Unbekannt',
        lat: num(pad.latitude),
        lon: num(pad.longitude),
        country: cleanText(pad.country?.name) ?? cleanText(location.country?.name),
        country_code: str(pad.country?.alpha_2_code) ?? str(location.country?.alpha_2_code),
        location: cleanText(location.name),
        // IANA-Zeitzone des Startplatzes -> echte Ortszeit statt Browser-Rate.
        timezone: str(location.timezone_name),
        pad_total_launches: num(pad.total_launch_count),
        pad_orbital_launches: num(pad.orbital_launch_attempt_count),
        fastest_turnaround: str(pad.fastest_turnaround),
        image: httpsOnly(pad.image?.image_url),
        map_url: httpsOnly(pad.map_url),
        wiki_url: httpsOnly(pad.wiki_url),
      },

      mission: mission
        ? {
            name: cleanText(mission.name),
            type: str(mission.type),
            orbit: cleanText(mission.orbit?.name),
            orbit_abbrev: str(mission.orbit?.abbrev),
          }
        : null,

      payload: cleanText(mission?.name),
      description: cleanText(mission?.description),
      description_lang: mission?.description ? 'en' : null,

      // Abwaertskompatibel: jetzt aus echten Stage-Daten abgeleitet.
      is_reused_booster: anyReused,
      booster_flight_count: flightNumbers.length > 0 ? Math.max(...flightNumbers) : null,

      info_url: infoUrls[0]?.url ?? null,
      info_urls: infoUrls,
      webcasts,
      patch: patches[0] ?? null,
      patches,
      programs: mapPrograms(item),
      timeline: mapTimeline(item),
      image: httpsOnly(item.image?.image_url) ?? httpsOnly(mission?.image?.image_url),
      infographic: httpsOnly(item.infographic?.image_url),
      flightclub_url: httpsOnly(item.flightclub_url),

      counts: {
        orbital: num(item.orbital_launch_attempt_count),
        location: num(item.location_launch_attempt_count),
        pad: num(item.pad_launch_attempt_count),
        agency: num(item.agency_launch_attempt_count),
        orbital_year: num(item.orbital_launch_attempt_count_year),
        location_year: num(item.location_launch_attempt_count_year),
        pad_year: num(item.pad_launch_attempt_count_year),
        agency_year: num(item.agency_launch_attempt_count_year),
      },
    })
  }

  return launches
}

/* -------------------------------------------------------------------- Main */

async function main() {
  const OUT = resolveOut()
  const fromFile = process.argv.includes('--from-file')
    ? process.argv[process.argv.indexOf('--from-file') + 1]
    : null

  let payload
  if (fromFile) {
    payload = JSON.parse(await readFile(fromFile, 'utf8'))
  } else {
    // Fetch mit Timeout (8s) und Retry (2x, exponentieller Backoff 1s/2s)
    const MAX_RETRIES = 2
    const TIMEOUT_MS = 8000
    let lastError
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
        const res = await fetch(API, {
          headers: { 'User-Agent': 'launch-tracker-build-script' },
          signal: controller.signal
        })
        clearTimeout(timeout)
        if (!res.ok) throw new Error(`API antwortete mit ${res.status}`)
        payload = await res.json()
        break
      } catch (err) {
        lastError = err
        if (attempt < MAX_RETRIES) {
          const wait = 1000 * Math.pow(2, attempt)  // 1s, 2s
          console.warn(`[fetch-launches] API-Fehler (Versuch ${attempt + 1}/${MAX_RETRIES + 1}): ${err.message}. Warte ${wait}ms...`)
          await new Promise(r => setTimeout(r, wait))
        }
      }
    }
    if (!payload) throw lastError
  }

  const results = Array.isArray(payload?.results) ? payload.results : []
  // Pagination-Guard: API liefert limit=100, bei genau 100 Ergebnissen koennten
  // weitere Seiten existieren. Wir brechen hier bewusst ab (fail-closed) statt
  // einen unvollstaendigen Datensatz zu akzeptieren. --force ueberspringt den Guard.
  const FORCE_PAGINATION = process.argv.includes('--force-pagination')
  if (!FORCE_PAGINATION && results.length >= 100) {
    throw new Error(`API liefert ${results.length} Ergebnisse (limit=100). Moeglicherweise unvollstaendig (weitere Seiten). Nutze --force-pagination um trotzdem fortzufahren.`)
  }
  const launches = transform(results).sort((a, b) => a.net.localeCompare(b.net))

  const withStages = launches.filter((l) => l.rocket.stages.length > 0).length
  const reused = launches.filter((l) => l.rocket.stages.some((s) => s.reused === true)).length

  const out = {
    meta: {
      generated_at: new Date().toISOString(),
      source: 'Launch Library 2 - ll.thespacedevs.com/2.3.0/launches (The Space Devs)',
      window: {
        past_from: WINDOW.past_from,
        future_to: WINDOW.future_to,
        past_days: WINDOW.past_days,
        future_days: WINDOW.future_days,
      },
      count: launches.length,
      notes: [
        'Booster-Daten stammen aus rocket.launcher_stage[]. Fehlt der Eintrag, zeigt die UI "nicht erfasst".',
        'landing.success ist bei zukuenftigen Starts immer false (Landung steht noch aus) - die UI wertet das erst nach dem Start.',
        'description ist der englische Originaltext der Quelle, von Markup und Entities bereinigt.',
        'Alle URLs (info_url, image, webcasts, patch, ...) wurden auf das Schema https: gefiltert.',
        'direction folgt dem Status: Launch Success / Launch Failure / Partial Failure = vergangen, sonst zukuenftig.',
      ],
    },
    launches,
  }

  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, JSON.stringify(out, null, 1) + '\n', 'utf8')

  const past = launches.filter((l) => l.direction === 'past').length
  const bytes = (await readFile(OUT)).length
  console.log(`launches.json: ${launches.length} Starts (${past} vergangen, ${launches.length - past} zukuenftig)`)
  console.log(`geschätzt (date_is_estimated): ${launches.filter((l) => l.date_is_estimated).length}`)
  console.log(`ohne Koordinaten: ${launches.filter((l) => l.launch_site.lat === null || l.launch_site.lon === null).length}`)
  console.log(`mit Booster-Angaben: ${withStages} (davon wiederverwendet: ${reused})`)
  console.log(`mit Zeitplan (timeline): ${launches.filter((l) => l.timeline.length > 0).length}`)
  console.log(`mit Webcast: ${launches.filter((l) => l.webcasts.length > 0).length}`)
  console.log(`mit Missionspatch: ${launches.filter((l) => l.patch).length}`)
  console.log(`Dateigroesse: ${(bytes / 1024).toFixed(1)} KB`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
