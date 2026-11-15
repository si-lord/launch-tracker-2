#!/usr/bin/env node
/**
 * Precompress fuer den Live-Working-Tree (CT 11133).
 * Zielverzeichnis: www/ (die ausgelieferten Assets).
 * Das ist die Source-of-Truth fuer den Deploy.
 */
import { readFile, writeFile, stat, readdir, rm, rename } from 'node:fs/promises'
import { join, resolve, extname, dirname } from 'node:path'
import { createBrotliCompress, createGzip, brotliDecompressSync, gunzipSync, constants as zlibConstants } from 'node:zlib'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const WWW = resolve(ROOT, 'www')

const COMPRESSIBLE = new Set([
  '.html', '.js', '.mjs', '.css', '.svg', '.json', '.webmanifest', '.ics', '.txt'
])
const BROTLI_QUALITY = 11
const GZIP_LEVEL = 9

const CHECK = process.argv.includes('--check')
const CLEAN = process.argv.includes('--clean')

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return null
  const value = process.argv[index + 1]
  return value && !value.startsWith('--') ? value : null
}

async function hashFile(path) {
  const data = await readFile(path)
  return createHash('sha256').update(data).digest('hex').slice(0, 12)
}

async function compressFile(rawPath, ext) {
  const data = await readFile(rawPath)
  const target = rawPath + ext
  let compressed
  if (ext === '.br') {
    compressed = await new Promise((resolve, reject) => {
      const b = createBrotliCompress({ params: { [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } })
      const chunks = []
      b.on('data', c => chunks.push(c))
      b.on('end', () => resolve(Buffer.concat(chunks)))
      b.on('error', reject)
      b.end(data)
    })
  } else {
    compressed = await new Promise((resolve, reject) => {
      const g = createGzip({ level: GZIP_LEVEL })
      const chunks = []
      g.on('data', c => chunks.push(c))
      g.on('end', () => resolve(Buffer.concat(chunks)))
      g.on('error', reject)
      g.end(data)
    })
  }
  const tmp = target + '.tmp-' + process.pid
  await writeFile(tmp, compressed)
  await rm(target, { force: true }).catch(() => {})
  await rename(tmp, target)
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await walk(full))
    } else {
      files.push(full)
    }
  }
  return files
}

function verifySidecar(rawPath, sidePath) {
  try {
    const raw = readFile(rawPath)
    const side = readFile(sidePath)
    let decompressed
    if (sidePath.endsWith('.br')) {
      decompressed = brotliDecompressSync(side)
    } else {
      decompressed = gunzipSync(side)
    }
    return decompressed.equals(raw)
  } catch {
    return false
  }
}

async function main() {
  let allFiles
  try {
    allFiles = await walk(WWW)
  } catch (e) {
    console.error(`[precompress] FEHLER: Verzeichnis ${WWW} nicht gefunden:`, e.message)
    process.exit(2)
  }

  const compressible = allFiles.filter(f => COMPRESSIBLE.has(extname(f).toLowerCase()))
  let errors = 0
  let created = 0
  let checked = 0

  for (const raw of compressible) {
    const br = raw + '.br'
    const gz = raw + '.gz'

    if (CLEAN) {
      for (const side of [br, gz]) {
        try {
          const s = await stat(side)
          if (s.isFile()) {
            await rm(side, { force: true })
            console.log(`[precompress] Entfernt: ${side.slice(WWW.length + 1)}`)
          }
        } catch {}
      }
      continue
    }

    if (!CHECK) {
      try {
        await compressFile(raw, '.br')
        await compressFile(raw, '.gz')
        created += 2
        const base = raw.slice(WWW.length + 1)
        const h = await hashFile(raw)
        const hbr = await hashFile(br)
        const hgz = await hashFile(gz)
        console.log(`[precompress] ${base} -> .br .gz (sha256: ${h} / ${hbr} / ${hgz})`)
      } catch (e) {
        console.error(`[precompress] FEHLER bei ${raw}:`, e.message)
        errors++
      }
    }

    if (CHECK) {
      let rawStat
      try { rawStat = await stat(raw) } catch { console.error(`[precompress] Prueffehler: ${raw} fehlt`); errors++; continue }
      for (const [label, extPath] of [['.br', br], ['.gz', gz]]) {
        let sideStat
        try { sideStat = await stat(extPath) } catch { console.error(`[precompress] Prueffehler: ${extPath} fehlt zu ${raw}`); errors++; continue }
        if (sideStat.mtimeMs < rawStat.mtimeMs) {
          console.error(`[precompress] Prueffehler: ${extPath} aelter als ${raw} (stale)`)
          errors++
          continue
        }
        const rawData = await readFile(raw)
        const sideData = await readFile(extPath)
        let decompressed
        if (extPath.endsWith('.br')) {
          decompressed = brotliDecompressSync(sideData)
        } else {
          decompressed = gunzipSync(sideData)
        }
        if (!decompressed.equals(rawData)) {
          console.error(`[precompress] Prueffehler: ${extPath} enthaelt andere Daten nach Dekompression`)
          errors++
          continue
        }
        checked++
      }
    }
  }

  if (CHECK) {
    if (errors === 0) {
      console.log(`[precompress] OK: ${checked} Sidecars geprueft, alle frisch und Inhalt-konsistent.`)
      process.exit(0)
    } else {
      console.error(`[precompress] FAIL: ${errors} Prueffehler.`)
      process.exit(1)
    }
  }

  if (CLEAN) {
    console.log('[precompress] Clean fertig.')
    process.exit(0)
  }

  console.log(`[precompress] Fertig: ${created} Sidecars erzeugt, ${errors} Fehler.`)
  process.exit(errors > 0 ? 2 : 0)
}

main().catch((e) => {
  console.error('[precompress] Unerwarteter Fehler:', e)
  process.exit(2)
})