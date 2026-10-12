import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createEngine,
  type EngineStats,
  type Handle,
  type Metrics,
  type QueryParams,
  type QueryResult,
  type TraceDetail as Detail,
  type TraceEngine,
} from './engine'
import { bytes, duration, errorMessage, number, serviceColor, timestamp } from './format'
import { generateSample } from './sample'
import Icon from './components/Icon'
import TraceDetail from './components/TraceDetail'
import Inspector from './components/Inspector'

const PAGE_SIZE = 8
const MAX_FILE_BYTES = 32 * 1024 * 1024
const nextFrame = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0))
type Notice = { tone: 'success' | 'error' | 'info'; message: string }
type Busy = { label: string; done?: number; total?: number }

export default function App() {
  const [engine, setEngine] = useState<TraceEngine | null>(null)
  const [initError, setInitError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [stats, setStats] = useState<EngineStats | null>(null)
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [queryResult, setQueryResult] = useState<QueryResult>({
    traces: [],
    total: 0,
    offset: 0,
    limit: PAGE_SIZE,
  })
  const [detail, setDetail] = useState<Detail | null>(null)
  const [detailOffset, setDetailOffset] = useState(0)
  const [selectedTrace, setSelectedTrace] = useState<string | null>(null)
  const [selectedHandle, setSelectedHandle] = useState<Handle | null>(null)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [autoCleanup, setAutoCleanup] = useState(true)
  const [search, setSearch] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [service, setService] = useState('')
  const [errorOnly, setErrorOnly] = useState(false)
  const [minDuration, setMinDuration] = useState('')
  const [maxDuration, setMaxDuration] = useState('')
  const [sort, setSort] = useState<QueryParams['sort']>('newest')
  const [page, setPage] = useState(0)
  const [sampleCount, setSampleCount] = useState(1000)
  const [serviceMetricsOpen, setServiceMetricsOpen] = useState(false)
  const [busy, setBusy] = useState<Busy | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [lastOperation, setLastOperation] = useState<{
    label: string
    ms: number
    maxBatchMs?: number
  } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const cancelled = useRef(false)
  const busyRef = useRef(false)
  const refresh = useCallback(() => setRevision((value) => value + 1), [])
  const showError = useCallback((message: string) => setNotice({ tone: 'error', message }), [])
  const showNotice = useCallback((message: string) => setNotice({ tone: 'info', message }), [])

  useEffect(() => {
    let disposed = false
    let instance: TraceEngine | null = null
    void createEngine()
      .then((value) => {
        instance = value
        if (disposed) {
          value.dispose()
          return
        }
        value.ingest(generateSample(120))
        setEngine(value)
      })
      .catch((error: unknown) => {
        if (!disposed) setInitError(errorMessage(error))
      })
    return () => {
      disposed = true
      instance?.dispose()
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearchQuery(search)
      setPage(0)
    }, 180)
    return () => window.clearTimeout(timer)
  }, [search])

  useEffect(() => {
    if (!engine) return
    try {
      setMetrics(engine.metrics())
      setStats(engine.stats())
    } catch (error) {
      showError(errorMessage(error))
    }
  }, [engine, revision, showError])

  useEffect(() => {
    if (!engine) return
    try {
      const params: QueryParams = {
        search: searchQuery,
        service,
        errorOnly,
        sort,
        offset: page * PAGE_SIZE,
        limit: PAGE_SIZE,
      }
      if (minDuration !== '') params.minDurationMs = Number(minDuration)
      if (maxDuration !== '') params.maxDurationMs = Number(maxDuration)
      const result = engine.query(params)
      setQueryResult(result)
      if (page > 0 && result.traces.length === 0) {
        setPage(Math.max(0, Math.ceil(result.total / PAGE_SIZE) - 1))
        return
      }
      setSelectedTrace((current) =>
        result.traces.some((trace) => trace.traceId === current)
          ? current
          : (result.traces[0]?.traceId ?? null),
      )
    } catch (error) {
      setQueryResult({ traces: [], total: 0, offset: 0, limit: PAGE_SIZE })
      setSelectedTrace(null)
      showError(errorMessage(error))
    }
  }, [
    engine,
    revision,
    searchQuery,
    service,
    errorOnly,
    minDuration,
    maxDuration,
    sort,
    page,
    showError,
  ])

  useEffect(() => {
    setDetailOffset(0)
  }, [selectedTrace])

  useEffect(() => {
    if (!engine || !selectedTrace) {
      setDetail(null)
      return
    }
    try {
      setDetail(engine.detail(selectedTrace, detailOffset, 24))
    } catch (error) {
      showError(errorMessage(error))
    }
  }, [engine, selectedTrace, detailOffset, revision, showError])

  useEffect(() => {
    if (!engine || !autoCleanup) return
    const timer = window.setInterval(() => {
      if (busyRef.current) return
      try {
        const result = engine.expire()
        if (result.pendingSpans > 0) engine.collect()
        refresh()
      } catch (error) {
        showError(errorMessage(error))
      }
    }, 10_000)
    return () => window.clearInterval(timer)
  }, [engine, autoCleanup, refresh, showError])

  const importFile = async (file: File) => {
    if (!engine || busyRef.current) return
    if (file.size > MAX_FILE_BYTES) {
      showError(`파일은 최대 32 MiB까지 가져올 수 있습니다. 선택한 파일: ${bytes(file.size)}`)
      return
    }
    if (file.size === 0) {
      showError('빈 파일입니다. resourceSpans가 있는 OTLP JSON 파일을 선택하세요.')
      return
    }
    busyRef.current = true
    setBusy({ label: `${file.name} 가져오는 중` })
    setNotice(null)
    try {
      await nextFrame()
      const content = await file.text()
      const start = performance.now()
      const report = engine.ingest(content, /\.jsonl$/i.test(file.name) ? 'jsonl' : 'otlp')
      setLastOperation({ label: 'Import · JS ↔ WASM', ms: performance.now() - start })
      setNotice({
        tone: report.rejectedSpans > 0 ? 'info' : 'success',
        message: `${file.name}: ${number(report.acceptedSpans)} spans 가져옴 · 중복 ${number(report.duplicateSpans)}개 · 제외 ${number(report.rejectedSpans)}개${report.warnings.length ? ` · ${report.warnings.slice(0, 3).join(' · ')}` : ''}`,
      })
      setSearch('')
      setSearchQuery('')
      setService('')
      setErrorOnly(false)
      setMinDuration('')
      setMaxDuration('')
      setSort('newest')
      setPage(0)
      refresh()
    } catch (error) {
      showError(`가져오지 못했습니다. ${errorMessage(error)}`)
    } finally {
      busyRef.current = false
      setBusy(null)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const runSample = async () => {
    if (!engine || busyRef.current) return
    busyRef.current = true
    cancelled.current = false
    setNotice(null)
    let added = 0
    let maxBatchMs = 0
    const started = performance.now()
    try {
      while (added < sampleCount && !cancelled.current) {
        setBusy({ label: '샘플 트래픽 생성 중', done: added, total: sampleCount })
        await nextFrame()
        if (cancelled.current) break
        const batchStart = performance.now()
        const report = engine.ingest(generateSample(Math.min(250, sampleCount - added)))
        added += report.acceptedSpans
        maxBatchMs = Math.max(maxBatchMs, performance.now() - batchStart)
        if (report.acceptedSpans === 0) throw new Error('생성한 샘플을 가져오지 못했습니다.')
      }
      setLastOperation({
        label: `샘플 ${number(added)} spans · 생성 + ingest + yield`,
        ms: performance.now() - started,
        maxBatchMs,
      })
      setNotice({
        tone: 'success',
        message: `합성 샘플 ${number(added)} spans를 추가했습니다.${cancelled.current ? ' 나머지 생성은 중단했습니다.' : ''} 실제 서비스에서 수집한 데이터가 아닙니다.`,
      })
      setPage(0)
      refresh()
    } catch (error) {
      showError(errorMessage(error))
      refresh()
    } finally {
      busyRef.current = false
      setBusy(null)
    }
  }

  const pin = () => {
    if (!engine || !detail) return
    try {
      engine.pin(detail.traceId, !detail.pinned)
      refresh()
    } catch (error) {
      showError(errorMessage(error))
    }
  }
  const inspect = (handle: Handle) => {
    setSelectedHandle(handle)
    setInspectorOpen(true)
    window.setTimeout(
      () =>
        document
          .querySelector('.inspector')
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      40,
    )
  }
  const resetFilters = () => {
    setSearch('')
    setSearchQuery('')
    setService('')
    setErrorOnly(false)
    setMinDuration('')
    setMaxDuration('')
    setPage(0)
  }
  const filtered =
    search !== '' || service !== '' || errorOnly || minDuration !== '' || maxDuration !== ''

  return (
    <div
      className="app-shell"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault()
          setDragOver(true)
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false)
      }}
      onDrop={(event) => {
        event.preventDefault()
        setDragOver(false)
        const file = event.dataTransfer.files[0]
        if (file) void importFile(file)
      }}
    >
      <header className="topbar">
        <a className="brand" href="#" aria-label="TraceScope 홈">
          <span className="brand-icon">
            <Icon name="trace" size={24} />
          </span>
          <span>
            Trace<span className="brand-light">Scope</span>
          </span>
          <span className="version">v1.0</span>
        </a>
        <div className="topbar-divider" />
        <span className="topbar-context">Local Trace Analyzer</span>
        <div className="topbar-right">
          <span className="local-status">
            <span className="status-dot" />
            LOCAL-FIRST
          </span>
          <span className="rust-badge">
            Rust <span>+</span> WebAssembly
          </span>
        </div>
      </header>
      <main>
        <section className="page-heading">
          <div>
            <div className="eyebrow">
              <span className="tiny-square" />
              OBSERVABILITY, ON YOUR DEVICE
            </div>
            <h1>
              Trace Explorer<span className="heading-dot">.</span>
            </h1>
            <p>
              요청의 흐름을 따라 지연과 오류를 찾으세요. 데이터는 이 브라우저 안에서 처리합니다.
            </p>
          </div>
          <div className="input-actions">
            <input
              ref={fileInput}
              id="import-file"
              data-testid="import-file"
              type="file"
              accept=".json,.jsonl,application/json,application/x-ndjson"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void importFile(file)
              }}
            />
            <button
              className="button import-button"
              disabled={!engine || !!busy}
              onClick={() => fileInput.current?.click()}
            >
              <Icon name="upload" />
              OTLP 가져오기
            </button>
            <div className="sample-actions">
              <select
                aria-label="샘플 Span 수"
                value={sampleCount}
                disabled={!!busy}
                onChange={(event) => setSampleCount(Number(event.target.value))}
              >
                <option value={100}>100 spans</option>
                <option value={1000}>1,000 spans</option>
                <option value={10000}>10,000 spans</option>
                <option value={100000}>100,000 spans</option>
              </select>
              <button
                className="button primary"
                disabled={!engine || !!busy}
                onClick={() => void runSample()}
              >
                <Icon name="play" />
                샘플 실행
              </button>
            </div>
          </div>
        </section>
        <div className="input-hint">
          <Icon name="upload" size={12} />
          <span>OTLP JSON / JSONL · 최대 32 MiB · 파일을 여기에 놓아도 됩니다</span>
          <span className="privacy-hint">
            서버 전송 없음 <span>·</span> 새로고침 시 데이터 초기화
          </span>
        </div>
        {initError && (
          <div className="notice error" role="alert">
            <Icon name="error" />
            <div>
              <strong>WASM 엔진을 시작하지 못했습니다.</strong>
              <p>{initError}</p>
            </div>
            <button className="button small" onClick={() => window.location.reload()}>
              다시 불러오기
            </button>
          </div>
        )}
        {!engine && !initError && (
          <div className="loading-engine" role="status">
            <span className="spinner" />
            Rust / WASM 엔진을 불러오는 중입니다.
          </div>
        )}
        {notice && (
          <div
            className={`notice ${notice.tone}`}
            role={notice.tone === 'error' ? 'alert' : 'status'}
          >
            <Icon
              name={
                notice.tone === 'error' ? 'error' : notice.tone === 'success' ? 'check' : 'layers'
              }
            />
            <p>{notice.message}</p>
            <button className="icon-button" onClick={() => setNotice(null)} aria-label="알림 닫기">
              <Icon name="close" />
            </button>
          </div>
        )}
        {busy && (
          <div className="operation-progress" role="status">
            <span className="spinner" />
            <span>{busy.label}</span>
            {busy.total !== undefined && (
              <>
                <progress max={busy.total} value={busy.done ?? 0} />
                <span className="mono">
                  {number(busy.done ?? 0)} / {number(busy.total)}
                </span>
                <button
                  className="text-button"
                  onClick={() => {
                    cancelled.current = true
                  }}
                >
                  생성 중단
                </button>
              </>
            )}
          </div>
        )}
        <section className="overview" aria-label="Overview">
          <Metric
            label="TOTAL TRACES"
            value={metrics ? number(metrics.totalTraces) : '—'}
            caption="현재 보존 중인 요청"
            icon="trace"
          />
          <Metric
            label="TOTAL SPANS"
            value={metrics ? number(metrics.totalSpans) : '—'}
            caption={`${metrics?.totalServices ?? 0}개 서비스의 호출`}
            icon="layers"
          />
          <Metric
            label="P50 LATENCY"
            value={duration(metrics?.p50Ms)}
            caption={
              metrics?.sampleSize
                ? `요청 ${number(metrics.sampleSize)}건 · nearest-rank`
                : '표본 없음'
            }
            icon="clock"
          />
          <Metric
            label="P95 LATENCY"
            value={duration(metrics?.p95Ms)}
            caption={`P99 ${duration(metrics?.p99Ms)}${(metrics?.sampleSize ?? 0) < 100 ? ' · 소표본' : ''}`}
            icon="clock"
          />
          <Metric
            label="ERROR RATE"
            value={
              metrics?.errorRate === null || metrics?.errorRate === undefined
                ? '—'
                : `${(metrics.errorRate * 100).toFixed(1)}%`
            }
            caption="오류 Span이 있는 요청 비율"
            icon="error"
            error={(metrics?.errorRate ?? 0) > 0}
          />
        </section>
        {metrics && metrics.services.length > 0 && (
          <section className="service-strip" aria-label="서비스별 집계">
            <span className="service-strip-label">SERVICES</span>
            {metrics.services.slice(0, 16).map((item) => (
              <button
                key={item.serviceName}
                className={`service-chip ${service === item.serviceName ? 'active' : ''}`}
                title={`${number(item.spanCount)} spans · 오류 ${number(item.errorCount)}개 · 평균 ${duration(item.totalDurationMs / item.spanCount)} · 최대 ${duration(item.maxDurationMs)}`}
                onClick={() => {
                  setService(service === item.serviceName ? '' : item.serviceName)
                  setPage(0)
                }}
              >
                <i style={{ background: serviceColor(item.serviceName) }} />
                {item.serviceName}
                <span>{number(item.spanCount)}</span>
              </button>
            ))}
            {metrics.services.length > 16 && (
              <span className="muted">+{metrics.services.length - 16}개 · 필터에서 선택</span>
            )}
          </section>
        )}
        {metrics && metrics.services.length > 0 && (
          <div className="service-metrics">
            <button
              className="text-button"
              aria-expanded={serviceMetricsOpen}
              onClick={() => setServiceMetricsOpen(!serviceMetricsOpen)}
            >
              서비스 집계 {serviceMetricsOpen ? '접기' : '보기'}
              <Icon
                name="chevron"
                size={11}
                style={{ transform: serviceMetricsOpen ? 'rotate(90deg)' : '' }}
              />
            </button>
            {serviceMetricsOpen && (
              <div className="service-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>서비스</th>
                      <th>Spans</th>
                      <th>오류 Spans</th>
                      <th>평균 Duration</th>
                      <th>최대 Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.services.map((item) => (
                      <tr key={item.serviceName}>
                        <td>
                          <i style={{ background: serviceColor(item.serviceName) }} />
                          {item.serviceName}
                        </td>
                        <td>{number(item.spanCount)}</td>
                        <td className={item.errorCount ? 'text-error' : ''}>
                          {number(item.errorCount)}
                        </td>
                        <td>{duration(item.totalDurationMs / item.spanCount)}</td>
                        <td>{duration(item.maxDurationMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p>
                  Span의 포함 시간을 기준으로 계산합니다. 병렬 호출 시간은 합쳐서 요청 지연으로
                  해석하지 않습니다.
                  {metrics.totalServices > metrics.services.length
                    ? ` 전체 ${number(metrics.totalServices)}개 중 상위 ${metrics.services.length}개 서비스 표시.`
                    : ''}
                </p>
              </div>
            )}
          </div>
        )}
        <div className="workspace">
          <section className="panel explorer-panel" aria-label="Trace 목록">
            <div className="explorer-heading">
              <h2>
                트레이스 <span>{number(queryResult.total)}</span>
              </h2>
              <span className="live-label">
                <span className="status-dot" />
                ENGINE QUERY
              </span>
            </div>
            <div className="explorer-filters">
              <div className="search-input">
                <Icon name="search" />
                <input
                  aria-label="서비스, Operation, Trace ID 검색"
                  placeholder="서비스, Operation, Trace ID 검색"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                {search && (
                  <button
                    className="icon-button"
                    aria-label="검색 초기화"
                    onClick={() => setSearch('')}
                  >
                    <Icon name="close" size={14} />
                  </button>
                )}
              </div>
              <div className="filter-row">
                <select
                  aria-label="서비스 필터"
                  value={service}
                  onChange={(event) => {
                    setService(event.target.value)
                    setPage(0)
                  }}
                >
                  <option value="">모든 서비스</option>
                  {metrics?.services.map((item) => (
                    <option key={item.serviceName}>{item.serviceName}</option>
                  ))}
                </select>
                <select
                  aria-label="정렬"
                  value={sort}
                  onChange={(event) => {
                    setSort(event.target.value as QueryParams['sort'])
                    setPage(0)
                  }}
                >
                  <option value="newest">최신 시작순</option>
                  <option value="oldest">오래된 시작순</option>
                  <option value="slowest">가장 느린순</option>
                  <option value="fastest">가장 빠른순</option>
                </select>
              </div>
              <div className="duration-filter">
                <Icon name="clock" size={13} />
                <input
                  aria-label="최소 Duration (ms)"
                  type="number"
                  min="0"
                  placeholder="최소"
                  value={minDuration}
                  onChange={(event) => {
                    setMinDuration(event.target.value)
                    setPage(0)
                  }}
                />
                <span>—</span>
                <input
                  aria-label="최대 Duration (ms)"
                  type="number"
                  min="0"
                  placeholder="최대"
                  value={maxDuration}
                  onChange={(event) => {
                    setMaxDuration(event.target.value)
                    setPage(0)
                  }}
                />
                <span>ms</span>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={errorOnly}
                    onChange={(event) => {
                      setErrorOnly(event.target.checked)
                      setPage(0)
                    }}
                  />
                  <span>오류만</span>
                </label>
              </div>
              {minDuration !== '' &&
                maxDuration !== '' &&
                Number(minDuration) > Number(maxDuration) && (
                  <p className="filter-warning">최대 Duration이 최솟값보다 작습니다.</p>
                )}
            </div>
            <div className="trace-list-label">
              <span>REQUEST / TRACE ID</span>
              <span>DURATION</span>
            </div>
            <div className="trace-list" aria-live="polite">
              {queryResult.traces.map((trace) => (
                <button
                  className={`trace-row ${selectedTrace === trace.traceId ? 'selected' : ''}`}
                  key={trace.traceId}
                  onClick={() => setSelectedTrace(trace.traceId)}
                  aria-label={`Trace ${trace.operationName} ${trace.traceId.slice(-8)}`}
                  aria-pressed={selectedTrace === trace.traceId}
                >
                  <span className="trace-row-top">
                    <span className={`status-dot ${trace.error ? 'error' : ''}`} />
                    <strong>{trace.operationName}</strong>
                    <b className={`mono ${trace.durationMs > 500 ? 'text-amber' : ''}`}>
                      {duration(trace.durationMs)}
                    </b>
                  </span>
                  <span className="trace-row-id">
                    <code>{trace.traceId.slice(-16)}</code>
                    {trace.pinned && <Icon name="pin" size={12} />}
                    <span>{timestamp(trace.startTimeNs)}</span>
                  </span>
                  <span className="trace-row-footer">
                    <span>
                      {trace.spanCount} spans <span>·</span> {trace.services.length} services
                    </span>
                    <span className="row-tags">
                      {trace.sample && <span className="sample-tag">SAMPLE</span>}
                      {trace.error && <span className="error-tag">ERROR</span>}
                      {trace.missingParents > 0 && (
                        <span title="부모 누락" className="text-amber">
                          <Icon name="error" size={12} />
                        </span>
                      )}
                    </span>
                  </span>
                </button>
              ))}
              {queryResult.traces.length === 0 && engine && (
                <div className="empty-list">
                  <Icon name="search" size={28} />
                  <h3>{filtered ? '검색 결과가 없습니다' : '보존 중인 트레이스가 없습니다'}</h3>
                  <p>
                    {filtered
                      ? '검색어나 Duration 범위를 조정해 보세요.'
                      : 'OTLP 파일을 가져오거나 샘플 트래픽을 실행하세요.'}
                  </p>
                  {filtered && (
                    <button className="button small subtle" onClick={resetFilters}>
                      필터 초기화
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="trace-pagination">
              <span>
                {queryResult.total
                  ? `${number(page * PAGE_SIZE + 1)}–${number(Math.min((page + 1) * PAGE_SIZE, queryResult.total))}`
                  : '0'}{' '}
                / {number(queryResult.total)}
              </span>
              <div>
                <button
                  className="icon-button"
                  aria-label="이전 트레이스 페이지"
                  disabled={page === 0}
                  onClick={() => setPage(page - 1)}
                >
                  <Icon name="chevron" style={{ transform: 'rotate(180deg)' }} />
                </button>
                <span>{page + 1}</span>
                <button
                  className="icon-button"
                  aria-label="다음 트레이스 페이지"
                  disabled={(page + 1) * PAGE_SIZE >= queryResult.total}
                  onClick={() => setPage(page + 1)}
                >
                  <Icon name="chevron" />
                </button>
              </div>
            </div>
          </section>
          <TraceDetail
            detail={detail}
            busy={!!busy}
            onPin={pin}
            onInspect={inspect}
            onPage={setDetailOffset}
          />
        </div>
        {engine && stats && (
          <Inspector
            engine={engine}
            stats={stats}
            revision={revision}
            open={inspectorOpen}
            onOpen={setInspectorOpen}
            selectedHandle={selectedHandle}
            onRefresh={refresh}
            onError={showError}
            onNotice={showNotice}
            autoCleanup={autoCleanup}
            onAutoCleanup={setAutoCleanup}
          />
        )}
        <footer className="app-footer">
          <span>
            <span className="status-dot" />
            {engine ? 'Rust engine ready' : 'Initializing engine'}
            <span className="footer-separator">/</span>데이터는 브라우저 세션에만 보관됩니다.
          </span>
          <span>
            {lastOperation
              ? `${lastOperation.label} ${duration(lastOperation.ms)}${lastOperation.maxBatchMs !== undefined ? ` · 최장 배치 ${duration(lastOperation.maxBatchMs)}` : ''}`
              : 'OTLP / JSONL · Generational Arena · Mark-and-Sweep'}
          </span>
        </footer>
      </main>
      {dragOver && (
        <div className="drop-overlay">
          <Icon name="upload" size={42} />
          <h2>트레이스 파일을 놓으세요</h2>
          <p>OTLP JSON 또는 JSONL · 최대 32 MiB</p>
        </div>
      )}
    </div>
  )
}

function Metric({
  label,
  value,
  caption,
  icon,
  error,
}: {
  label: string
  value: string
  caption: string
  icon: 'trace' | 'layers' | 'clock' | 'error'
  error?: boolean
}) {
  return (
    <div className={`metric-card ${error ? 'error-metric' : ''}`}>
      <div className="metric-label">
        <span>{label}</span>
        <Icon name={icon} size={16} />
      </div>
      <strong className="metric-value mono">{value}</strong>
      <span className="metric-caption">{caption}</span>
    </div>
  )
}
