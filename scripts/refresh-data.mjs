#!/usr/bin/env node
/**
 * Aktualisiert die Live-Daten fuer den laufenden Server - ohne Neubau der App.
 *
 * Ablauf:
 *   1. fetch-launches.mjs holt die aktuellen Starts in eine temporaere Datei.
 *   2. Die Datei wird geprueft (Struktur, Zeitstempel, URL-Schema, Koordinaten,
 *      Vollstaendigkeit) und gegen den bestehenden Stand verglichen.
 *   3. Nur wenn die Pruefung besteht, wird sie per rename() an die endgueltige
 *      Stelle geschoben. rename() ist innerhalb eines Dateisystems atomar -
 *      der Server liest also nie eine halb geschriebene Datei.
 *   4. Der vorherige Stand wandert als .bak-<zeitstempel> zur Seite
 *      (standardmaessig bleiben drei Generationen liegen).
 *
 * Aufruf:
 *   node scripts/refresh-data.mjs                  # data/launches.json
 *   node scripts/refresh-data.mjs --out /tmp/x.json
 *   node scripts/refresh-data.mjs --dry-run        # nur pruefen
 *   node scripts/refresh-data.mjs --force          # auch bei starkem Rueckgang
 *
 * Exit-Code 0 = Datei aktualisiert (oder --dry-run erfolgreich),
 * Exit-Code 1 = nichts geschrieben, der alte Stand bleibt unangetastet.
 *
 * Der Server liefert die Datei unter /api/launches.json aus (siehe server.mjs).
 * Fehlt sie, greift die App auf den einkompilierten Stand zurueck.
 */

import { spawn } from 'node:child_process'
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const FETCH = resolve(HERE, 'fetch-launches.mjs')
const ICS = resolve(HERE, 'generate-ics.mjs')

const KEEP_BACKUPS = 3
/** Unterhalb dieses Anteils am alten Stand gilt der Abruf als unvollstaendig. */
const MIN_RETENTION = 0.5

/* ------------------------------------------------------------------ Args */

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return null
  const value = process.argv[index + 1]
  return value && !value.startsWith('--') ? value : null
}

const OUT = resolve(argValue('--out') ?? join(ROOT, 'data', 'launches.json'))
const DRY_RUN = process.argv.includes('--dry-run')
const FORCE = process.argv.includes('--force')
/** Rohantwort der API aus einer Datei lesen statt neu abzurufen (Tests, Offline). */
const FROM_FILE = argValue('--from-file')

/* -------------------------------------------------------------- Pruefung */

class ValidationError extends Error {}

function fail(message) {
  throw new ValidationError(message)
}

/**
 * Alle Zeichenketten einsammeln, in denen eine URL stecken koennte.
 *
 * Bewusst kein Versuch, "sieht aus wie eine URL" zu erraten: ein Webcast-Titel
 * wie "Live: Falcon 9 startet" wuerde dabei faelschlich als Schema "live:"
 * durchgehen. Geprueft wird stattdessen gezielt auf die Schemata, die wirklich
 * gefaehrlich sind.
 */
function collectStrings(value, path, found) {
  if (typeof value === 'string') {
    found.push([path, value])
    return found
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectStrings(entry, `${path}[${index}]`, found))
    return found
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) collectStrings(entry, `${path}.${key}`, found)
  }
  return found
}

/** Unverschluesselte Uebertragung - darf im Datensatz nicht vorkommen. */
const INSECURE = /\b(?:http|ftp|file|blob):/i
/** Aktive Inhalte - im Datensatz hat nichts davon etwas zu suchen. */
const ACTIVE = /^\s*(?:javascript|vbscript|data):/i
const HTTPS = /https:\/\//gi

/**
 * Prueft den frisch geholten Datensatz. Bricht bei jedem Zweifel ab, statt
 * einen kaputten Stand auszuliefern - die App soll lieber den alten zeigen.
 */
function validate(raw) {
  let data
  try {
    data = JSON.parse(raw)
  } catch (error) {
    fail(`Die Antwort ist kein gueltiges JSON (${error.message}).`)
  }

  if (!data || typeof data !== 'object') fail('Der Datensatz ist kein Objekt.')
  if (!data.meta || typeof data.meta !== 'object') fail('meta fehlt.')
  if (!Array.isArray(data.launches)) fail('launches ist kein Array.')
  if (data.launches.length === 0) fail('launches ist leer.')

  const generatedAt = Date.parse(data.meta.generated_at ?? '')
  if (!Number.isFinite(generatedAt)) fail('meta.generated_at ist kein lesbarer Zeitstempel.')

  const ids = new Set()
  let past = 0
  let future = 0
  let withoutCoords = 0
  let estimated = 0

  for (const launch of data.launches) {
    const where = `Start ${launch?.id ?? '?'}`
    if (typeof launch?.id !== 'string' || launch.id.length === 0) fail('Ein Start hat keine id.')
    if (ids.has(launch.id)) fail(`${where}: doppelte id.`)
    ids.add(launch.id)

    if (typeof launch.name !== 'string' || launch.name.length === 0) fail(`${where}: name fehlt.`)
    if (!Number.isFinite(Date.parse(launch.net ?? ''))) fail(`${where}: net ist kein Zeitstempel.`)

    if (launch.direction === 'past') past += 1
    else if (launch.direction === 'future') future += 1
    else fail(`${where}: direction ist "${launch.direction}" (erwartet past|future).`)

    if (launch.date_is_estimated === true) estimated += 1

    const site = launch.launch_site
    if (!site || typeof site !== 'object') fail(`${where}: launch_site fehlt.`)
    const lat = site.lat
    const lon = site.lon
    const hasLat = typeof lat === 'number' && Number.isFinite(lat)
    const hasLon = typeof lon === 'number' && Number.isFinite(lon)
    if (hasLat !== hasLon) fail(`${where}: nur eine der beiden Koordinaten gesetzt.`)
    if (hasLat) {
      if (lat < -90 || lat > 90) fail(`${where}: Breite ${lat} ausserhalb von -90..90.`)
      if (lon < -180 || lon > 180) fail(`${where}: Laenge ${lon} ausserhalb von -180..180.`)
    } else {
      withoutCoords += 1
    }

    if (!Array.isArray(launch.rocket?.stages)) fail(`${where}: rocket.stages fehlt.`)
    if (!Array.isArray(launch.timeline)) fail(`${where}: timeline fehlt.`)
    if (!Array.isArray(launch.webcasts)) fail(`${where}: webcasts fehlt.`)
    if (!Array.isArray(launch.info_urls)) fail(`${where}: info_urls fehlt.`)
  }

  if (past + future !== data.launches.length) fail('past + future ergibt nicht die Gesamtzahl.')
  if (typeof data.meta.count === 'number' && data.meta.count !== data.launches.length) {
    fail(`meta.count (${data.meta.count}) passt nicht zur Anzahl (${data.launches.length}).`)
  }

  // Sicherheits-Gate: ausschliesslich https. Ein http:-Link waere im Browser
  // ohnehin blockiert - hier faellt es frueh und laut auf.
  const strings = collectStrings(data, 'dataset', [])
  const unsafe = strings.filter(([, value]) => INSECURE.test(value) || ACTIVE.test(value))
  if (unsafe.length > 0) {
    const [path, value] = unsafe[0]
    fail(`Unsicheres Schema in ${path}: ${value.slice(0, 120)} (${unsafe.length} Fund(e) insgesamt).`)
  }

  const httpsCount = strings.reduce((sum, [, value]) => sum + (value.match(HTTPS)?.length ?? 0), 0)

  return {
    count: data.launches.length,
    past,
    future,
    estimated,
    withoutCoords,
    httpsUrls: httpsCount,
    generatedAt: data.meta.generated_at,
    source: data.meta.source ?? null,
  }
}

/* ------------------------------------------------------------------ Ablauf */

async function runFetch(target) {
  await mkdir(dirname(target), { recursive: true })
  const args = [FETCH, '--out', target]
  if (FROM_FILE) args.push('--from-file', FROM_FILE)
  const code = await new Promise((resolveCode, rejectCode) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: 'inherit',
    })
    child.on('error', rejectCode)
    child.on('close', (value) => resolveCode(value ?? 1))
  })
  if (code !== 0) fail(`fetch-launches.mjs brach mit Exit-Code ${code} ab.`)
}

/**
 * Erzeugt den Kalender-Feed aus den gerade geschriebenen Startdaten.
 * Ein Fehler ist hier nicht fatal: die Startdaten sind das Wichtigere,
 * der Feed wird beim naechsten Lauf nachgezogen.
 */
async function runIcs() {
  const args = [ICS, '--data-dir', dirname(OUT)]
  const code = await new Promise((resolveCode) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: 'inherit',
    })
    child.on('error', () => resolveCode(1))
    child.on('close', (value) => resolveCode(value ?? 1))
  })
  if (code !== 0) {
    console.warn('[refresh] WARNUNG: feed.ics konnte nicht erzeugt werden (Exit ' + code + ').')
  }
}

async function readStats(file) {
  try {
    const [raw, info] = await Promise.all([readFile(file, 'utf8'), stat(file)])
    const parsed = JSON.parse(raw)
    return { count: Array.isArray(parsed?.launches) ? parsed.launches.length : 0, mtime: info.mtime }
  } catch {
    return null
  }
}

async function pruneBackups(directory, baseName) {
  const prefix = `${baseName}.bak-`
  let entries = []
  try {
    entries = await readdir(directory)
  } catch {
    return
  }
  const backups = entries.filter((name) => name.startsWith(prefix)).sort()
  for (const stale of backups.slice(0, Math.max(0, backups.length - KEEP_BACKUPS))) {
    await rm(join(directory, stale), { force: true }).catch(() => {})
  }
}

async function main() {
  const started = Date.now()
  const temporary = `${OUT}.tmp-${process.pid}`
  const previous = await readStats(OUT)

  console.log(`[refresh] Ziel: ${OUT}`)
  if (previous) {
    console.log(
      `[refresh] Bestand: ${previous.count} Starts (${previous.mtime.toISOString()})`,
    )
  } else {
    console.log('[refresh] Bestand: noch keine Live-Datei vorhanden.')
  }

  let summary
  try {
    await runFetch(temporary)
    const raw = await readFile(temporary, 'utf8')
    summary = validate(raw)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    console.error(`[refresh] ABBRUCH: ${error.message}`)
    console.error('[refresh] Der ausgelieferte Stand wurde nicht angetastet.')
    process.exit(1)
  }

  console.log(
    `[refresh] Neu: ${summary.count} Starts (${summary.past} vergangen, ${summary.future} zukuenftig)`,
  )
  console.log(
    `[refresh] ${summary.estimated} geschaetzt · ${summary.withoutCoords} ohne Koordinaten · ${summary.httpsUrls} https-Links geprueft`,
  )

  // Schutz vor unvollstaendigen Antworten der API: ein halber Datensatz
  // waere schlimmer als ein alter.
  if (previous && previous.count > 0) {
    const ratio = summary.count / previous.count
    if (ratio < MIN_RETENTION && !FORCE) {
      await rm(temporary, { force: true }).catch(() => {})
      console.error(
        `[refresh] ABBRUCH: nur ${summary.count} statt ${previous.count} Starts ` +
          `(${(ratio * 100).toFixed(0)} %). Das sieht nach einer unvollstaendigen ` +
          'Antwort aus. Mit --force trotzdem uebernehmen.',
      )
      process.exit(1)
    }
    if (ratio < MIN_RETENTION) {
      console.warn('[refresh] WARNUNG: --force gesetzt, uebernehme den kleineren Datensatz.')
    }
  }

  if (DRY_RUN) {
    await rm(temporary, { force: true }).catch(() => {})
    console.log('[refresh] --dry-run: geprueft, nichts geschrieben.')
    return
  }

  if (previous) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backup = `${OUT}.bak-${stamp}`
    await copyFile(OUT, backup)
    console.log(`[refresh] Sicherung: ${backup}`)
  }

  // Atomarer Wechsel: der Server sieht entweder den alten oder den neuen Stand.
  await rename(temporary, OUT)
  await pruneBackups(dirname(OUT), 'launches.json')

  // Kurzfassung neben die Daten legen - praktisch fuer /api/health und Monitoring.
  await writeFile(
    `${OUT}.status.json`,
    `${JSON.stringify({ ...summary, checked_at: new Date().toISOString(), duration_ms: Date.now() - started }, null, 2)}\n`,
    'utf8',
  )

  // Kalender-Feed aus denselben Daten erzeugen. Er kommt aus dem
  // Datenverzeichnis, nicht aus dem ausgelieferten www-Baum - sonst
  // waere er ein statisches File, das veraltet.
  await runIcs()

  console.log(`[refresh] Fertig in ${((Date.now() - started) / 1000).toFixed(1)} s.`)
}

main().catch(async (error) => {
  console.error('[refresh] Unerwarteter Fehler:', error)
  await rm(`${OUT}.tmp-${process.pid}`, { force: true }).catch(() => {})
  process.exit(1)
})
