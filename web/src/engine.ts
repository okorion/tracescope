import init, { Engine as WasmEngine } from './wasm/tracescope_engine'

export interface Handle {
  index: number
  generation: number
}
export interface TraceSummary {
  traceId: string
  operationName: string
  services: string[]
  startTimeNs: string
  durationMs: number
  spanCount: number
  error: boolean
  pinned: boolean
  expiresInMs: number
  sample: boolean
  missingParents: number
}
export interface QueryParams {
  search?: string
  service?: string
  operation?: string
  errorOnly?: boolean
  minDurationMs?: number
  maxDurationMs?: number
  sort?: 'newest' | 'oldest' | 'slowest' | 'fastest'
  offset?: number
  limit?: number
}
export interface QueryResult {
  traces: TraceSummary[]
  total: number
  offset: number
  limit: number
}
export interface SpanDetail {
  handle: Handle
  traceId: string
  spanId: string
  parentSpanId: string | null
  serviceName: string
  operationName: string
  startTimeNs: string
  endTimeNs: string
  offsetMs: number
  durationMs: number
  status: string
  depth: number
  attributes: unknown
  resourceAttributes: unknown
  resourceMetadata: unknown
  scope: unknown
  events: unknown[]
  links: unknown[]
  metadata: unknown
  childCount: number
  children: Handle[]
  parent: Handle | null
  missingParent: boolean
}
export interface TraceDetail extends TraceSummary {
  spans: SpanDetail[]
  totalSpans: number
  truncated: boolean
  roots: Handle[]
  rootCount: number
  offset: number
  limit: number
  errorSpanCount: number
  slowestChildSpan: {
    spanId: string
    serviceName: string
    operationName: string
    durationMs: number
    handle: Handle
  } | null
}
export interface ServiceMetric {
  serviceName: string
  spanCount: number
  errorCount: number
  totalDurationMs: number
  maxDurationMs: number
}
export interface Metrics {
  totalTraces: number
  totalSpans: number
  p50Ms: number | null
  p95Ms: number | null
  p99Ms: number | null
  errorRate: number | null
  services: ServiceMetric[]
  sampleSize: number
  totalServices: number
}
export interface EngineStats {
  activeSpans: number
  indexedSpans: number
  totalTraces: number
  arenaSlotCount: number
  arenaCapacity: number
  freeSlots: number
  retiredSlots: number
  totalAllocations: number
  reusedSlots: number
  gcCollections: number
  lastGcDurationMs: number
  lastReclaimedCount: number
  cumulativeReclaimedCount: number
  retentionMs: number
  engineTimeMs: number
  demoOffsetMs: number
  expiredPendingSpans: number
  wasmMemoryBytes: number
  arenaSlotBytesEstimate: number
}
export interface SlotInfo {
  index: number
  generation: number
  occupied: boolean
  state: 'occupied' | 'marked' | 'reclaimed' | 'free' | 'retired'
  handleValid: boolean
  spanId: string | null
  traceId: string | null
  parent: Handle | null
  children: Handle[]
  lastReclaimedCollection: number | null
  childCount: number
}
export interface SlotPage {
  slots: SlotInfo[]
  total: number
  offset: number
  limit: number
}
export interface IngestReport {
  acceptedSpans: number
  duplicateSpans: number
  rejectedSpans: number
  traceCount: number
  warnings: string[]
  durationMs: number
}
export interface ExpireReport {
  expiredTraces: number
  pendingSpans: number
}
export interface GcReport {
  beforeActiveSpans: number
  afterActiveSpans: number
  reclaimedCount: number
  markedCount: number
  freeSlotsBefore: number
  freeSlotsAfter: number
  durationMs: number
  collection: number
}

/** Rust owns trace data; this adapter only transfers bounded view DTOs. */
export class TraceEngine {
  private constructor(
    private readonly raw: WasmEngine,
    private readonly memory: WebAssembly.Memory,
  ) {}
  static async create(): Promise<TraceEngine> {
    const exports = await init()
    return new TraceEngine(new WasmEngine(Date.now()), exports.memory)
  }
  ingest(input: string, format: 'otlp' | 'jsonl' = 'otlp'): IngestReport {
    return JSON.parse(this.raw.ingest(input, format)) as IngestReport
  }
  query(params: QueryParams = {}): QueryResult {
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'number' && (!Number.isFinite(value) || value < 0))
        throw new Error(`${key}: 0 이상의 유한한 숫자가 필요합니다.`)
    }
    if (params.offset !== undefined) integer(params.offset, 'offset')
    if (params.limit !== undefined) integer(params.limit, 'limit')
    return JSON.parse(this.raw.query(JSON.stringify(params))) as QueryResult
  }
  detail(traceId: string, offset = 0, limit = 2000): TraceDetail | null {
    integer(offset, 'offset')
    integer(limit, 'limit')
    type RawSpan = Omit<SpanDetail, 'resourceAttributes' | 'resourceMetadata' | 'scope'> & {
      resourceIndex: number
      scopeIndex: number
    }
    type RawDetail = Omit<TraceDetail, 'spans'> & {
      spans: RawSpan[]
      resources: { attributes: unknown; metadata: unknown }[]
      scopes: unknown[]
    }
    const result = JSON.parse(this.raw.detail_page(traceId, offset, limit)) as RawDetail | null
    if (!result) return null
    const { resources, scopes, ...detail } = result
    return {
      ...detail,
      spans: detail.spans.map(({ resourceIndex, scopeIndex, ...span }) => ({
        ...span,
        resourceAttributes: resources[resourceIndex]?.attributes,
        resourceMetadata: resources[resourceIndex]?.metadata,
        scope: scopes[scopeIndex],
      })),
    }
  }
  metrics(): Metrics {
    return JSON.parse(this.raw.metrics()) as Metrics
  }
  pin(traceId: string, pinned: boolean): boolean {
    return this.raw.pin(traceId, pinned)
  }
  setRetention(ms: number): void {
    this.raw.set_retention(ms)
  }
  advanceTime(ms: number): void {
    this.raw.advance_time(ms)
  }
  expire(): ExpireReport {
    return JSON.parse(this.raw.expire()) as ExpireReport
  }
  collect(): GcReport {
    return JSON.parse(this.raw.collect()) as GcReport
  }
  stats(): EngineStats {
    const stats = JSON.parse(this.raw.stats()) as EngineStats
    // Read buffer on every call: memory.grow replaces previous JS ArrayBuffer views.
    stats.wasmMemoryBytes = this.memory.buffer.byteLength
    return stats
  }
  slots(offset = 0, limit = 1024): SlotPage {
    integer(offset, 'offset')
    integer(limit, 'limit')
    return JSON.parse(this.raw.slots(offset, limit)) as SlotPage
  }
  inspect(handle: Handle): SlotInfo | null {
    integer(handle.index, 'index')
    integer(handle.generation, 'generation')
    return JSON.parse(this.raw.inspect(handle.index, handle.generation)) as SlotInfo | null
  }
  dispose(): void {
    this.raw.free()
  }
}

export const createEngine = TraceEngine.create

function integer(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
    throw new Error(`${name}: uint32 정수가 필요합니다.`)
}
