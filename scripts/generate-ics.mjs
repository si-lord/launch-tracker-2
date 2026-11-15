#!/usr/bin/env node
/**
 * Erzeugt den iCalendar-Feed (RFC 5545) aus den Live-Startdaten.
 *
 * Warum ein eigener Generator: der bisherige www/feed.ics war ein statisches
 * File vom 04.10.2026 mit 5 bereits vergangenen Terminen. Die App verspricht
 * im Kalender-Dialog aber "nur Starts, deren Termin noch aussteht" - das
 * war schlicht falsch. Der Feed wird jetzt bei jedem Datenabgleich neu
 * erzeugt und kommt aus dem Datenverzeichnis, nicht aus dem ausgelieferten
 * www-Baum.
 *
 * Aufruf:  node scripts/generate-ics.mjs [--out data/feed.ics]
 * Exit:    0 = Feed geschrieben, 1 = Fehler
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return null
  const value = process.argv[index + 1]
  return value && !value.startsWith('--') ? value : null
}

const DATA_DIR = resolve(argValue('--data-dir') ?? join(ROOT, 'data'))
const LAUNCH_FILE = join(DATA_DIR, 'launches.json')
const OUT = resolve(argValue('--out') ?? join(DATA_DIR, 'feed.ics'))

/** Standarddauer eines Startfensters, wenn die Quelle keine angibt. */
const DEFAULT_WINDOW_S = 3600

/** iCalendar-Textescaping: \, ; \n \r muessen escaped werden. */
function escapeText(value) {
  if (value === null || value === undefined) return ''
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

/**
 * Zeilenumbruch nach 75 Oktetten (RFC 5545, Abschnitt 3.1).
 * Wird auf Oktett-Ebene gemacht, nicht auf Zeichenebene - sonst
 * zerbricht ein Mehrbytezeichen.
 */
function foldLine(line) {
  const bytes = Buffer.from(line, 'utf8')
  if (bytes.length <= 75) return line
  const parts = []
  let start = 0
  let limit = 75
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length)
    // Nicht in die Mitte eines Mehrbytezeichens schneiden
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
      end -= 1
    }
    parts.push(bytes.slice(start, end).toString('utf8'))
    start = end
    limit = 74 // Folgezeilen beginnen mit einem Leerzeichen
  }
  return parts.join('\r\n ')
}

/** ISO-8601 in UTC-iCalendar-Format (YYYYMMDDTHHMMSSZ). */
function icsTime(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

/** Lokale Zone der Quelle, falls belegt - fuer die DTSTART;-TZID= Angabe. */
function zoneId(timezone) {
  if (typeof timezone !== 'string' || timezone.trim() === '') return null
  const trimmed = timezone.trim()
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(trimmed)) return null
  return trimmed
}

/**
 * Baut den Kalendertext.
 * @param {object} dataset - der geparste Inhalt von data/launches.json
 * @param {number} now - Zeitstempel "jetzt" (ms)
 */
export function buildIcs(dataset, now = Date.now()) {
  const launches = Array.isArray(dataset?.launches) ? dataset.launches : []
  const meta = dataset?.meta ?? {}
  const window = meta.window ?? {}

  // Nur Starts, deren Termin noch aussteht. Vergangene Termine gehoeren
  // nicht in ein Abo - das war der Fehler im statischen Feed.
  const upcoming = launches
    .filter((l) => l?.direction === 'future')
    .filter((l) => {
      const net = Date.parse(l.net ?? '')
      return Number.isFinite(net) && net >= now - 6 * 3600 * 1000
    })
    .sort((a, b) => Date.parse(a.net) - Date.parse(b.net))

  const pastFrom = window.past_from ? Date.parse(window.past_from) : null
  const pastTo = window.future_to ? Date.parse(window.future_to) : null
  const windowLabel =
    pastFrom && pastTo
      ? `${new Date(pastFrom).toISOString().slice(0, 10)} – ${new Date(pastTo).toISOString().slice(0, 10)}`
      : 'Beobachtungsfenster'

  const stamp = icsTime(now)
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//launch-tracker//Raketenstarts//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText('Launch-Tracker (Raketenstarts)')}`,
    `X-WR-CALDESC:${escapeText(`Geplante Starts im Beobachtungsfenster ${windowLabel}`)}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT2H',
    'X-PUBLISHED-TTL:PT2H',
  ]

  for (const launch of upcoming) {
    const netMs = Date.parse(launch.net)
    if (!Number.isFinite(netMs)) continue

    // Startfenster: bevorzugt aus der Quelle, sonst ein Standardfenster.
    const win = launch.window
    const winStart = win?.start ? Date.parse(win.start) : null
    const winEnd = win?.end ? Date.parse(win.end) : null
    const durationS =
      typeof win?.duration_s === 'number' && Number.isFinite(win.duration_s) && win.duration_s > 0
        ? win.duration_s
        : DEFAULT_WINDOW_S

    const endMs = winEnd ?? winStart ?? netMs + durationS * 1000

    const rocket = launch.rocket ?? {}
    const site = launch.launch_site ?? {}
    const mission = launch.mission ?? {}

    const location = [site.location, site.country].filter(Boolean).join(', ')
    const description = [
      `Rakete: ${rocket.name ?? 'unbekannt'}`,
      `Anbieter: ${rocket.provider ?? 'unbekannt'}`,
      mission.name ? `Mission: ${mission.name}` : null,
      launch.payload ? `Nutzlast: ${launch.payload}` : null,
      launch.status ? `Status: ${launch.status}` : null,
      site.name ? `Startplatz: ${site.name}` : null,
      launch.date_is_estimated ? 'Termin: geschaetzt' : null,
    ]
      .filter(Boolean)
      .join('\n')

    const uid = `${launch.id}@launch-tracker.local`

    lines.push('BEGIN:VEVENT')
    lines.push(`UID:${uid}`)
    lines.push(`DTSTAMP:${stamp}`)
    lines.push(`DTSTART:${icsTime(netMs)}`)
    lines.push(`DTEND:${icsTime(Math.max(endMs, netMs + 60000))}`)
    if (!launch.date_is_estimated) {
      lines.push('TRANSP:TRANSPARENT')
    }
    lines.push(`SUMMARY:${escapeText(launch.name ?? 'Unbenannter Start')}`)
    if (location) lines.push(`LOCATION:${escapeText(location)}`)
    if (description) lines.push(`DESCRIPTION:${escapeText(description)}`)
    if (launch.info_url) lines.push(`URL:${escapeText(launch.info_url)}`)
    lines.push('END:VEVENT')
  }

  lines.push('END:VCALENDAR')
  // RFC 5545 verlangt CRLF als Zeilenende.
  return lines.map(foldLine).join('\r\n') + '\r\n'
}

async function main() {
  let raw
  try {
    raw = await readFile(LAUNCH_FILE, 'utf8')
  } catch (e) {
    console.error(`[ics] FEHLER: ${LAUNCH_FILE} nicht lesbar: ${e.message}`)
    process.exit(1)
  }

  let dataset
  try {
    dataset = JSON.parse(raw)
  } catch (e) {
    console.error(`[ics] FEHLER: ${LAUNCH_FILE} ist kein gueltiges JSON: ${e.message}`)
    process.exit(1)
  }

  const now = Date.now()
  const text = buildIcs(dataset, now)
  const count = (text.match(/BEGIN:VEVENT/g) ?? []).length

  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, text, 'utf8')
  console.log(`[ics] ${OUT}: ${count} geplante Termine, ${text.length} Bytes.`)
  process.exit(0)
}

// Nur schreiben, wenn das Skript direkt aufgerufen wurde. Beim Import
// (Test) bleibt die Datei unangetastet - sonst wuerde ein Testlauf den
// Live-Feed leeren.
const istDirektaufruf =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href

if (istDirektaufruf) {
  main().catch((e) => {
    console.error('[ics] Unerwarteter Fehler:', e)
    process.exit(1)
  })
}