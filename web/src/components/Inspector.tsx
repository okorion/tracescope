import { useEffect, useRef, useState } from 'react'
import type { EngineStats, GcReport, Handle, SlotInfo, TraceEngine } from '../engine'
import { bytes, duration, errorMessage, number } from '../format'
import Icon from './Icon'

const SLOT_PAGE = 1024
const slotColors: Record<SlotInfo['state'], string> = {
  occupied: '#548adb',
  marked: '#39cfa8',
  free: '#26313f',
  reclaimed: '#b88bee',
  retired: '#ec8c70',
}
type Props = {
  engine: TraceEngine
  stats: EngineStats
  revision: number
  open: boolean
  onOpen: (open: boolean) => void
  selectedHandle: Handle | null
  onRefresh: () => void
  onError: (message: string) => void
  onNotice: (message: string) => void
  autoCleanup: boolean
  onAutoCleanup: (enabled: boolean) => void
}

export default function Inspector({
  engine,
  stats,
  revision,
  open,
  onOpen,
  selectedHandle,
  onRefresh,
  onError,
  onNotice,
  autoCleanup,
  onAutoCleanup,
}: Props) {
  const [slotPage, setSlotPage] = useState(0)
  const [slots, setSlots] = useState<SlotInfo[]>([])
  const [handle, setHandle] = useState<Handle | null>(null)
  const [slot, setSlot] = useState<SlotInfo | null>(null)
  const [slotInput, setSlotInput] = useState('0')
  const [lastGc, setLastGc] = useState<{
    result: GcReport
    callMs: number
    beforeMemory: number
    afterMemory: number
  } | null>(null)
  useEffect(() => {
    if (selectedHandle) {
      setHandle(selectedHandle)
      setSlotInput(String(selectedHandle.index))
      setSlotPage(Math.floor(selectedHandle.index / SLOT_PAGE))
    }
  }, [selectedHandle])
  useEffect(() => {
    if (!open) return
    try {
      setSlots(engine.slots(slotPage * SLOT_PAGE, SLOT_PAGE).slots)
      setSlot(handle ? engine.inspect(handle) : null)
    } catch (error) {
      onError(errorMessage(error))
    }
  }, [engine, revision, open, slotPage, handle, onError])
  const action = (fn: () => void) => {
    try {
      fn()
      onRefresh()
    } catch (error) {
      onError(errorMessage(error))
    }
  }
  const pick = (value: SlotInfo) => {
    setHandle({ index: value.index, generation: value.generation })
    setSlotInput(String(value.index))
  }
  const collect = () =>
    action(() => {
      const beforeMemory = engine.stats().wasmMemoryBytes
      const started = performance.now()
      const result = engine.collect()
      const callMs = performance.now() - started
      setLastGc({ result, callMs, beforeMemory, afterMemory: engine.stats().wasmMemoryBytes })
      onNotice(
        `GC #${result.collection}: Span ${number(result.reclaimedCount)}개 회수 · Free Slot ${number(result.freeSlotsAfter)}개`,
      )
    })
  const metrics: [string, string, string][] = [
    ['Active Spans', number(stats.activeSpans), 'Arena에 실제로 살아 있는 객체'],
    [
      'Arena Capacity',
      number(stats.arenaCapacity),
      `생성된 슬롯 ${number(stats.arenaSlotCount)}개`,
    ],
    ['Free Slots', number(stats.freeSlots), '다음 할당에서 재사용할 슬롯'],
    ['Total Allocations', number(stats.totalAllocations), '엔진 시작 이후 할당 횟수'],
    ['Reused Slots', number(stats.reusedSlots), 'Free List에서 재사용한 횟수'],
    ['GC Collections', number(stats.gcCollections), '완료한 Mark-and-Sweep 횟수'],
    ['Last GC', duration(stats.lastGcDurationMs), 'Rust GC 단계 내부 경과 시간'],
    ['Last Reclaimed', number(stats.lastReclaimedCount), '마지막 GC에서 회수한 객체'],
    ['Total Reclaimed', number(stats.cumulativeReclaimedCount), '누적 회수한 객체'],
    ['WASM Memory', bytes(stats.wasmMemoryBytes), '현재 memory.buffer.byteLength'],
  ]
  return (
    <section className={`panel inspector ${open ? 'expanded' : ''}`} aria-label="Memory Inspector">
      <button
        className="inspector-toggle"
        onClick={() => onOpen(!open)}
        aria-expanded={open}
        aria-controls="inspector-content"
      >
        <span className="inspector-mark">
          <Icon name="memory" size={20} />
        </span>
        <span className="inspector-title">
          <strong>Rust / WASM Memory Inspector</strong>
          <span>실제 객체의 저장, 회수, 재사용을 확인하세요.</span>
        </span>
        <span className="inspector-compact">
          <span className="status-dot" />
          {number(stats.activeSpans)} spans
          <span className="divider" />
          {bytes(stats.wasmMemoryBytes)}
        </span>
        <Icon name="chevron" style={{ transform: open ? 'rotate(90deg)' : '' }} />
      </button>
      {open && (
        <div id="inspector-content" className="inspector-content">
          <div className="engine-flow">
            <span>선택한 Span</span>
            <Icon name="arrow" size={13} />
            <span>
              Handle <code>index:generation</code>
            </span>
            <Icon name="arrow" size={13} />
            <span>Arena Slot</span>
            <Icon name="arrow" size={13} />
            <span>Mark → Sweep → Reuse</span>
            <b>LIVE ENGINE DATA</b>
          </div>
          <div className="inspector-metrics">
            {metrics.map(([label, value, explanation]) => (
              <div key={label} title={explanation}>
                <span>{label}</span>
                <strong className="mono">{value}</strong>
                <small>{explanation}</small>
              </div>
            ))}
          </div>
          <div className="gc-controls">
            <div className="control-group">
              <label htmlFor="retention">Retention Window</label>
              <select
                id="retention"
                value={stats.retentionMs}
                onChange={(event) =>
                  action(() => {
                    engine.setRetention(Number(event.target.value))
                    onNotice('Retention을 변경했습니다. 만료 적용 또는 GC 실행 시 정리합니다.')
                  })
                }
              >
                <option value={60_000}>1분</option>
                <option value={300_000}>5분</option>
                <option value={900_000}>15분</option>
                <option value={3_600_000}>1시간</option>
                {![60_000, 300_000, 900_000, 3_600_000].includes(stats.retentionMs) && (
                  <option value={stats.retentionMs}>{stats.retentionMs / 1000}초</option>
                )}
              </select>
            </div>
            <label className="checkbox auto-clean">
              <input
                type="checkbox"
                checked={autoCleanup}
                onChange={(event) => onAutoCleanup(event.target.checked)}
              />
              <span>
                자동 만료 + GC <small>10초마다 확인</small>
              </span>
            </label>
            <div className="gc-actions">
              <button
                className="button small subtle"
                onClick={() =>
                  action(() => {
                    onAutoCleanup(false)
                    engine.advanceTime(300_000)
                    onNotice(
                      '엔진 시간만 5분 진행했습니다. 단계별 확인을 위해 자동 정리를 껐습니다.',
                    )
                  })
                }
              >
                <Icon name="clock" />
                엔진 시간 +5분
              </button>
              <button
                className="button small subtle"
                onClick={() =>
                  action(() => {
                    const result = engine.expire()
                    onNotice(
                      `${number(result.expiredTraces)}개 Trace의 검색 인덱스와 Root를 제거했습니다. 객체는 GC에서 회수합니다.`,
                    )
                  })
                }
              >
                만료만 적용
              </button>
              <button className="button small primary" onClick={collect}>
                <Icon name="refresh" />
                GC 실행
              </button>
            </div>
          </div>
          <p className="inspector-note">
            마지막 입력 시점부터 보존합니다. Pin한 Trace는 만료되지 않습니다. 만료 시 검색 인덱스와
            Root가 제거되고, GC 시 실제 객체를 회수합니다.{' '}
            <span>
              엔진 시간 +{Math.round(stats.demoOffsetMs / 1000)}초 · 회수 대기{' '}
              {number(stats.expiredPendingSpans)} spans
            </span>
          </p>
          {lastGc && (
            <div className="gc-result" role="status">
              <span className="gc-result-title">
                <Icon name="check" />
                GC #{lastGc.result.collection}
              </span>
              <div>
                <small>Active Spans</small>
                <strong>
                  {number(lastGc.result.beforeActiveSpans)} <span>→</span>{' '}
                  {number(lastGc.result.afterActiveSpans)}
                </strong>
              </div>
              <div>
                <small>Free Slots</small>
                <strong>
                  {number(lastGc.result.freeSlotsBefore)} <span>→</span>{' '}
                  {number(lastGc.result.freeSlotsAfter)}
                </strong>
              </div>
              <div>
                <small>실제 회수</small>
                <strong className="text-purple">
                  {number(lastGc.result.reclaimedCount)} objects
                </strong>
              </div>
              <div>
                <small>JS ↔ WASM 전체 호출</small>
                <strong>{duration(lastGc.callMs)}</strong>
              </div>
              <div>
                <small>Linear Memory</small>
                <strong>
                  {bytes(lastGc.beforeMemory)} <span>→</span> {bytes(lastGc.afterMemory)}
                </strong>
              </div>
            </div>
          )}
          <div className="arena-layout">
            <div className="arena-map">
              <div className="section-heading">
                <div>
                  <h3>Generational Arena</h3>
                  <p>슬롯을 선택해 객체와 참조를 확인하세요.</p>
                </div>
                <span className="badge">실제 슬롯 {number(stats.arenaSlotCount)}개</span>
              </div>
              <div className="slot-legend">
                {(['occupied', 'marked', 'free', 'reclaimed', 'retired'] as const).map((state) => (
                  <span key={state}>
                    <i style={{ background: slotColors[state] }} />
                    {state[0].toUpperCase() + state.slice(1)}
                  </span>
                ))}
              </div>
              <ArenaCanvas slots={slots} selected={handle?.index} onPick={pick} />
              {slots.length === 0 && (
                <div className="empty-slots">
                  아직 할당된 슬롯이 없습니다. 샘플 트래픽을 실행하세요.
                </div>
              )}
              <div className="arena-pagination">
                <span>
                  Slot {number(slotPage * SLOT_PAGE)}–
                  {number(Math.max(slotPage * SLOT_PAGE, slotPage * SLOT_PAGE + slots.length - 1))}{' '}
                  · 한 화면에 최대 1,024개
                </span>
                <div>
                  <button
                    className="button tiny subtle"
                    disabled={slotPage === 0}
                    onClick={() => setSlotPage(slotPage - 1)}
                  >
                    이전
                  </button>
                  <button
                    className="button tiny subtle"
                    disabled={(slotPage + 1) * SLOT_PAGE >= stats.arenaSlotCount}
                    onClick={() => setSlotPage(slotPage + 1)}
                  >
                    다음
                  </button>
                </div>
              </div>
              <p className="inspector-note">
                Marked는 마지막 GC에서 도달한 객체, Reclaimed는 마지막 GC에서 회수한 슬롯입니다.
                재사용 시 Occupied로 바뀝니다.
              </p>
            </div>
            <div className="slot-inspection">
              <div className="section-heading">
                <h3>Slot Inspection</h3>
                <Icon name="search" />
              </div>
              <form
                className="slot-search"
                onSubmit={(event) => {
                  event.preventDefault()
                  action(() => {
                    const index = Number(slotInput)
                    if (!Number.isInteger(index) || index < 0 || index >= stats.arenaSlotCount)
                      throw new Error('생성된 슬롯 범위의 인덱스를 입력하세요.')
                    const found = engine.slots(index, 1).slots[0]
                    if (found) {
                      pick(found)
                      setSlotPage(Math.floor(index / SLOT_PAGE))
                    }
                  })
                }}
              >
                <label htmlFor="slot-index" className="sr-only">
                  Slot Index
                </label>
                <input
                  id="slot-index"
                  type="number"
                  min="0"
                  value={slotInput}
                  onChange={(event) => setSlotInput(event.target.value)}
                  placeholder="Slot Index"
                />
                <button className="button tiny subtle" type="submit">
                  슬롯 보기
                </button>
              </form>
              {slot && handle ? (
                <>
                  <div className="handle-heading">
                    <code>
                      {handle.index}
                      <span>:</span>
                      {handle.generation}
                    </code>
                    <span className={`badge ${slot.handleValid ? 'success' : 'danger'}`}>
                      {slot.handleValid ? 'VALID HANDLE' : 'STALE / EMPTY'}
                    </span>
                  </div>
                  <dl className="slot-properties">
                    <dt>Slot Index</dt>
                    <dd>{number(slot.index)}</dd>
                    <dt>현재 Generation</dt>
                    <dd>{slot.generation}</dd>
                    <dt>Occupancy</dt>
                    <dd>
                      <i style={{ background: slotColors[slot.state] }} />
                      {slot.state}
                    </dd>
                    <dt>Span ID</dt>
                    <dd>
                      <code>{slot.spanId ?? '—'}</code>
                    </dd>
                    <dt>Trace ID</dt>
                    <dd>
                      <code>{slot.traceId ?? '—'}</code>
                    </dd>
                    <dt>Parent Handle</dt>
                    <dd>
                      {slot.parent ? (
                        <button className="handle-link" onClick={() => setHandle(slot.parent)}>
                          {slot.parent.index}:{slot.parent.generation}
                        </button>
                      ) : (
                        '없음'
                      )}
                    </dd>
                    <dt>Children</dt>
                    <dd className="handle-children">
                      {slot.children.length
                        ? slot.children.slice(0, 20).map((child) => (
                            <button
                              key={`${child.index}:${child.generation}`}
                              className="handle-link"
                              onClick={() => setHandle(child)}
                            >
                              {child.index}:{child.generation}
                            </button>
                          ))
                        : '없음'}
                      {slot.childCount > 20 && <span>외 {slot.childCount - 20}개</span>}
                    </dd>
                  </dl>
                  {!slot.handleValid && (
                    <p className="slot-warning">
                      선택한 Handle은 유효하지 않습니다. 이 슬롯이 재사용되어도 이전 Generation으로
                      새 객체에 접근할 수 없습니다.
                    </p>
                  )}
                </>
              ) : (
                <div className="slot-placeholder">
                  <Icon name="memory" size={27} />
                  <p>Waterfall의 Handle 추적 버튼 또는 Arena의 슬롯을 선택하세요.</p>
                </div>
              )}
            </div>
          </div>
          <div className="memory-footnote">
            <Icon name="error" />
            <p>
              GC는 Span과 그 속성을 해제합니다. WASM Linear Memory는 증가 후 줄어들지 않으며, 확보한
              공간은 이후 할당에 사용됩니다. Arena 슬롯 추정 크기{' '}
              {bytes(stats.arenaSlotBytesEstimate)}는 전체 힙이나 문자열 크기를 뜻하지 않습니다.
              {stats.retiredSlots > 0 &&
                ` 세대 소진으로 재사용하지 않는 슬롯 ${stats.retiredSlots}개.`}
            </p>
          </div>
        </div>
      )}
    </section>
  )
}

function ArenaCanvas({
  slots,
  selected,
  onPick,
}: {
  slots: SlotInfo[]
  selected?: number
  onPick: (slot: SlotInfo) => void
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const layout = useRef({ columns: 64, cell: 10, width: 640 })
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const draw = () => {
      const width = canvas.clientWidth || 640
      const columns = Math.max(16, Math.floor(width / 11))
      const cell = width / columns
      const height = Math.max(88, Math.ceil(slots.length / columns) * cell)
      const dpr = window.devicePixelRatio || 1
      canvas.width = width * dpr
      canvas.height = height * dpr
      canvas.style.height = `${height}px`
      const context = canvas.getContext('2d')
      if (!context) return
      context.scale(dpr, dpr)
      layout.current = { columns, cell, width }
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i]
        const x = (i % columns) * cell
        const y = Math.floor(i / columns) * cell
        context.fillStyle = slotColors[slot.state]
        context.fillRect(x + 1, y + 1, cell - 3, cell - 3)
        if (slot.index === selected) {
          context.strokeStyle = '#f8ffff'
          context.lineWidth = 2
          context.strokeRect(x, y, cell - 1, cell - 1)
        }
      }
    }
    draw()
    const observer = new ResizeObserver(draw)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [slots, selected])
  return (
    <canvas
      ref={ref}
      className="arena-canvas"
      aria-label="실제 Arena 슬롯 상태. 아래 Slot Index 입력으로도 슬롯을 선택할 수 있습니다."
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        const { columns, cell } = layout.current
        const x = event.clientX - rect.left
        const y = event.clientY - rect.top
        const index = Math.floor(y / cell) * columns + Math.floor(x / cell)
        const slot = slots[index]
        if (slot) onPick(slot)
      }}
    />
  )
}
