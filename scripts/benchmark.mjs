import { chromium } from '@playwright/test'
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { cpus, platform, release } from 'node:os'

// Serve the exact release WASM used by the app, without a dev compiler or UI.
const files = {
  '/engine.js': ['web/src/wasm/tracescope_engine.js', 'text/javascript'],
  '/tracescope_engine_bg.wasm': ['web/src/wasm/tracescope_engine_bg.wasm', 'application/wasm'],
}
const server = createServer(async (req, res) => {
  const entry = files[req.url]
  if (!entry) {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<title>TraceScope benchmark</title>')
    return
  }
  try {
    res.writeHead(200, { 'Content-Type': entry[1] })
    res.end(await readFile(resolve(entry[0])))
  } catch {
    res.writeHead(404)
    res.end()
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  page.on('console', (message) => console.log(`[browser] ${message.text()}`))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  const sizes = process.env.BENCH_MILLION ? [10_000, 100_000, 1_000_000] : [10_000, 100_000]
  const results = await page.evaluate(async (sizes) => {
    const { default: init, Engine } = await import('/engine.js')
    const { memory } = await init()
    const rows = []
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
    const baseNs = 1_780_000_000_000_000_000n
    function batch(offset, count, seed) {
      const spans = []
      for (let i = offset; i < offset + count; i++) {
        const traceId = (BigInt(seed) + BigInt(Math.floor(i / 10)) + 1n)
          .toString(16)
          .padStart(32, '0')
        const n = i % 10
        const start = baseNs + BigInt(Math.floor(i / 10)) * 1_000_000_000n + BigInt(n) * 1_000_000n
        spans.push({
          traceId,
          spanId: (n + 1).toString(16).padStart(16, '0'),
          parentSpanId: n ? '0000000000000001' : '',
          name: n ? 'SELECT product' : 'GET /products',
          startTimeUnixNano: start.toString(),
          endTimeUnixNano: (start + BigInt(n ? 2 : 20) * 1_000_000n).toString(),
          attributes: [{ key: 'synthetic', value: { boolValue: true } }],
          status: { code: i % 99 === 0 ? 2 : 1 },
        })
      }
      return JSON.stringify({
        resourceSpans: [
          {
            resource: {
              attributes: [{ key: 'service.name', value: { stringValue: 'benchmark-service' } }],
            },
            scopeSpans: [{ spans }],
          },
        ],
      })
    }
    for (const size of sizes) {
      const repeats = size === 1_000_000 ? 1 : 5
      for (let run = 0; run < repeats; run++) {
        console.log(`Starting ${size} spans, run ${run + 1}/${repeats}`)
        const engine = new Engine(Date.now())
        engine.set_retention(3_600_000)
        let ingestMs = 0,
          engineIngestMs = 0,
          maxFrameGapMs = 0
        const wallStart = performance.now()
        for (let offset = 0; offset < size; offset += 1000) {
          const frameStart = performance.now()
          const input = batch(offset, Math.min(1000, size - offset), 0)
          const start = performance.now()
          const report = JSON.parse(engine.ingest(input, 'otlp'))
          ingestMs += performance.now() - start
          engineIngestMs += report.durationMs
          if (report.acceptedSpans !== Math.min(1000, size - offset))
            throw new Error('Unexpected rejected benchmark spans')
          await frame()
          maxFrameGapMs = Math.max(maxFrameGapMs, performance.now() - frameStart)
          if (size >= 1_000_000 && (offset + 1000) % 100_000 === 0)
            console.log(`Ingested ${offset + 1000}/${size}`)
        }
        const ingestWallMs = performance.now() - wallStart
        const queryTimes = []
        for (let i = 0; i < 21; i++) {
          const start = performance.now()
          const result = JSON.parse(engine.query(JSON.stringify({ limit: 50, sort: 'slowest' })))
          queryTimes.push(performance.now() - start)
          if (result.total !== size / 10) throw new Error('Trace count mismatch')
        }
        queryTimes.sort((a, b) => a - b)
        const before = JSON.parse(engine.stats())
        const memoryBefore = memory.buffer.byteLength
        engine.pin('00000000000000000000000000000001', true)
        engine.advance_time(3_600_001)
        const expired = JSON.parse(engine.expire())
        const gcStart = performance.now()
        const gc = JSON.parse(engine.collect())
        const gcCallMs = performance.now() - gcStart
        const after = JSON.parse(engine.stats())
        const memoryAfter = memory.buffer.byteLength
        if (gc.reclaimedCount !== size - 10 || after.activeSpans !== 10)
          throw new Error('Pinned lifecycle mismatch')
        engine.ingest(batch(0, 1000, 2_000_000), 'otlp')
        const reused = JSON.parse(engine.stats())
        if (reused.reusedSlots !== 1000) throw new Error('Slot reuse mismatch')
        rows.push({
          spans: size,
          run: run + 1,
          batchSize: 1000,
          ingestMs,
          engineIngestMs,
          ingestWallMs,
          queryMedianMs: queryTimes[10],
          queryP95Ms: queryTimes[19],
          maxFrameGapMs,
          gcMs: gc.durationMs,
          gcCallMs,
          reclaimed: gc.reclaimedCount,
          expiredTraces: expired.expiredTraces,
          arenaCapacity: before.arenaCapacity,
          freeSlotsAfter: after.freeSlots,
          reusedSlots: reused.reusedSlots,
          wasmBytesBefore: memoryBefore,
          wasmBytesAfter: memoryAfter,
        })
        engine.free()
        await frame()
      }
    }
    return rows
  }, sizes)
  const report = {
    measuredAt: new Date().toISOString(),
    environment: {
      os: `${platform()} ${release()}`,
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      node: process.version,
      chromium: browser.version(),
    },
    notes: [
      'Release WASM, main browser thread, 1000-span batches with requestAnimationFrame yields.',
      'Ingest call includes JS/WASM string transfer and report JSON parse; wall time also includes synthetic generation and frame waits.',
      'GC engine duration excludes outer JS call/JSON parse. gcCallMs includes both.',
      'Fresh engine per run; one WASM instance shares monotonic linear memory across runs.',
      'No equivalent JS engine baseline: these measurements do not establish a Rust performance advantage.',
      'Query: 21 samples per run; median index 10 and nearest-rank P95 index 19.',
      'maxFrameGapMs is batch-start to next animation frame, not an input-latency percentile.',
    ],
    results,
  }
  report.wasmSha256 = createHash('sha256')
    .update(await readFile('web/src/wasm/tracescope_engine_bg.wasm'))
    .digest('hex')
  await mkdir('docs/benchmarks', { recursive: true })
  await writeFile('docs/benchmarks/latest.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}
