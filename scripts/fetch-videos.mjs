#!/usr/bin/env node
/**
 * Holt die Videoliste des SciNews-Kanals (@SciNewsRo) und schreibt sie als
 * JSON-Datei. Es wird nichts an Launch-Daten angefasst.
 *
 * Zwei Wege, bewusst getrennt:
 *   1. RSS-Feed (https://www.youtube.com/feeds/videos.xml?channel_id=...)
 *      liefert die 15 neuesten Videos MIT exaktem Veroeffentlichungsdatum.
 *      Ein Aufruf, guenstig, fuer den Betrieb.
 *   2. Die Videoliste des Kanals mit Seitenblättern. Sie reicht weit zurueck
 *      (derzeit ueber 1200 Videos) und liefert nur eine relative Altersangabe
 *      ("2d ago"). Wird nur gebraucht, um bereits vergangene Starts
 *      zuzuordnen - also einmal, nicht bei jedem Lauf.
 *
 * Aufruf:
 *   node scripts/fetch-videos.mjs --out data/videos.json
 *   node scripts/fetch-videos.mjs --out data/videos.json --backfill
 *   node scripts/fetch-videos.mjs --out - --dry-run
 *
 * Nur node:-Builtins, wie die uebrigen Skripte - auf dem Server ist keine
 * node_modules noetig.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { CHANNEL } from './lib/match-videos.mjs'

/* ------------------------------------------------------------------ Args */

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return null
  const value = process.argv[index + 1]
  return value && !value.startsWith('--') ? value : null
}

const OUT = argValue('--out')
const BACKFILL = process.argv.includes('--backfill')
const DRY_RUN = process.argv.includes('--dry-run')
const MAX_PAGES = Number.parseInt(argValue('--max-pages') ?? '60', 10)

/* -------------------------------------------------------------- HTTP */

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/**
 * Ohne diesen Cookie legt YouTube in manchen Regionen erst eine
 * Zustimmungsseite vor. Er stimmt der Zustimmung zu und sonst nichts.
 */
const HEADERS = {
  'user-agent': USER_AGENT,
  'accept-language': 'en-US,en;q=0.9',
  cookie: 'CONSENT=YES+cb.20210328-17-p0.en+FX+100',
}

/** Oeffentlicher Web-Client-Schluessel; nur fuer das Lesen oeffentlicher Daten. */
const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'
const CLIENT_VERSION = '2.20250929.00.00'
const CONTEXT = {
  client: { clientName: 'WEB', clientVersion: CLIENT_VERSION, hl: 'en', gl: 'US' },
}

const TIMEOUT_MS = 20000

async function getText(url) {
  const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!response.ok) throw new Error(`HTTP ${response.status} bei ${url}`)
  return response.text()
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...HEADERS,
      'content-type': 'application/json',
      'x-youtube-client-name': '1',
      'x-youtube-client-version': CLIENT_VERSION,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} bei ${url}`)
  return response.json()
}

function xmlText(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))
  if (!match) return null
  return match[1]
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
}

/* ------------------------------------------------------------- RSS-Feed */

/**
 * Die 15 neuesten Videos mit exaktem Datum.
 * YouTube sagt das selbst, ohne Rueckfrage - deshalb die erste Quelle.
 */
async function fetchFeed() {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL.id}`
  const xml = await getText(url)
  const entries = xml.split('<entry>').slice(1)
  const videos = []
  for (const entry of entries) {
    const id = xmlText(entry, 'yt:videoId')
    const title = xmlText(entry, 'title')
    if (!id || !title) continue
    const published = xmlText(entry, 'published')
    const publishedAt = published && Number.isFinite(Date.parse(published)) ? published : null
    videos.push({
      id,
      title,
      url: `https://www.youtube.com/watch?v=${id}`,
      published_at: publishedAt,
      published_hint: null,
      source: 'feed',
    })
  }
  return videos
}

/* -------------------------------------------------- Kanalliste mit Blaettern */

function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const entry of node) walk(entry, visit)
    return
  }
  visit(node)
  for (const key of Object.keys(node)) walk(node[key], visit)
}

const AGE_HINT = /\d+\s*(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?|[dwmhys])\.?\s+ago/i

/**
 * Videos aus einem Teilbaum lesen. Die Weboberflaeche legt sie als
 * lockupViewModel ab: Kennung im contentId, Titel im metadata-Block.
 */
function collect(root) {
  const found = new Map()
  walk(root, (node) => {
    const id = node.contentId ?? node.videoId
    if (typeof id !== 'string' || !/^[\w-]{11}$/.test(id)) return
    const title =
      node?.metadata?.lockupMetadataViewModel?.title?.content ??
      node?.title?.simpleText ??
      node?.title?.runs?.map((run) => run.text).join('')
    if (typeof title !== 'string' || title.length < 8 || title.length > 200) return
    if (found.has(id)) return
    const rows = node?.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows
    const rowText = (rows ?? []).flatMap((row) => row.metadataParts ?? []).map((p) => p.text?.content ?? '').join(' ')
    const hint = rowText.match(AGE_HINT)?.[0] ?? null
    found.set(id, {
      id,
      title,
      url: `https://www.youtube.com/watch?v=${id}`,
      published_at: null,
      published_hint: hint ? hint.replace(/\s+/g, ' ').toLowerCase() : null,
      source: 'grid',
    })
  })
  return [...found.values()]
}

/**
 * Die komplette Videoliste des Kanals. Wechselt die Weboberflaeche ihre
 * Struktur, liefert dieser Weg nichts - der RSS-Feed laeuft trotzdem weiter.
 */
async function fetchChannelPages() {
  const html = await getText(`https://www.youtube.com/${CHANNEL.handle}/videos?hl=en&gl=US`)
  const initial = html.match(/var ytInitialData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/)
  if (!initial) throw new Error('ytInitialData nicht gefunden - Struktur der Kanalseite hat sich geaendert.')

  const all = new Map(collect(JSON.parse(initial[1])).map((v) => [v.id, v]))
  let token = [...html.matchAll(/"continuationCommand":\{"token":"([^"]+)"/g)][0]?.[1] ?? null
  let pages = 1

  while (token && pages < MAX_PAGES) {
    const payload = await postJson(`https://www.youtube.com/youtubei/v1/browse?key=${INNERTUBE_KEY}`, {
      context: CONTEXT,
      continuation: token,
    })
    const items = payload?.onResponseReceivedActions?.[0]?.appendContinuationItemsAction?.continuationItems
    if (!Array.isArray(items) || items.length === 0) break
    let added = 0
    for (const video of collect(items)) {
      if (all.has(video.id)) continue
      all.set(video.id, video)
      added += 1
    }
    const source = JSON.stringify(items)
    const next = [...source.matchAll(/"continuationCommand":\{"token":"([^"]+)"/g)][0]?.[1] ?? null
    pages += 1
    if (added === 0 || !next) break
    token = next
  }

  return [...all.values()]
}

/* ---------------------------------------------------------------- Ablauf */

async function main() {
  if (!OUT && !DRY_RUN) {
    console.error('[videos] --out fehlt (Zieldatei oder "-" fuer stdout).')
    process.exit(1)
  }

  console.log(`[videos] Kanal: ${CHANNEL.handle} (${CHANNEL.id})`)

  let feed = []
  try {
    feed = await fetchFeed()
    console.log(`[videos] RSS: ${feed.length} neueste Videos mit exaktem Datum.`)
  } catch (error) {
    console.error(`[videos] RSS-Abruf fehlgeschlagen: ${error.message}`)
  }

  let grid = []
  if (BACKFILL) {
    try {
      grid = await fetchChannelPages()
      console.log(`[videos] Kanalliste: ${grid.length} Videos aus ${MAX_PAGES} Seiten hoechstens.`)
    } catch (error) {
      // Kein Grund, den Lauf abzubrechen: der Feed liefert die Neuzugaenge.
      console.error(`[videos] Kanalliste fehlgeschlagen: ${error.message}`)
      console.error('[videos] Es laeuft mit den 15 neuesten Videos weiter.')
    }
  } else {
    console.log('[videos] Rueckwaerts-Abruf uebersprungen (--backfill nicht gesetzt).')
  }

  // Feed zuerst: er traegt das exakte Datum und gewinnt gegen den Rasterwert.
  const merged = new Map()
  for (const video of grid) merged.set(video.id, video)
  for (const video of feed) merged.set(video.id, { ...video, published_hint: video.published_hint ?? null })

  // Ein leeres Ergebnis ist kein Erfolg, sondern ein Ausfall: dann bricht der
  // Lauf ab und der vorhandene Bestand bleibt unangetastet.
  if (merged.size === 0) {
    console.error('[videos] ABBRUCH: keine Videos erhalten - der Kanal ist nicht erreichbar oder leer.')
    process.exit(1)
  }

  const videos = [...merged.values()].sort((a, b) => (b.published_at ?? '').localeCompare(a.published_at ?? ''))
  const payload = {
    meta: {
      channel_id: CHANNEL.id,
      handle: CHANNEL.handle,
      label: CHANNEL.label,
      fetched_at: new Date().toISOString(),
      backfill: BACKFILL,
      video_count: videos.length,
      with_exact_date: videos.filter((v) => v.published_at).length,
    },
    videos,
  }
  const text = `${JSON.stringify(payload, null, 1)}\n`

  if (DRY_RUN && !OUT) {
    console.log(text.slice(0, 400))
    console.log(`[videos] --dry-run: ${videos.length} Videos, nichts geschrieben.`)
    return
  }
  if (OUT === '-') {
    process.stdout.write(text)
    return
  }

  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, text, 'utf8')
  console.log(`[videos] Geschrieben: ${OUT} (${videos.length} Videos).`)
}

main().catch((error) => {
  console.error('[videos] Unerwarteter Fehler:', error)
  process.exit(1)
})
