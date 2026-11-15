/**
 * Zeitfenster des Archivs: wie weit zurueck und wie weit voraus Startdaten
 * geholt werden.
 *
 * Bewusst relativ zu "jetzt" und nicht als zwei feste Daten. Mit festen Daten
 * (28.08.2026 bis 15.11.2026) laeuft das Fenster leer, sobald die Zeit
 * weitergeht - nach fuenf Wochen waere kein vergangener Start mehr enthalten,
 * ohne dass irgendetwas kaputtginge. Genau das ist hier passiert.
 *
 * Die Grenzen liegen auf Tagesgrenzen (UTC). Das sieht in der Kopfzeile
 * sauberer aus und macht den Fensterwechsel vorhersehbar: morgen rutscht das
 * Fenster genau einen Tag weiter.
 */

export const PAST_DAYS = 30
export const FUTURE_DAYS = 14

export const DAY_MS = 86_400_000

/** 00:00 UTC des Tages, in dem der Zeitstempel liegt. */
function startOfUtcDay(ms) {
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

/** Nichtnegative Zahl uebernehmen, sonst die Vorgabe. */
function daysOr(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * Fenster aus der aktuellen Zeit berechnen.
 * @param {number} now Epoch-Millisekunden
 * @param {{pastDays?: number, futureDays?: number}} [options]
 */
export function computeWindow(now, options = {}) {
  const pastDays = daysOr(options.pastDays, PAST_DAYS)
  const futureDays = daysOr(options.futureDays, FUTURE_DAYS)
  const ms = Number.isFinite(now) ? now : Date.now()
  const start = startOfUtcDay(ms)
  return {
    past_from: new Date(start - pastDays * DAY_MS).toISOString(),
    future_to: new Date(start + (futureDays + 1) * DAY_MS - 1).toISOString(),
    past_days: pastDays,
    future_days: futureDays,
  }
}
