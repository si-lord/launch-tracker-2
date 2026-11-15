#!/usr/bin/env node
/**
 * Tests fuer die reine Logik der Skripte (node:test, ohne Zusatz-Dependencies).
 *
 * Geprueft werden die Stellen, die schon einmal still gescheitert sind:
 * das Zeitfenster, die Altersberechnung der Videos und die
 * iCalendar-Erzeugung.
 *
 * Aufruf:  node --test scripts/lib/*.test.mjs scripts/*.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeWindow, PAST_DAYS, FUTURE_DAYS } from './lib/window.mjs'
import { videoAgeRange, ageCompatible, normalize, isGeneric, requiredTokens } from './lib/match-videos.mjs'
import { buildIcs } from './generate-ics.mjs'

/* -------------------------------------------------------------- window.mjs */

test('computeWindow: Fenster laeuft mit der Zeit mit', () => {
  const jetzt = Date.parse('2026-11-15T12:00:00Z')
  const fenster = computeWindow(jetzt)
  assert.equal(fenster.past_days, PAST_DAYS)
  assert.equal(fenster.future_days, FUTURE_DAYS)
  // 30 Tage zurueck, auf Tagesgrenze (UTC) gerundet
  assert.equal(fenster.past_from, '2026-10-16T00:00:00.000Z')
  // 14 Tage voraus, letzter Moment des Tages
  assert.equal(fenster.future_to, '2026-11-29T23:59:59.999Z')
})

test('computeWindow: Fenster verschiebt sich um einen Tag', () => {
  const a = computeWindow(Date.parse('2026-11-15T12:00:00Z'))
  const b = computeWindow(Date.parse('2026-11-16T12:00:00Z'))
  const tageA = (Date.parse(a.past_from) - Date.parse(a.future_to)) / 86400000
  const tageB = (Date.parse(b.past_from) - Date.parse(b.future_to)) / 86400000
  assert.equal(tageA, tageB, 'Die Fenstergroesse bleibt gleich')
  assert.notEqual(a.past_from, b.past_from, 'Der Fensteranfang wandert mit')
})

test('computeWindow: ungueltige Optionen fallen auf die Vorgabe zurueck', () => {
  const fenster = computeWindow(Date.now(), { pastDays: -5, futureDays: Number.NaN })
  assert.equal(fenster.past_days, PAST_DAYS)
  assert.equal(fenster.future_days, FUTURE_DAYS)
})

/* ---------------------------------------------------------- match-videos.mjs */

test('videoAgeRange: exaktes Datum schlaegt die Altersangabe', () => {
  const jetzt = Date.parse('2026-11-15T12:00:00Z')
  const video = {
    published_at: '2026-11-10T00:00:00Z',
    published_hint: '2 years ago',
  }
  const bereich = videoAgeRange(video, jetzt)
  assert.equal(bereich.exact, true)
  // 5 Tage seit dem exakten Datum, mit 3 Tagen Toleranz nach oben
  assert.ok(bereich.lo < 5 && bereich.hi > 5)
})

test('videoAgeRange: Rasterangabe bezieht sich auf den Scrape-Zeitpunkt', () => {
  const jetzt = Date.parse('2026-11-15T12:00:00Z')
  // Video wurde am 01.10. gesehen ("10 days ago"), heute sind 45 Tage spaeter
  const video = {
    published_at: null,
    published_hint: '10 days ago',
    first_seen: '2026-10-01T00:00:00Z',
  }
  const bereich = videoAgeRange(video, jetzt)
  // 10 Tage (Altersangabe) + 45 Tage (seit dem Scraping) = 55 Tage
  const mitte = (bereich.lo + bereich.hi) / 2
  assert.ok(mitte > 40 && mitte < 70, `Alter sollte um 55 Tage liegen, war ${mitte}`)
})

test('videoAgeRange: ohne first_seen bleibt der alte Bezug erhalten', () => {
  const jetzt = Date.parse('2026-11-15T12:00:00Z')
  const video = { published_at: null, published_hint: '10 days ago' }
  const bereich = videoAgeRange(video, jetzt)
  const mitte = (bereich.lo + bereich.hi) / 2
  assert.ok(mitte > 5 && mitte < 20, `Alter sollte um 10 Tage liegen, war ${mitte}`)
})

test('videoAgeRange: ohne jede Zeitangabe gibt es keinen Bereich', () => {
  assert.equal(videoAgeRange({ published_at: null, published_hint: null }, Date.now()), null)
})

test('ageCompatible: Start im Fenster passt, ausserhalb nicht', () => {
  const jetzt = Date.parse('2026-11-15T12:00:00Z')
  const video = { published_at: '2026-11-15T00:00:00Z' }
  assert.equal(ageCompatible(video, 0.5, jetzt), true)
  assert.equal(ageCompatible(video, 40, jetzt), false)
})

test('normalize: fuehrende Nullen und Ordinalendungen verschwinden', () => {
  assert.equal(normalize('Group 04'), 'group 4')
  assert.equal(normalize('13th StriX'), '13 strix')
  assert.equal(normalize('StriX Launch 13'), 'strix launch 13')
})

test('isGeneric: Raketennamen und Fuellwoerter sind generisch', () => {
  for (const wort of ['falcon', 'starship', 'launch', 'group', 'leo']) {
    assert.equal(isGeneric(wort), true, `${wort} sollte generisch sein`)
  }
  for (const wort of ['strix', 'nvs', 'koen', 'yamatsumi']) {
    assert.equal(isGeneric(wort), false, `${wort} sollte NICHT generisch sein`)
  }
})

test('requiredTokens: Zahlen bleiben erhalten, Fuellwoerter fallen weg', () => {
  const tokens = requiredTokens('SatNet LEO Group 26')
  assert.ok(tokens.includes('26'), 'Die 26 muss erhalten bleiben')
  assert.ok(!tokens.includes('leo'), 'LEO ist generisch')
})

/* --------------------------------------------------------- generate-ics.mjs */

const DATENSATZ = {
  meta: {
    generated_at: '2026-11-15T00:00:00Z',
    window: {
      past_from: '2026-10-16T00:00:00.000Z',
      future_to: '2026-11-29T23:59:59.999Z',
    },
  },
  launches: [
    {
      id: 'a1',
      name: 'Falcon 9 Block 5 | USSF-481',
      net: '2026-11-20T17:00:00Z',
      direction: 'future',
      date_is_estimated: false,
      status: 'Go',
      payload: 'USSF-481',
      info_url: 'https://example.com/a1',
      rocket: { name: 'Falcon 9 Block 5', provider: 'SpaceX' },
      launch_site: { name: 'SLC-4E', location: 'Vandenberg', country: 'USA' },
      mission: { name: 'USSF-481', type: 'Government/Top Secret' },
      window: { start: '2026-11-20T16:30:00Z', end: '2026-11-20T18:00:00Z' },
    },
    {
      id: 'a2',
      name: 'Vergangener Start',
      net: '2026-10-20T10:00:00Z',
      direction: 'past',
      rocket: { name: 'Ariane 6', provider: 'ESA' },
      launch_site: { name: 'ELA-4', country: 'FRA' },
    },
  ],
}

test('buildIcs: nur geplante Starts kommen in den Feed', () => {
  const jetzt = Date.parse('2026-11-15T12:00:00Z')
  const ics = buildIcs(DATENSATZ, jetzt)
  const events = ics.match(/BEGIN:VEVENT/g) ?? []
  assert.equal(events.length, 1, 'Nur der zukuenftige Start gehoert in den Feed')
  assert.ok(ics.includes('USSF-481'))
  assert.ok(!ics.includes('Vergangener Start'))
})

test('buildIcs: technische Struktur nach RFC 5545', () => {
  const jetzt = Date.parse('2026-11-15T12:00:00Z')
  const ics = buildIcs(DATENSATZ, jetzt)
  assert.ok(ics.startsWith('BEGIN:VCALENDAR'))
  assert.ok(ics.trimEnd().endsWith('END:VCALENDAR'))
  assert.ok(ics.includes('VERSION:2.0'))
  assert.ok(ics.includes('PRODID:-//launch-tracker//Raketenstarts//DE'))
  assert.ok(ics.includes('UID:a1@launch-tracker.local'))
  assert.ok(ics.includes('DTSTART:20261120T170000Z'))
  assert.ok(ics.includes('DTEND:20261120T180000Z'))
  // CRLF-Zeilenenden
  assert.ok(ics.includes('\r\n'))
})

test('buildIcs: Kommas und Semikolons werden escaped', () => {
  const jetzt = Date.parse('2026-11-15T12:00:00Z')
  const datensatz = {
    ...DATENSATZ,
    launches: [
      {
        ...DATENSATZ.launches[0],
        launch_site: { name: 'SLC-4E', location: 'Vandenberg, CA', country: 'USA' },
      },
    ],
  }
  const ics = buildIcs(datensatz, jetzt)
  assert.ok(ics.includes('Vandenberg\\, CA'), 'Komma muss escaped sein')
  assert.ok(!ics.includes('Vandenberg, CA'), 'Unescapetes Komma darf nicht vorkommen')
})

test('buildIcs: ein leerer Datensatz ergibt einen gueltigen Kalender', () => {
  const ics = buildIcs({ meta: {}, launches: [] }, Date.now())
  assert.ok(ics.startsWith('BEGIN:VCALENDAR'))
  assert.ok(ics.trimEnd().endsWith('END:VCALENDAR'))
  assert.equal((ics.match(/BEGIN:VEVENT/g) ?? []).length, 0)
})
