#!/usr/bin/env node
/**
 * Statischer Server fuer den Launch-Tracker.
 *
 *   node server.mjs [www-Verzeichnis]    (default: ./www)
 *   PORT=9001 node server.mjs
 *
 * Liefert:
 *   - Brotli (text/*, application/javascript, image/svg+xml, application/json, text/calendar)
 *     ueber vorgekaempte .br-Dateien aus dist (scripts/precompress.mjs).
 *   - gzip als Fallback ueber vorgekaempte .gz-Dateien.
 *   - GET /api/launches.json - die Live-Daten aus ../data/launches.json.
 *     Fehlt die Datei, antwortet der Endpunkt mit 404; die App faellt dann auf
 *     den einkompilierten Stand zurueck (siehe src/lib/dataset.ts).
 *   - GET /api/video-links.json - die Zuordnung Start -> Video aus
 *     ../data/video-links.json (siehe scripts/refresh-videos.mjs). Fehlt sie,
 *     antwortet der Endpunkt mit 404; die App laeuft dann ohne Verknuepfungen.
 *   - GET /api/health - Zustand des Datenabgleichs (fuer Monitoring/Deploy).
 *   - Content-Security-Policy passend zum Sicherheits-Gate der App.
 *   - Cache-Control "immutable" fuer gehashte Assets, kurzer TTL fuer HTML/manifest/ics.
 *   - SPA-Fallback auf index.html fuer Pfade ohne "." (Vite nutzt base './').
 *   - HEAD, Range-Requests, Pfad-Traversal-Schutz.
 *   - HTTP/1.1 mit Keep-Alive (node:http-Default).
 *
 * Keine externen Abhaengigkeiten - nur node:-Builtins.
 */

import { createReadStream, readFileSync, statSync, existsSync } from 'node:fs'
import { extname, basename, join, normalize, resolve, sep } from 'node:path'
import { createServer } from 'node:http'
import { createGzip } from 'node:zlib'

const ROOT = resolve(process.argv[2] ?? './www')
const PORT = Number.parseInt(process.env.PORT ?? '9001', 10)

/**
 * Live-Daten liegen bewusst AUSSERHALB des ausgelieferten www-Baums:
 * so sind sie kein statisches Asset, werden nicht mitgecacht und lassen sich
 * aktualisieren, ohne die App neu zu bauen.
 */
const DATA_DIR = resolve(process.env.DATA_DIR ?? join(ROOT, '..', 'data'))
const DATA_FILE = join(DATA_DIR, 'launches.json')
const STATUS_FILE = join(DATA_DIR, 'launches.json.status.json')
/** Zuordnung Start -> Video. Eigenstaendig: sie entsteht aus den Startdaten,
 *  darf sie aber nicht ueberschreiben. Fehlt die Datei, laeuft die App ohne. */
const VIDEO_LINK_FILE = join(DATA_DIR, 'video-links.json')
const VIDEO_STATUS_FILE = join(DATA_DIR, 'video-links.json.status.json')
/**
 * Der Kalender-Feed wird bei jedem Datenabgleich aus den Live-Daten neu
 * erzeugt (scripts/generate-ics.mjs) und liegt deshalb im Datenverzeichnis,
 * nicht im ausgelieferten www-Baum. Ein statisches File waere sofort
 * veraltet - das war der Fehler im statischen www/feed.ics.
 */
const ICS_FILE = join(DATA_DIR, 'feed.ics')

/** Ab dieser Groesse lohnt sich gzip auf der Leitung. */
const GZIP_FROM_BYTES = 4096

/**
 * Frische-Schwellen fuer /api/health.
 *
 * Ohne diese Grenzen sah ein Wochen alter Datenstand gesund aus: der
 * Health-Endpunkt meldete nur, OB eine Datei existiert. Genau daran ist
 * der Ausfall der Video-Kette (RSS antwortet seit 14.11. mit 404) wochenlang
 * unbemerkt geblieben.
 *
 * Ueber die Umgebung uebersteuerbar: MAX_DATA_AGE_S, MAX_VIDEO_AGE_S.
 */
const MAX_DATA_AGE_S = Number.parseInt(process.env.MAX_DATA_AGE_S ?? '21600', 10) // 6 Stunden
const MAX_VIDEO_AGE_S = Number.parseInt(process.env.MAX_VIDEO_AGE_S ?? '43200', 10) // 12 Stunden

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.ics': 'text/calendar; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
}

const IMMUTABLE = new Set(['.js', '.mjs', '.css', '.svg', '.ico', '.png', '.webmanifest'])
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.svg', '.json', '.webmanifest', '.ics', '.txt'])

/**
 * Diese Dateien tragen trotz passender Endung keinen Inhalts-Hash und duerfen
 * deshalb NICHT ein Jahr lang als unveraenderlich ausgeliefert werden - sonst
 * bliebe ein Update unbemerkt haengen.
 */
const ALWAYS_REVALIDATE = new Set(['sw.js', 'index.html', 'manifest.webmanifest', 'feed.ics'])

const CSP = [
  "default-src 'self'",
  // Externe Bilder (thespacedevs.com) und das Favicon als data: sind erlaubt.
  "img-src 'self' https: data:",
  "connect-src 'self'",
  "style-src 'self'",
  // Vite-Bundle und lazy-loaded 3D-Chunk sind same-origin.
  "script-src 'self'",
  // Service Worker und Web-App-Manifest sind same-origin.
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ')

const SECURITY = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'geolocation=(), microphone=(), camera=()',
  'x-frame-options': 'DENY',
}
// Hinweis: Cross-Origin-Opener-Policy fehlt bewusst. Ueber HTTP (kein
// secure context) ignorieren die Browser den Header und schreiben nur eine
// Konsolenwarnung. Bei einer spaeteren TLS-Terminierung wieder aufnehmen.

/** Antwortet mit 403, wenn der aufgeloeste Pfad ausserhalb von ROOT liegt. */
function isInsideRoot(filePath) {
  const normalized = normalize(filePath)
  const rootWithSep = ROOT.endsWith(sep) ? ROOT : ROOT + sep
  return normalized === ROOT || normalized.startsWith(rootWithSep)
}

function sendError(res, status, message) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY })
  res.end(message)
}

function serveFile(req, res, filePath) {
  const ext = extname(filePath).toLowerCase()
  const mime = MIME[ext]
  if (!mime) {
    sendError(res, 403, 'Forbidden')
    return
  }

  let stat
  try {
    stat = statSync(filePath)
  } catch {
    sendError(res, 404, 'Not Found')
    return
  }

  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs / 1000).toString(16)}"`
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, ...SECURITY })
    res.end()
    return
  }

  const longLived = IMMUTABLE.has(ext) && !ALWAYS_REVALIDATE.has(basename(filePath))

  const headers = {
    ...SECURITY,
    'content-type': mime,
    etag,
    'cache-control': longLived ? 'public, max-age=31536000, immutable' : 'no-cache',
  }

  // Range-Support (vereinfacht, single range).
  // "bytes=-" liefert leere Zahl -> Number.parseInt('') = NaN -> ERR_OUT_OF_RANGE.
  // Wir pruefen beide Seiten, bevor sie verrechnet werden.
  const range = req.headers.range
  if (range && /^bytes=\d*-\d*$/.test(range)) {
    const [startStr, endStr] = range.slice(6).split('-')
    const startNum = startStr === '' ? null : Number.parseInt(startStr, 10)
    const endNum = endStr === '' ? null : Number.parseInt(endStr, 10)
    if (
      (startStr !== '' && !Number.isInteger(startNum)) ||
      (endStr !== '' && !Number.isInteger(endNum)) ||
      (startStr === '' && endStr === '')
    ) {
      res.writeHead(416, { 'content-range': `bytes */${stat.size}`, ...SECURITY })
      res.end()
      return
    }
    const start = startNum === null ? Math.max(0, stat.size - endNum) : startNum
    const end = endNum === null ? stat.size - 1 : endNum
    if (start >= stat.size || end >= stat.size || start > end || start < 0 || end < 0) {
      res.writeHead(416, { 'content-range': `bytes */${stat.size}`, ...SECURITY })
      res.end()
      return
    }
    headers['content-range'] = `bytes ${start}-${end}/${stat.size}`
    headers['content-length'] = String(end - start + 1)
    res.writeHead(206, headers)
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    const rangeStream = createReadStream(filePath, { start, end })
    rangeStream.on('error', () => res.destroy())
    res.on('close', () => rangeStream.destroy())
    rangeStream.pipe(res)
    return
  }

  // Pre-compressed? Brotli hat Vorrang vor gzip.
  const acceptEnc = req.headers['accept-encoding'] ?? ''
  if (COMPRESSIBLE.has(ext)) {
    if (acceptEnc.includes('br') && existsSync(filePath + '.br')) {
      headers['content-encoding'] = 'br'
      res.writeHead(200, headers)
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      createReadStream(filePath + '.br').pipe(res)
      return
    }
    if (acceptEnc.includes('gzip') && existsSync(filePath + '.gz')) {
      headers['content-encoding'] = 'gzip'
      res.writeHead(200, headers)
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      createReadStream(filePath + '.gz').pipe(res)
      return
    }
  }

  headers['content-length'] = String(stat.size)
  res.writeHead(200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const fileStream = createReadStream(filePath)
  fileStream.on('error', () => res.destroy())
  res.on('close', () => fileStream.destroy())
  fileStream.pipe(res)
}

/* --------------------------------------------------------- Live-Daten-API */

/**
 * Liefert /feed.ics aus dem Datenverzeichnis.
 *
 * Fehlt die Datei (noch kein Datenabgleich gelaufen), antwortet der
 * Endpunkt mit einem leeren, aber gueltigen Kalender. Ein 404 wuerde im
 * Kalender-Dialog der App als kaputtes Abo erscheinen - ein leerer
 * Kalender ist ehrlicher: "es stehen gerade keine Termine an".
 */
const EMPTY_ICS =
  'BEGIN:VCALENDAR\r\n' +
  'VERSION:2.0\r\n' +
  'PRODID:-//launch-tracker//Raketenstarts//DE\r\n' +
  'CALSCALE:GREGORIAN\r\n' +
  'METHOD:PUBLISH\r\n' +
  'X-WR-CALNAME:Launch-Tracker (Raketenstarts)\r\n' +
  'X-WR-CALDESC:Geplante Starts im Beobachtungsfenster\r\n' +
  'END:VCALENDAR\r\n'

function serveIcs(req, res) {
  const headers = {
    ...SECURITY,
    'content-type': MIME['.ics'],
    'cache-control': 'no-cache',
  }
  try {
    const stat = statSync(ICS_FILE)
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs / 1000).toString(16)}"`
    headers.etag = etag
    headers['last-modified'] = new Date(stat.mtimeMs).toUTCString()
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers)
      res.end()
      return
    }
    headers['content-length'] = String(stat.size)
    res.writeHead(200, headers)
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    const stream = createReadStream(ICS_FILE)
    stream.on('error', () => res.destroy())
    res.on('close', () => stream.destroy())
    stream.pipe(res)
  } catch {
    headers['content-length'] = String(Buffer.byteLength(EMPTY_ICS))
    res.writeHead(200, headers)
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    res.end(EMPTY_ICS)
  }
}

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': MIME['.json'], ...SECURITY, ...extraHeaders })
  res.end(body)
}

/**
 * Liefert /api/launches.json aus dem Datenverzeichnis.
 *
 * Bewusst "no-cache": der Client darf die Antwort zwischenspeichern, muss sie
 * aber jedes Mal revalidieren. Zusammen mit dem ETag kostet das im Normalfall
 * nur einen 304 und die App sieht trotzdem sofort einen neuen Datenstand.
 */
function serveData(req, res, file = DATA_FILE, missing = 'keine Live-Daten vorhanden') {
  let stat
  try {
    stat = statSync(file)
    if (!stat.isFile()) throw new Error('keine Datei')
  } catch {
    sendJson(res, 404, JSON.stringify({ error: missing }))
    return
  }

  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs / 1000).toString(16)}"`
  const lastModified = new Date(stat.mtimeMs).toUTCString()

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'last-modified': lastModified, ...SECURITY })
    res.end()
    return
  }

  const headers = {
    ...SECURITY,
    'content-type': MIME['.json'],
    etag,
    'last-modified': lastModified,
    'cache-control': 'no-cache',
    vary: 'accept-encoding',
  }

  const acceptEncoding = req.headers['accept-encoding'] ?? ''
  const useGzip = stat.size >= GZIP_FROM_BYTES && acceptEncoding.includes('gzip')
  if (useGzip) headers['content-encoding'] = 'gzip'

  res.writeHead(200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }

  const source = createReadStream(file)
  source.on('error', () => res.destroy())
  if (useGzip) source.pipe(createGzip()).pipe(res)
  else source.pipe(res)
}

/**
 * Zustand der Video-Zuordnung, getrennt vom Startabruf: sie entsteht in einer
 * eigenen Kette und darf den Startabruf nicht als fehlerhaft ausweisen.
 */
function videoStatus() {
  try {
    const stat = statSync(VIDEO_LINK_FILE)
    let summary = null
    try {
      summary = JSON.parse(readFileSync(VIDEO_STATUS_FILE, 'utf8'))
    } catch {
      summary = null
    }
    const ageSeconds = Math.round((Date.now() - stat.mtimeMs) / 1000)
    return {
      file: VIDEO_LINK_FILE,
      bytes: stat.size,
      ageSeconds,
      stale: ageSeconds > MAX_VIDEO_AGE_S,
      maxAgeSeconds: MAX_VIDEO_AGE_S,
      summary,
    }
  } catch {
    // Keine Zuordnung vorhanden: das ist kein Veralten, sondern ein fehlender
    // Zustand. Wird deshalb nicht als stale gewertet.
    return { file: VIDEO_LINK_FILE, present: false, stale: false }
  }
}

/** /api/health: kurz und maschinenlesbar - fuer Deploy-Pruefung und Monitoring. */
function serveHealth(req, res) {
  let payload
  try {
    const stat = statSync(DATA_FILE)
    let summary = null
    try {
      summary = JSON.parse(readFileSync(STATUS_FILE, 'utf8'))
    } catch {
      summary = null
    }
    const ageSeconds = Math.round((Date.now() - stat.mtimeMs) / 1000)
    const videos = videoStatus()
    const stale = ageSeconds > MAX_DATA_AGE_S
    payload = {
      // ok ist nur true, wenn die Daten aktuell sind. Ein veralteter Stand
      // ist ein Ausfall, kein Erfolg - der Deploy bricht dann ab.
      ok: !stale && !videos.stale,
      port: PORT,
      dataFile: DATA_FILE,
      dataBytes: stat.size,
      dataAgeSeconds: ageSeconds,
      dataMaxAgeSeconds: MAX_DATA_AGE_S,
      stale,
      summary,
      videos,
    }
    if (stale) {
      payload.hint = `Startdaten sind ${ageSeconds} s alt (Grenze ${MAX_DATA_AGE_S} s). Cronjob laeuft?`
    }
    if (videos.stale) {
      payload.hint = `${payload.hint ? payload.hint + ' ' : ''}Video-Zuordnung ist ${videos.ageSeconds} s alt (Grenze ${MAX_VIDEO_AGE_S} s). RSS-Feed?`
    }
  } catch {
    payload = {
      ok: false,
      port: PORT,
      dataFile: DATA_FILE,
      hint: 'Noch kein Datenabgleich gelaufen. node scripts/refresh-data.mjs ausfuehren.',
      videos: videoStatus(),
    }
  }
  sendJson(res, payload.ok ? 200 : 503, JSON.stringify(payload, null, 2))
}

const server = createServer((req, res) => {
  if (!req.url) {
    sendError(res, 400, 'Bad Request')
    return
  }
  let url
  try {
    url = new URL(req.url, 'http://localhost')
  } catch {
    sendError(res, 400, 'Bad Request')
    return
  }
  let decoded
  try {
    decoded = decodeURIComponent(url.pathname)
  } catch {
    sendError(res, 400, 'Bad Request')
    return
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (decoded === '/api/launches.json') {
      serveData(req, res)
      return
    }
    if (decoded === '/api/video-links.json') {
      serveData(req, res, VIDEO_LINK_FILE, 'keine Video-Zuordnung vorhanden')
      return
    }
    if (decoded === '/api/health') {
      serveHealth(req, res)
      return
    }
    if (decoded === '/feed.ics') {
      serveIcs(req, res)
      return
    }
  } else {
    sendError(res, 405, 'Method Not Allowed')
    return
  }

  let filePath = normalize(join(ROOT, decoded))
  if (!isInsideRoot(filePath)) {
    sendError(res, 403, 'Forbidden')
    return
  }

  let stat = null
  try {
    stat = statSync(filePath)
  } catch {
    stat = null
  }

  if (!stat || !stat.isFile()) {
    // SPA-Fallback: unbekannte Pfade ohne "." (kein Asset) -> index.html
    if (!extname(decoded) && existsSync(join(ROOT, 'index.html'))) {
      filePath = join(ROOT, 'index.html')
    } else {
      sendError(res, 404, 'Not Found')
      return
    }
  }

  serveFile(req, res, filePath)
})

// Letzte Verteidigungslinie: eine unbehandelte Ausnahme darf den Dienst
// nicht stilllegen. Der Fehler wird geloggt, der Prozess laeuft weiter.
process.on('uncaughtException', (error) => {
  console.error('[launch-tracker] unbehandelte Ausnahme:', error)
})
process.on('unhandledRejection', (reason) => {
  console.error('[launch-tracker] unbehandelte Promise:', reason)
})

// Bind-Adresse: 0.0.0.0, damit der Dienst direkt aus dem LAN ueber
// http://<host>:9001 erreichbar ist (der direkte Weg bleibt).
//
// Ueber nginx (Port 443) laeuft derselbe Dienst zusaetzlich mit TLS und
// Security-Headern - der Proxy-Aufbau ist Sache von Ops und laeuft auf
// 127.0.0.1:9001 weiter, ohne dass hier etwas zu tun ist.
//
// HOST=127.0.0.1 bindet den Dienst nur an das Loopback-Interface, wenn
// ausschliesslich der TLS-Weg genutzt werden soll.
const HOST = process.env.HOST ?? '0.0.0.0'

server.listen(PORT, HOST, () => {
  console.log(`[launch-tracker] serving ${ROOT} on ${HOST}:${PORT}`)
})