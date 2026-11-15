# Übergabe: Launch-Tracker 2 (Port 9001)

Stand 2026-11-15. Kurzfassung für die nächste Dev-Session.

## Wo liegt was

| Rolle | Pfad |
|---|---|
| **Source (editierbar)** | CT 11133 → `/home/silord/projects/launch-tracker-2` (git, branch `main`) |
| **Remote** | `github.com/si-lord/launch-tracker-2` |
| **Live** | CT 11119 → `/home/silord/WebServer/launch-tracker-2` (`launch-tracker-2.service`, `node server.mjs`, User `silord`) |
| **URL** | http://192.168.11.119:9001 |

Port 9000 (alter Leaflet-Tracker) wurde am 2026-11-15 komplett gelöscht
(Unit + Verzeichnisse auf .119 und .11.133). Backups:
`.119:/home/silord/launch-tracker-9000-deleted-20261115-012345.tar.gz` ·
`11133:/home/silord/workspace/launch-tracker-9000-deleted-20261115-012521.bundle`

## Deploy

```bash
sshpass -p 'Ness2002#' ssh root@192.168.11.133 \
  "su - silord -c 'cd /home/silord/projects/launch-tracker-2 && bash scripts/deploy-to-webserver.sh'"
```

Macht: Backup auf .119 → scp (`www/`, `scripts/`, `server.mjs`) →
`sudo systemctl restart launch-tracker-2.service` → `/api/health` → md5-Driftkontrolle
Bundle src vs. Live. Abbruch bei dirty Working-Tree — erst committen.

## Wichtige Stolperfallen

1. **Kein `src/` vorhanden.** Der Original-Quellbaum lag in einem 24h-Scratch
   (`~/.hermes/cache/scratch/lt` auf dem Hermes-Host) und ist beim Cleanup
   verloren. `www/assets/*.js|*.css` sind die **letzte existierende Kopie**
   des App-Codes (minifiziert) — deshalb bewusst im Repo, nicht ignoriert.
   Weiterentwickeln heißt: Bundle reverse-engineeren oder neu aufsetzen.
2. **Deploy remote nur als `silord`** (Key-Auth, `~/.ssh/config`).
   Root-Login per Key ist auf .119 gesperrt → `sudo -n` verwenden.
3. **Cronjobs auf .119** (unverändert, nicht im Repo):
   `23 */2` → `refresh-data.mjs` (LL2-API) ·
   `37 */4` → `refresh-videos.mjs` (YouTube-RSS `@SciNewsRo`)
4. **`data/` ist git-ignoriert** (Live-Daten) — lokaler Testlauf
   `node scripts/refresh-data.mjs` schreibt dort rein.
5. **YouTube-RSS liefert HTTP 404** für den Kanal (liegt an YouTube, nicht
   am Code). `refresh-videos.mjs` bricht sauber ab und lässt den Bestand
   unangetastet — das ist korrekt, kein Bug im Repo.
6. `git` als root in `silord`-Repos braucht `safe.directory`
   (global bereits gesetzt).

## Nächste sinnvolle Schritte

- YouTube-Kanal-ID prüfen (`UCjU6ZwoTQtKWfz1urL7XcbA`) — Kanal existiert, RSS-Feed liefert 404
- `scripts/precompress.mjs` fehlt im Repo (`.br/.gz` werden auf .119 erzeugt) — entweder
  nachziehen oder in `.gitignore` dokumentieren (aktuell ignoriert)
- App-Code aus dem minifizierten Bundle rekonstruieren, falls UI-Änderungen gewünscht sind
