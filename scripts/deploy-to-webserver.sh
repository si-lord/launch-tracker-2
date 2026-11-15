#!/usr/bin/env bash
# Deploy: Launch-Tracker 2 von CT 11133 (Source) nach CT 11119 (WebServer/Live).
#
# Ablauf:
#   1. Source-Stand pruefen (clean? Branch main? Commit vorhanden?)
#   2. Precompress ausfuehren (.br/.gz erzeugen und pruefen)
#   3. Remote-Backup des Live-Stands
#   4. www/ (ohne data/), scripts/ und server.mjs nach .119 spiegeln
#   5. Service neu starten
#   6. Health + Asset-Integritaet pruefen - bei Fehler: Rollback
#
# WICHTIG: data/ (Live-Daten aus dem LL2-Cron) wird NICHT angefasst. Die
# .br/.gz-Sidecars entstehen hier im Source-Baum (Schritt 2) und werden mit
# kopiert.
#
# Aufruf:  bash deploy-to-webserver.sh [--dry-run]
# Exit:    0 = erfolgreich deployed und verifiziert
#          1 = Fehler (Abbruch; bei Schritt 5/6 mit Rollback auf den Stand
#               vor diesem Deploy zurueckgesetzt)

set -uo pipefail

SRC="/home/silord/projects/launch-tracker-2"
# Ziel laeuft als silord (Key-Auth via ~/.ssh/config), sudo fuer Systemzugriff.
DST_HOST="silord@192.168.11.119"
DST="/home/silord/WebServer/launch-tracker-2"
SSH="ssh -o BatchMode=yes -o ConnectTimeout=10"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

log() { printf '%s | %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
fail() { log "FEHLER: $*"; exit 1; }

# ---------------------------------------------------------------- 1. Source
[ -d "$SRC/.git" ] || fail "kein git-Repo in $SRC"
cd "$SRC" || fail "$SRC nicht betretbar"

DIRTY="$(git status --porcelain | wc -l)"
[ "$DIRTY" -eq 0 ] || fail "Working-Tree nicht clean ($DIRTY Aenderungen) - erst committen"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || fail "Deploy nur von main (aktuell: $BRANCH)"

COMMIT="$(git rev-parse --short HEAD)"
log "Source: $COMMIT (branch $BRANCH)"

if [ "$DRY_RUN" -eq 1 ]; then
  log "DRY-RUN: kein Write auf .119. Es wuerde deployt: www/, scripts/, server.mjs"
  log "DRY-RUN: Precompress, Backup, rsync, Restart, Health-Check, md5-Driftkontrolle"
  exit 0
fi

# ---------------------------------------------------------------- 2. Precompress
log "Fuehre Precompress aus (.br/.gz erzeugen)"
node scripts/precompress.mjs || fail "Precompress fehlgeschlagen"
node scripts/precompress.mjs --check || fail "Precompress-Pruefung fehlgeschlagen"
log "Precompress OK"

# ---------------------------------------------------------------- 3. Remote-Backup
log "Sichere Live-Daten auf $DST_HOST"
BACKUP_NAME="/home/silord/launch-tracker-2-predeploy-$(date +%Y%m%d-%H%M%S).tar.gz"
$SSH "$DST_HOST" "cd '$DST' && tar czf '$BACKUP_NAME' www scripts server.mjs 2>/dev/null; echo \$?" \
  | grep -q '^0$' || fail "Remote-Backup fehlgeschlagen"
log "Backup: $BACKUP_NAME"

# ---------------------------------------------------------------- 4. Spiegeln
log "Spiegele www/ (ohne data/), scripts/, server.mjs nach $DST_HOST"
$SSH "$DST_HOST" "mkdir -p '$DST/www' '$DST/scripts'" || fail "Remote-Verzeichnisse anlegen fehlgeschlagen"
# rsync statt scp: erhaelt Rechte, loescht stale Dateien im Ziel, aber NICHT data/
rsync -az --delete --exclude='data/' "$SRC/www/" "$DST_HOST:$DST/www/" \
  || fail "rsync www/ fehlgeschlagen"
rsync -az --delete "$SRC/scripts/" "$DST_HOST:$DST/scripts/" \
  || fail "rsync scripts/ fehlgeschlagen"
rsync -az "$SRC/server.mjs" "$DST_HOST:$DST/server.mjs" \
  || fail "rsync server.mjs fehlgeschlagen"

# ---------------------------------------------------------------- 5. Restart
log "Restarte launch-tracker-2.service"
$SSH "$DST_HOST" "sudo -n systemctl restart launch-tracker-2.service && sleep 3 && systemctl is-active launch-tracker-2.service" \
  | grep -q '^active$' || fail "Service-Restart fehlgeschlagen"

# ---------------------------------------------------------------- 6. Verify
rollback() {
  log "ROLLBACK: spiele Backup $BACKUP_NAME zurueck"
  $SSH "$DST_HOST" "cd '$DST' && tar xzf '$BACKUP_NAME' && sudo -n systemctl restart launch-tracker-2.service" \
    && log "Rollback ausgefuehrt - Live laeuft wieder auf dem Stand vor diesem Deploy." \
    || log "ROLLBACK FEHLGESCHLAGEN - manuell pruefen: $DST_HOST"
}

log "Health-Check"
CODE="$($SSH "$DST_HOST" "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9001/api/health")"
log "GET /api/health -> $CODE"
if [ "$CODE" != "200" ]; then
  rollback
  fail "Health-Check fehlgeschlagen ($CODE) - Rollback ausgefuehrt"
fi

# Asset-Integritaet: md5 aller ausgelieferten Assets muss auf beiden Seiten gleich sein.
# Dynamischer Hash: der Name des Haupt-Bundles wird nicht fest verdrahtet.
log "Asset-Integritaet (md5 aller www-Dateien)"
SRC_MD5="$(cd "$SRC/www" && find . -type f ! -name '*.br' ! -name '*.gz' -print0 | sort -z | xargs -0 md5sum | md5sum | cut -d' ' -f1)"
DST_MD5="$($SSH "$DST_HOST" "cd '$DST/www' && find . -type f ! -name '*.br' ! -name '*.gz' -print0 | sort -z | xargs -0 md5sum | md5sum | cut -d' ' -f1")"
log "Asset-MD5 src=$SRC_MD5 dst=$DST_MD5"
if [ "$SRC_MD5" != "$DST_MD5" ]; then
  rollback
  fail "Assets weichen ab (Drift) - Rollback ausgefuehrt"
fi

log "Deploy OK: Commit $COMMIT live auf Port 9001"
exit 0