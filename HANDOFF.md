# Übergabe: Launch-Tracker 2 (Port 9001)

Stand 2026-11-15 (nach Track B + Track A S1–S8). Für die nächste Dev-Session.

## Wo liegt was

| Rolle | Pfad |
|---|---|
| **Source (editierbar)** | CT 11133 → `/home/silord/projects/launch-tracker-2` (git, branch `main`) |
| **Remote** | `github.com/si-lord/launch-tracker-2` |
| **Live** | CT 11119 → `/home/silord/WebServer/launch-tracker-2` (`launch-tracker-2.service`, `node server.mjs`, User `silord`) |
| **URL** | http://192.168.11.119:9001 |
| **App-Quellbaum (neu!)** | CT 11133 → `/home/silord/projects/launch-tracker-recovered` (git, aus dem gelöschten 9000-Bundle) |

Port 9000 (alter Leaflet-Tracker) wurde am 2026-11-15 komplett gelöscht
(Unit + Verzeichnisse auf .119 und .11.133). Backups:
`.119:/home/silord/launch-tracker-9000-deleted-20261115-012345.tar.gz` ·
`11133:/home/silord/workspace/launch-tracker-9000-deleted-20261115-012521.bundle`

## Der App-Quellbaum ist wiederhergestellt

Der Quellbaum galt als verloren. Er steckte aber im **gelöschten 9000-Bundle**:
`git clone --branch main /home/silord/workspace/launch-tracker-9000-deleted-20261115-012521.bundle`
→ vollständiger `src/`-Baum (40 Dateien, Vite/React 19/TS/Leaflet 1.9.4/three r171).

Die Parität zum 9001-Stand ist hergestellt und in
`launch-tracker-recovered/PARITAETS-SPEZIFIKATION.md` dokumentiert.

**Stand 2026-11-16: Der neue Build ist deployed und live.**
- `launch-tracker-recovered` ist das **App-Repo** (GitHub: `si-lord/launch-tracker-2-app`),
  `launch-tracker-2` (dieses Repo) ist das **Betriebs-/Server-Repo**
  (GitHub: `si-lord/launch-tracker-2`).
- Der Browser-Check (`scripts/browser-check.mjs`) prüft die 9001-Klassen
  und läuft grün (Exit 0).
- `dist/` aus dem App-Repo wird per `rsync` nach `www/` gespiegelt, danach
  erzeugt `scripts/precompress.mjs` die `.br`/`.gz`-Sidecars.
- Live-Bundles: `index-opsUPA4q.js`, `index-CKYaV5RY.css`, `Stage3D-hNuxAYkw.js`
  (neu ausgeliefert: `leaflet-src`, `world-outline`, Layer-Tiles, Marker-Icon).
- **PWA-Parität** (Commit `6909fcd` im App-Repo): `sw.js`, `manifest.webmanifest`,
  `icon-192/512.png` und die SW-Registrierung in `src/main.tsx` waren im
  wiederhergestellten Baum nicht vorhanden — sie steckten nur minifiziert im
  alten Bundle. Ohne sie hätte ein Deploy den Offline-Cache (`lt-v1`) zerstört.
- Der Theme-Umschalter läuft über `data-design` (`dunkel`/`hell`) in
  `App.tsx` + `Kopfzeile.tsx` — **nicht** über `data-theme`.

## Deploy

```bash
sshpass -p 'Ness2002#' ssh root@192.168.11.133 \
  "su - silord -c 'cd /home/silord/projects/launch-tracker-2 && bash scripts/deploy-to-webserver.sh'"
```

Macht: Precompress (`.br`/`.gz` erzeugen + prüfen) → Backup auf .119 →
`rsync` (www/ ohne data/, scripts/, server.mjs) → `systemctl restart` →
Health-Check → md5-Integrität **aller** www-Dateien. Bei Fehler in Health
oder Integrität: automatischer Rollback auf das Predeploy-Backup.

`--dry-run` prüft Source-Zustand und Branch, schreibt aber nichts.

## Was am 2026-11-15 gefixt wurde (Track A, S1–S8)

| Schritt | Commit | Was |
|---|---|---|
| S1 | `e160ff0` | **P0:** `server.mjs` starb bei `GET //` und `Range: bytes=-` — ein unauthentifizierter Request killte den Dienst für 5 s. Jetzt 400/416 statt Crash. |
| S2 | `243566f` | `scripts/precompress.mjs` (fehlte komplett) + Deploy-Integration: rsync statt scp, dynamischer Bundle-Hash statt hardcodiertem Dateinamen. |
| S3 | `63cbf64` | `fetch-launches.mjs`: `OUT_DEFAULT` zeigte ins tote `src/data/` → jetzt `data/`. Timeout (8 s) + Retry (2×). Pagination-Guard bei ≥100 Ergebnissen. |
| S4 | `309532d` | **Video-Kette wiederbelebt:** RSS-Feed liefert für *alle* Kanäle 404 (auch NASA) — jetzt automatischer Fallback auf die Kanalliste. Altersangaben („2d ago“) werden auf den Scrape-Zeitpunkt bezogen, nicht auf heute (vorher 41 Tage Drift). |
| S5 | `e9f4b3e` | **Kalender-Feed aus Live-Daten:** `scripts/generate-ics.mjs`. Der statische `www/feed.ics` enthielt 5 *vergangene* Termine statt 11 geplanter. Jetzt: 20 geplante Termine, aus `data/feed.ics` ausgeliefert. |
| S6 | `996d7b7` | `/api/health` prüft Frische: Startdaten >6 h oder Videos >12 h alt → **503** statt „gesund“. |
| S7 | `8207392` | Deploy: Branch-Check (nur `main`), Rollback bei Fehler, md5 über alle www-Dateien statt nur eines Bundles. |
| S8 | — | `scripts/core.test.mjs` (15 Tests, `node --test`), `package.json` mit Test-/Deploy-Skripten. |

## Wichtige Stolperfallen

1. **Der YouTube-RSS-Endpunkt antwortet in dieser Umgebung generell mit 404**
   — für jede Kanal-ID, auch für bekannte Kanäle wie NASA. Die Kanal-ID
   `UCjU6ZwoTQtKWfz1urL7XcbA` ist **korrekt**; nicht ändern. Lösung ist der
   Grid-Fallback in `fetch-videos.mjs` (`--no-grid-fallback` schaltet ihn ab).
2. **Altersangaben driften.** Das Kanalraster zeigt „2 years ago“ auch in
   einem Jahr noch an. `videoAgeRange()` in `scripts/lib/match-videos.mjs`
   rechnet deshalb mit `first_seen` als Bezugspunkt. Wer das ändert, baut den
   Drift wieder ein.
3. **Kein `src/` im 9001-Repo** — der App-Code existiert dort nur als
   minifiziertes Vite-Bundle. Die Skripte hier sind der eigentliche
   Quellcode. App-Weiterentwicklung gehört ins recovered-Repo.
4. **`data/` ist git-ignoriert** und wird vom Deploy **nicht** angefasst.
   `www/feed.ics` ist ebenfalls entfernt (wird aus `data/` erzeugt).
5. **`.br`/`.gz` werden beim Deploy erzeugt**, nicht im Repo gepflegt.
   `node scripts/precompress.mjs --check` prüft Frische und Inhalt.
6. **Deploy remote nur als `silord`** (Key-Auth, `~/.ssh/config`).
   Root-Login per Key ist auf .119 gesperrt → `sudo -n` verwenden.
7. **Cronjobs auf .119** (unverändert, nicht im Repo):
   `23 */2` → `refresh-data.mjs` (LL2-API) ·
   `37 */4` → `refresh-videos.mjs` (YouTube, mit Grid-Fallback)
8. **`git` als root in `silord`-Repos braucht `safe.directory`.**

## Tests

```bash
cd /home/silord/projects/launch-tracker-2
node --test scripts/core.test.mjs     # 15 Tests: Fenster, Video-Alter, iCalendar
```

## Nächste sinnvolle Schritte

- **YouTube Data API v3** statt Grid-Scrape — liefert exakte `publishedAt`
  statt Rasterangaben. Aufwand ~2–3 h, **braucht einen API-Key**
  (`YOUTUBE_API_KEY`; im System ist derzeit keiner hinterlegt). Ohne Key
  läuft der Grid-Fallback (17 von 35 Starts verknüpft).
- **App-Weiterentwicklung** gehört ins App-Repo `launch-tracker-recovered`
  (`si-lord/launch-tracker-2-app`), nicht in dieses Betriebs-Repo.

## TLS und Monitoring (erledigt 2026-11-15/16)

- **Der Node-Dienst bindet auf `0.0.0.0`** (Default in `server.mjs`,
  Commit `086e051`). Port 9001 ist **direkt aus dem LAN erreichbar**:
  `http://192.168.11.119:9001/`. Mit `HOST=127.0.0.1` bindet der Dienst
  nur aufs Loopback-Interface.
- **TLS läuft über Nginx Proxy Manager auf 192.168.150.3** (nicht mehr über
  nginx auf .119 — die alte Conf liegt als `launch-tracker.conf.disabled-*`
  in `/etc/nginx/conf.d/`). Proxy-Host 23 in der NPM-Datenbank
  (`/data/database.sqlite` auf .150.3) zeigt auf `http://192.168.11.119:9001`.
- **Öffentliche Adresse:** `https://launch-tracker.silord.local/`
  DNS via Pihole (192.168.150.4) → 192.168.150.3. Zertifikat-ID 23 in NPM
  (`launch-tracker.silord.local self-signed`), SAN enthält
  `launch-tracker.silord.local` und `nginx.silord.local`.
- **Achtung Zertifikat:** NPM-Zertifikate sind **self-signed** (Muster aller
  Dienste in diesem Proxy). Der Browser muss das NPM-CA importieren, sonst
  `ERR_CERT_AUTHORITY_INVALID`. Die alte interne CA
  (`/usr/local/share/si-ct-ca/si-ct-ca.crt`) wird **nicht** mehr verwendet.
- **Security-Header** kommen weiterhin vom Dienst selbst (CSP, HSTS,
  X-Frame-Options) und werden von NPM unverändert durchgereicht.
- **Interne CA** unter `/usr/local/share/si-ct-ca/si-ct-ca.crt` (4096 bit,
  10 Jahre). Server-Zertifikat mit SAN `silord-home.duckdns.org`,
  `192.168.11.119`, `127.0.0.1`. Kein Let's Encrypt — die Seite bleibt
  bewusst LAN-only (NAT ohne Portweiterleitung).
- **Achtung:** Chromium nutzt einen eigenen CA-Store; die System-CA reicht
  dort nicht. Browser müssen die CA manuell importieren
  (Kopie liegt auf .119 unter `/home/silord/WebServer/si-ct-ca.crt`).
- **Watchdog** `scripts/watchdog.sh` (Cron `*/5 * * * *`): HTTP 200 = gesund,
  HTTP 503 = Daten veraltet → Dienst neu starten, kein HTTP = tot → neu
  starten. Log: `/home/silord/launch-tracker-watchdog.log`.
