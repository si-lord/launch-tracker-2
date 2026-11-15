#!/usr/bin/env bash
# Deploy: Launch-Tracker 2 von CT 11133 (Source) nach CT 11119 (WebServer/Live).
#
# Ablauf:
#   1. Source-Stand auf 11133 pruefen (clean? Commit vorhanden?)
#   2. Live-Daten (.119/data) und www-Assets (.119/www) holen
#   3. Precompress ausfuehren (.br/.gz erzeugen)
#   4. www + scripts + server.mjs nach .119 spiegeln
#   5. Service neu starten, Health pruefen
#
# WICHTIG: data/ (Live-Daten aus dem LL2-Cron) und die .br/.gz-Precompress-
# Varianten werden NICHT aus dem Repo ueberschrieben - sie entstehen auf .119
# durch die Cronjobs bzw. scripts/precompress. Der Deploy gibt nur www/ (ohne
# data/), scripts/ und server.mjs weiter.
#
# Aufruf:  bash deploy-to-webserver.sh
# Exit:    0 = erfolgreich deployed und verifiziert
#          1 = Fehler (Abbruch, Live unveraendert)

set -uo pipefail

SRC="/home/silord/projects/launch-tracker-2"
# Ziel laeuft als silord (Key-Auth via ~/.ssh/config), sudo fuer Systemzugriff.
DST_HOST="silord@192.168.11.119"
DST="/home/silord/WebServer/launch-tracker-2"
SSH="ssh -o BatchMode=yes -o ConnectTimeout=10"
SCP="scp -q -o BatchMode=yes -o ConnectTimeout=10"

log() { printf '%s | %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
fail() { log "FEHLER: $*"; exit 1; }

# ---------------------------------------------------------------- 1. Source
[ -d "$SRC/.git" ] || fail "kein git-Repo in $SRC"
cd "$SRC" || fail "$SRC nicht betretbar"

DIRTY="$(git status --porcelain | wc -l)"
[ "$DIRTY" -eq 0 ] || fail "Working-Tree nicht clean ($DIRTY Aenderungen) - erst committen"
COMMIT="$(git rev-parse --short HEAD)"
log "Source: $COMMIT (branch $(git rev-parse --abbrev-ref HEAD))"

# ---------------------------------------------------------------- 2. Precompress (Sidecars erzeugen)
log "Führe Precompress aus (.br/.gz erzeugen)"
node scripts/precompress.mjs || fail "Precompress fehlgeschlagen"
node scripts/precompress.mjs --check || fail "Precompress-Pruefung fehlgeschlagen"
log "Precompress OK"

# ---------------------------------------------------------------- 3. Remote-Daten sichern
log "Sichere Live-Daten auf $DST_HOST"
$SSH "$DST_HOST" "cd '$DST' && ts=\$(date +%Y%m%d-%H%M%S) && tar czf /home/silord/launch-tracker-2-predeploy-\$ts.tar.gz www scripts server.mjs 2>/dev/null; echo Backup: /home/silord/launch-tracker-2-predeploy-\$ts.tar.gz" \
  || fail "Remote-Backup fehlgeschlagen"

# ---------------------------------------------------------------- 4. Spiegeln (www OHNE data/, plus scripts + server.mjs)
log "Spiegele www/ (ohne data/), scripts/, server.mjs nach $DST_HOST"
# rsync statt scp: erhaelt Rechte, loescht stale Dateien im Ziel, aber NICHT data/
$SSH "$DST_HOST" "mkdir -p '$DST/www' '$DST/scripts'" || fail "Remote-Verzeichnisse anlegen fehlgeschlagen"
rsync -az --delete --exclude='data/' "$SRC/www/" "$DST_HOST:$DST/www/" \
  || fail "rsync www/ fehlgeschlagen"
rsync -az --delete "$SRC/scripts/" "$DST_HOST:$DST/scripts/" \
  || fail "rsync scripts/ fehlgeschlagen"
rsync -az "$SRC/server.mjs" "$DST_HOST:$DST/server.mjs" \
  || fail "rsync server.mjs fehlgeschlagen"

log "Restarte launch-tracker-2.service"
$SSH "$DST_HOST" "sudo -n systemctl restart launch-tracker-2.service && sleep 3 && systemctl is-active launch-tracker-2.service && sudo -n systemctl show launch-tracker-2.service -p ExecMainStartTimestamp" \
  || fail "Service-Restart fehlgeschlagen"

# ---------------------------------------------------------------- 5. Verify
log "Health-Check"
CODE="$($SSH "$DST_HOST" "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9001/api/health")"
log "GET /api/health -> $CODE"
[ "$CODE" = "200" ] || fail "Health-Check fehlgeschlagen ($CODE)"

# Bundle-Integritaet: md5 des ausgelieferten Bundles muss auf beiden Seiten gleich sein
# (dynamischer Hash statt hardcodiertem Dateinamen)
SRC_BUNDLE="$(ls "$SRC/www/assets/index-"*.js 2>/dev/null | head -1)"
[ -n "$SRC_BUNDLE" ] || fail "Kein Haupt-Bundle in www/assets/ gefunden"
SRC_MD5="$(md5sum "$SRC_BUNDLE" | cut -d' ' -f1)"
DST_BUNDLE="$(basename "$SRC_BUNDLE")"
DST_MD5="$($SSH "$DST_HOST" "md5sum $DST/www/assets/$DST_BUNDLE 2>/dev/null | cut -d' ' -f1")"
log "Bundle-md5 src=$SRC_MD5 dst=$DST_MD5 (file=$(basename "$SRC_BUNDLE"))"
[ "$SRC_MD5" = "$DST_MD5" ] || fail "Bundle weicht ab (Drift)"

log "Deploy OK: Commit $COMMIT live auf Port 9001"
exit 0