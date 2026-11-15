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
Der neue Build liegt in `launch-tracker-recovered/dist/` — **er ist noch nicht deployed.**

**Wichtig:** Der recovered Baum ist ein *anderer* Stand als das 9001-Bundle
(CSS-Klassen-Overlap nur 6 %). `www/assets/*.js|css` im 9001-Repo bleiben
die letzte Kopie des laufenden App-Codes, bis der neue Build deployed ist.

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

- **App-Deploy aus `launch-tracker-recovered` vorbereiten** (9001-Parität
  ist erreicht; der Build ist grün). Vorher: `browser-check.mjs` auf die
  neuen CSS-Klassen umstellen, dann `dist/` nach `www/` übernehmen und den
  Deploy-Skript um einen Bundle-Hash-Parameter erweitern.
- **YouTube Data API v3** statt Grid-Scrape — liefert exakte `publishedAt`
  statt Rasterangaben. Aufwand ~2–3 h, braucht einen API-Key.
- **TLS/HTTPS** vor .119 (Caddy/nginx), damit der Service Worker aktiv wird
  (er braucht einen secure context) und `webcal://` sauber greift.
- **Monitoring an die Kette hängen**: `/api/health` liefert jetzt 503 bei
  veralteten Daten — ein Watchdog auf 9001 würde den Ausfall melden.
