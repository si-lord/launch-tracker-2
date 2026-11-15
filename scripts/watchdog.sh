#!/usr/bin/env bash
# Watchdog fuer den Launch-Tracker (CT 11119, Port 9001).
#
# Muster wie beim solar-system-Watchdog auf derselben Maschine:
#   - Health antwortet mit 200  -> alles gut, nichts tun
#   - Health antwortet mit 503  -> Daten veraltet (Cron haengt) -> Dienst neu starten
#   - Health antwortet gar nicht -> Dienst tot -> Dienst neu starten
#
# Der Health-Endpunkt meldet seit 2026-11-15 503, wenn die Startdaten aelter
# als 6 h oder die Video-Zuordnung aelter als 12 h ist. Genau das war vorher
# unsichtbar: der Ausfall der Video-Kette lief eine Woche lang unbemerkt.
#
# Aufruf:  bash /home/silord/WebServer/launch-tracker-2/scripts/watchdog.sh
# Exit:    0 = gesund, 1 = Stoerung (Dienst wurde neu gestartet)
set -uo pipefail

PORT="${LT_PORT:-9001}"
SERVICE="${LT_SERVICE:-launch-tracker-2.service}"
URL="http://127.0.0.1:${PORT}/api/health"
LOG_TAG="launch-tracker-watchdog"

log() { logger -t "$LOG_TAG" "$*"; printf '%s | %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

CODE="$(curl -s -o /tmp/lt-health.json -w '%{http_code}' --max-time 10 "$URL" 2>/dev/null || echo 000)"

if [ "$CODE" = "200" ]; then
  AGE="$(python3 -c "
import json
try:
    d = json.load(open('/tmp/lt-health.json'))
    print(d.get('dataAgeSeconds', '?'))
except Exception:
    print('?')
" 2>/dev/null)"
  log "gesund (HTTP $CODE, Daten ${AGE}s alt)"
  exit 0
fi

# Stoerung: Grund herausfinden, damit der Log nicht nur "restart" sagt
HINT="$(python3 -c "
import json
try:
    d = json.load(open('/tmp/lt-health.json'))
    print(d.get('hint') or d.get('stale') or 'unbekannt')
except Exception:
    print('keine Antwort')
" 2>/dev/null)"

log "STOERUNG: HTTP $CODE - $HINT"
log "starte $SERVICE neu"

if systemctl restart "$SERVICE" 2>/dev/null; then
  sleep 5
  NEW="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$URL" 2>/dev/null || echo 000)"
  if [ "$NEW" = "200" ]; then
    log "Wiederherstellung erfolgreich (HTTP $NEW)"
    exit 1
  fi
  log "Neustart durchgefuehrt, Health meldet weiterhin HTTP $NEW"
  exit 1
fi

log "Neustart FEHLGESCHLAGEN"
exit 1
