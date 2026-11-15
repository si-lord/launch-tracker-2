#!/usr/bin/env node
/**
 * Haelt die Start-Video-Zuordnung aktuell - der Cronjob-Eintrag dafuer.
 *
 * Ablauf (jeder Lauf unabhaengig, Fehler bleiben lokal):
 *   1. fetch-videos.mjs holt die neuesten Videos; auf Wurf mit --backfill auch
 *      die komplette Kanalliste fuer bereits vergangene Starts.
 *   2. Die geholten Videos werden mit dem Bestand in data/videos.json
 *      vereinigt. Der Bestand waechst nur - ein Video, das einmal drin ist,
 *      bleibt drin, auch wenn der Kanal es loescht.
 *   3. Die Starts aus data/launches.json werden gegen die Videos geprueft
 *      (scripts/lib/match-videos.mjs).
 *   4. Beide Dateien werden erst nach vollstaendiger Pruefung per rename()
 *      an die endgueltige Stelle geschoben. Der Server liest also nie einen
 *      halben Stand, und ein Fehler koennte keine vorhandenen Links loeschen.
 *
 * Aufruf:
 *   node scripts/refresh-videos.mjs                    # Normalfall
 *   node scripts/refresh-videos.mjs --backfill         # einmal Rueckwaerts-Abruf
 *   node scripts/refresh-videos.mjs --dry-run          # nur pruefen
 *   node scripts/refresh-videos.mjs --force            # auch bei starkem Rueckgang
 *
 * Exit-Code 0 = Zuordnung aktualisiert (oder --dry-run erfolgreich),
 * Exit-Code 1 = nichts geschrieben, der alte Stand bleibt unangetastet.
 *
 * Die Zuordnung liegt bewusst in einer eigenen Datei und nicht in
 * launches.json: der Startabruf ueberschreibt diese Datei bei jedem Lauf und
 * wuerde die Verknuepfungen mitnehmen. Ueber die Start-ID (UUID der Quelle,
 * nachgemessen stabil) bleibt die Zuordnung auch nach jedem Datenwechsel
 * erhalten. Fehlt die Datei, laeuft die App ohne Verknuepfungen weiter.
 */

import { spawn } from 'node:child_process'
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHANNEL, buildVideoLinks } from './lib/match-videos.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const FETCH = resolve(HERE, 'fetch-videos.mjs')

const KEEP_BACKUPS = 3
/** Unterhalb dieses Anteils gilt der Abruf als unvollstaendig. */
const MIN_RETENTION = 0.5
/** YouTube-Kennung: genau elf Zeichen aus Buchstaben, Ziffern, - und _. */
const VIDEO_ID = /^[\w-]{11}$/

/* ------------------------------------------------------------------ Args */

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return null
  const value = process.argv[index + 1]
  return value && !value.startsWith('--') ? value : null
}

const DATA_DIR = resolve(argValue('--data-dir') ?? join(ROOT, 'data'))
const LAUNCH_FILE = join(DATA_DIR, 'launches.json')
const VIDEO_FILE = join(DATA_DIR, 'videos.json')
const LINK_FILE = join(DATA_DIR, 'video-links.json')
const DRY_RUN = process.argv.includes('--dry-run')
const FORCE = process.argv.includes('--force')
const BACKFILL = process.argv.includes('--backfill')
/** Hochgeladene Datei statt Netzabruf (Tests, Offline). */
const FROM_FILE = argValue('--from-file')

/* -------------------------------------------------------------- Pruefung */

class ValidationError extends Error {}

function fail(message) {
  throw new ValidationError(message)
}

/**
 * Der geholte Videosatz wird geprueft, bevor er den Bestand ueberholt:
 * Kennung, Titel und URL muessen zum Kanal passen. Alles andere waere eine
 * fremde Quelle, die sich in die Anzeige geschlichen hat.
 */
function validateFetched(raw) {
  let data
  try {
    data = JSON.parse(raw)
  } catch (error) {
    fail(`Die Antwort ist kein gueltiges JSON (${error.message}).`)
  }
  if (!data || typeof data !== 'object') fail('Die Antwort ist kein Objekt.')
  if (!Array.isArray(data.videos)) fail('videos ist kein Array.')
  if (data.meta?.channel_id !== CHANNEL.id) {
    fail(`Falscher Kanal: ${data.meta?.channel_id ?? 'unbekannt'} statt ${CHANNEL.id}.`)
  }

  const seen = new Set()
  for (const video of data.videos) {
    if (typeof video?.id !== 'string' || !VIDEO_ID.test(video.id)) fail(`Ungueltige Video-ID: ${video.id}`)
    if (seen.has(video.id)) fail(`Doppelte Video-ID: ${video.id}`)
    seen.add(video.id)
    if (typeof video.title !== 'string' || video.title.length < 4 || video.title.length > 200) {
      fail(`Video ${video.id}: Titel fehlt oder ist unplausibel.`)
    }
    if (video.url !== `https://www.youtube.com/watch?v=${video.id}`) {
      fail(`Video ${video.id}: URL passt nicht zur Kennung.`)
    }
  }
  return data
}

/** Bestehender Bestand - tolerant, weil er nur ergaenzt wird. */
function readStore(raw) {
  if (!raw) return { meta: {}, videos: [] }
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed.videos)) return { meta: {}, videos: [] }
    const videos = parsed.videos.filter((v) => typeof v?.id === 'string' && VIDEO_ID.test(v.id))
    return { meta: parsed.meta ?? {}, videos }
  } catch {
    return { meta: {}, videos: [] }
  }
}

/** Neu und Besteand zusammenfuehren. Der Bestand verliert nichts. */
function mergeVideos(store, fetched) {
  const byId = new Map()
  for (const video of store.videos) byId.set(video.id, { ...video, source: video.source ?? 'store' })

  const added = []
  const updated = []
  for (const video of fetched.videos) {
    const previous = byId.get(video.id)
    if (!previous) {
      byId.set(video.id, { ...video, first_seen: new Date().toISOString() })
      added.push(video.id)
      continue
    }
    // Ein spaeterer Lauf ergaenzt nur, was fehlte: exaktes Datum, Hinweis.
    const merged = {
      ...previous,
      title: video.title ?? previous.title,
      // Exakter Zeitstempel ist immer besser als die Altersangabe des Rasters.
      published_at: video.published_at ?? previous.published_at ?? null,
      published_hint: video.published_hint ?? previous.published_hint ?? null,
    }
    if (JSON.stringify(merged) !== JSON.stringify(previous)) updated.push(video.id)
    byId.set(video.id, merged)
  }

  const videos = [...byId.values()].sort((a, b) => {
    const left = a.published_at ?? a.first_seen ?? ''
    const right = b.published_at ?? b.first_seen ?? ''
    return right.localeCompare(left)
  })
  return { videos, added, updated }
}

/* ------------------------------------------------------------------ Ablauf */

async function runFetch(target) {
  await mkdir(dirname(target), { recursive: true })
  const args = [FETCH, '--out', target]
  if (BACKFILL) args.push('--backfill')
  if (FROM_FILE) {
    // fetch-videos.mjs kann nicht aus einer Datei lesen; dann wird sie direkt
    // als Rohantwort behandelt.
    return { fromFile: FROM_FILE }
  }
  const code = await new Promise((resolveCode, rejectCode) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' })
    child.on('error', rejectCode)
    child.on('close', (value) => resolveCode(value ?? 1))
  })
  if (code !== 0) fail(`fetch-videos.mjs brach mit Exit-Code ${code} ab.`)
  return { file: target }
}

async function readJsonFile(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
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

async function replaceAtomically(temporary, target) {
  try {
    await stat(target)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await copyFile(target, `${target}.bak-${stamp}`)
  } catch {
    // Noch keine Datei - dann gibt es nichts zu sichern.
  }
  await rename(temporary, target)
  await pruneBackups(dirname(target), target.split(/[\\/]/).pop())
}

async function main() {
  const started = Date.now()
  const now = Date.now()

  console.log(`[videos] Kanalsicherung: ${CHANNEL.handle} (${CHANNEL.id})`)
  const storeBefore = readStore(await readFile(VIDEO_FILE, 'utf8').catch(() => ''))
  const linksBefore = await readJsonFile(LINK_FILE)
  console.log(
    `[videos] Bestand: ${storeBefore.videos.length} Videos` +
      (linksBefore ? `, ${Object.keys(linksBefore.links ?? {}).length} Starts verknuepft` : ', keine Zuordnung'),
  )

  const launches = await readJsonFile(LAUNCH_FILE)
  if (!launches || !Array.isArray(launches.launches) || launches.launches.length === 0) {
    console.error(`[videos] ABBRUCH: ${LAUNCH_FILE} fehlt oder ist leer.`)
    console.error('[videos] Erst scripts/refresh-data.mjs laufen lassen.')
    process.exit(1)
  }

  const temporary = `${VIDEO_FILE}.tmp-${process.pid}`
  const linkTemporary = `${LINK_FILE}.tmp-${process.pid}`

  let fetched
  let summary
  try {
    const source = FROM_FILE ? { fromFile: FROM_FILE } : await runFetch(temporary)
    const raw = FROM_FILE ? await readFile(source.fromFile, 'utf8') : await readFile(temporary, 'utf8')
    fetched = validateFetched(raw)
    summary = buildVideoLinks(launches.launches, mergeVideos(storeBefore, fetched).videos, { now })
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    await rm(linkTemporary, { force: true }).catch(() => {})
    console.error(`[videos] ABBRUCH: ${error.message}`)
    console.error('[videos] Zuordnung und Bestand wurden nicht angetastet.')
    process.exit(1)
  }

  const merged = mergeVideos(storeBefore, fetched)
  const stats = summary.stats
  console.log(
    `[videos] Geholt: ${fetched.videos.length} Videos` +
      (BACKFILL ? ' (mit Rueckwaerts-Abruf)' : ' (nur neueste)'),
  )
  console.log(
    `[videos] Bestand: ${merged.videos.length} Videos · ${merged.added.length} neu · ${merged.updated.length} ergaenzt`,
  )
  console.log(
    `[videos] Verknuepft: ${stats.linked} von ${stats.launches} Starts ` +
      `(${stats.linkedVideos} Videos, Stufe 1/2/3 = ${stats.byTier[1] ?? 0}/${stats.byTier[2] ?? 0}/${stats.byTier[3] ?? 0})`,
  )

  // Schutz vor unvollstaendigen Antworten: der Kanal liefert nicht plötzlich
  // 90 % weniger Videos. Ein solcher Stand waere ein Ausfall, kein Fortschritt.
  if (storeBefore.videos.length > 50 && !FORCE) {
    const ratio = merged.videos.length / storeBefore.videos.length
    if (ratio < MIN_RETENTION) {
      await rm(temporary, { force: true }).catch(() => {})
      console.error(
        `[videos] ABBRUCH: ${merged.videos.length} statt ${storeBefore.videos.length} Videos im Bestand. ` +
          'Mit --force trotzdem uebernehmen.',
      )
      process.exit(1)
    }
  }
  // Und derselbe Schutz fuer die Zuordnung: ein starker Rueckgang heisst fast
  // immer, dass die Startsliste leer gelesen wurde.
  if (linksBefore && !FORCE) {
    const before = Object.keys(linksBefore.links ?? {}).length
    if (before > 5 && stats.linked < before * MIN_RETENTION) {
      await rm(temporary, { force: true }).catch(() => {})
      await rm(linkTemporary, { force: true }).catch(() => {})
      console.error(
        `[videos] ABBRUCH: nur ${stats.linked} statt ${before} verknuepften Starts. ` +
          'Mit --force trotzdem uebernehmen.',
      )
      process.exit(1)
    }
  }

  if (DRY_RUN) {
    await rm(temporary, { force: true }).catch(() => {})
    await rm(linkTemporary, { force: true }).catch(() => {})
    console.log('[videos] --dry-run: geprueft, nichts geschrieben.')
    return
  }

  const stamp = new Date().toISOString()
  const store = {
    meta: {
      channel_id: CHANNEL.id,
      handle: CHANNEL.handle,
      label: CHANNEL.label,
      updated_at: stamp,
      backfilled_at: BACKFILL ? stamp : (storeBefore.meta.backfilled_at ?? null),
      video_count: merged.videos.length,
      with_exact_date: merged.videos.filter((v) => v.published_at).length,
    },
    videos: merged.videos,
  }
  await writeFile(temporary, `${JSON.stringify(store, null, 1)}\n`, 'utf8')

  const links = {
    meta: {
      generated_at: stamp,
      channel: CHANNEL.label,
      channel_id: CHANNEL.id,
      channel_url: `https://www.youtube.com/${CHANNEL.handle}`,
      launches: stats.launches,
      videos: merged.videos.length,
      linked: stats.linked,
      linked_videos: stats.linkedVideos,
      by_tier: stats.byTier,
      launches_generated_at: launches.meta?.generated_at ?? null,
    },
    links: summary.links,
  }
  await writeFile(linkTemporary, `${JSON.stringify(links, null, 1)}\n`, 'utf8')

  await replaceAtomically(temporary, VIDEO_FILE)
  await replaceAtomically(linkTemporary, LINK_FILE)

  await writeFile(
    `${LINK_FILE}.status.json`,
    `${JSON.stringify(
      {
        ...links.meta,
        new_videos: merged.added.length,
        enriched_videos: merged.updated.length,
        video_count: merged.videos.length,
        checked_at: stamp,
        duration_ms: Date.now() - started,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  console.log(`[videos] Fertig in ${((Date.now() - started) / 1000).toFixed(1)} s.`)
}

main().catch(async (error) => {
  console.error('[videos] Unerwarteter Fehler:', error)
  process.exit(1)
})
