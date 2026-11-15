/* Launch-Tracker Service Worker
 *
 * Ziel: die Seite startet auch ohne Netz. Der Datensatz steckt ohnehin schon im
 * JavaScript-Bundle, der Worker sichert zusaetzlich die Huelle (HTML, Icons,
 * Manifest) und die zuletzt gesehenen Live-Daten.
 *
 * Strategie je Pfad:
 *   Navigation        -> Netz zuerst, sonst die zwischengespeicherte index.html
 *   /assets/*         -> Cache zuerst (die Dateinamen enthalten einen Hash,
 *                        ein neuer Build erzeugt also neue URLs)
 *   /api/*            -> Netz zuerst, sonst die letzte Antwort
 *   /feed.ics         -> Netz zuerst
 *   alles andere      -> direkt durchreichen
 *
 * Wichtig: Laeuft die Seite ueber HTTP (kein secure context), registriert der
 * Browser den Worker gar nicht erst. Die App funktioniert dann unveraendert,
 * nur eben ohne Offline-Zwischenspeicher. Siehe src/main.tsx.
 */

const VERSION = 'lt-v1'
const SHELL_CACHE = `${VERSION}-shell`
const ASSET_CACHE = `${VERSION}-assets`
const DATA_CACHE = `${VERSION}-data`
const CURRENT_CACHES = new Set([SHELL_CACHE, ASSET_CACHE, DATA_CACHE])

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './favicon.svg',
  './icon-192.png',
  './icon-512.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE)
      // Einzeln statt addAll: eine fehlende Datei soll nicht die ganze
      // Installation verhindern.
      await Promise.all(
        SHELL_ASSETS.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => null)),
      )
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(names.filter((name) => !CURRENT_CACHES.has(name)).map((name) => caches.delete(name)))
      await self.clients.claim()
    })(),
  )
})

/** Netz zuerst, Zwischenspeicher als Rueckfall. */
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName)
  try {
    const response = await fetch(request)
    if (response && response.ok) await cache.put(request, response.clone())
    return response
  } catch (error) {
    const cached = await cache.match(request)
    if (cached) return cached
    throw error
  }
}

/** Cache zuerst, im Hintergrund auffrischen. */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(request)
  if (cached) {
    // Auffrischen ohne auf das Ergebnis zu warten.
    fetch(request)
      .then((response) => {
        if (response && response.ok) return cache.put(request, response)
        return null
      })
      .catch(() => null)
    return cached
  }
  const response = await fetch(request)
  if (response && response.ok) await cache.put(request, response.clone())
  return response
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // Navigationsanfragen: erst das Netz, sonst die Huelle aus dem Speicher.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request)
          const cache = await caches.open(SHELL_CACHE)
          if (response && response.ok) await cache.put('./index.html', response.clone())
          return response
        } catch {
          const cache = await caches.open(SHELL_CACHE)
          const cached =
            (await cache.match('./index.html')) ?? (await cache.match('./')) ?? (await cache.match(request))
          if (cached) return cached
          return new Response(
            '<!doctype html><meta charset="utf-8"><title>Launch-Tracker</title>' +
              '<p style="font:14px system-ui;padding:24px;color:#e8eef9;background:#070a12">' +
              'Offline und noch kein Seitenabbild im Zwischenspeicher. Bitte einmal mit Netz laden.</p>',
            { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
          )
        }
      })(),
    )
    return
  }

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      networkFirst(request, DATA_CACHE).catch(
        () =>
          new Response(JSON.stringify({ error: 'offline' }), {
            status: 503,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          }),
      ),
    )
    return
  }

  if (url.pathname === '/feed.ics') {
    event.respondWith(networkFirst(request, DATA_CACHE).catch(() => caches.match(request)))
    return
  }

  if (url.pathname.startsWith('/assets/') || /\.(?:js|mjs|css|png|svg|webmanifest|ico)$/.test(url.pathname)) {
    event.respondWith(cacheFirst(request, ASSET_CACHE))
  }
})
