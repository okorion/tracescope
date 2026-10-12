import { useEffect, useState } from 'react'
import type { Handle, SpanDetail, TraceDetail as Detail } from '../engine'
import { duration, number, serviceColor } from '../format'
import Icon from './Icon'

const PAGE_SIZE = 24
type Tab = 'attributes' | 'resource' | 'scope' | 'events' | 'links' | 'metadata'
type Props = {
  detail: Detail | null
  busy: boolean
  onPin: () => void
  onInspect: (handle: Handle) => void
  onPage: (offset: number) => void
}

export default function TraceDetail({ detail, busy, onPin, onInspect, onPage }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('attributes')
  useEffect(() => {
    setSelectedId(null)
    setTab('attributes')
  }, [detail?.traceId, detail?.offset])
  const selected = detail?.spans.find((span) => span.spanId === selectedId) ?? detail?.spans[0]
  const slowest = detail?.slowestChildSpan
  if (!detail)
    return (
      <section className="panel detail-panel empty-detail">
        <div className="empty-graphic">
          <Icon name="trace" size={34} />
        </div>
        <h2>분석할 트레이스를 선택하세요</h2>
        <p>요청 목록에서 호출 흐름과 지연 구간을 확인할 수 있습니다.</p>
      </section>
    )
  const totalDuration = Math.max(detail.durationMs, 0.000001)
  const spans = detail.spans
  const errors = detail.errorSpanCount
  const select = (span: SpanDetail) => {
    setSelectedId(span.spanId)
    setTab('attributes')
  }
  const field =
    selected &&
    {
      attributes: selected.attributes,
      resource: { attributes: selected.resourceAttributes, metadata: selected.resourceMetadata },
      scope: selected.scope,
      events: selected.events,
      links: selected.links,
      metadata: selected.metadata,
    }[tab]
  return (
    <section className="panel detail-panel" aria-label="Trace 상세">
      <div className="detail-heading">
        <div className="eyebrow">
          TRACE DETAIL <span className="slash">/</span>{' '}
          <span className="mono">{detail.traceId.slice(-12)}</span>
        </div>
        <button
          className={`button small ${detail.pinned ? 'pinned' : 'subtle'}`}
          disabled={busy}
          onClick={onPin}
          aria-label={detail.pinned ? 'Trace Unpin' : 'Trace Pin'}
          aria-pressed={detail.pinned}
        >
          <Icon name="pin" />
          {detail.pinned ? 'Pin 해제' : 'Trace Pin'}
        </button>
      </div>
      <div className="detail-title">
        <span className={`status-dot ${detail.error ? 'error' : ''}`} />
        <h2>{detail.operationName}</h2>
        {detail.sample && <span className="badge sample">SAMPLE</span>}
      </div>
      <div className="detail-meta">
        <span>
          <Icon name="clock" />
          {duration(detail.durationMs)}
        </span>
        <span>
          <Icon name="layers" />
          {number(detail.spanCount)} spans
        </span>
        <span>{detail.services.length} services</span>
        <span className={detail.error ? 'text-error' : 'text-success'}>
          {detail.error ? `오류 ${errors}개` : '오류 없음'}
        </span>
        <span className="retention-status">
          {detail.pinned
            ? 'Pin으로 보존 중'
            : detail.expiresInMs <= 0
              ? '만료 대상'
              : `만료까지 ${Math.ceil(detail.expiresInMs / 1000)}초`}
        </span>
      </div>
      {detail.missingParents > 0 && (
        <div className="inline-warning">
          <Icon name="error" />
          부모가 없는 Span {detail.missingParents}개를 별도 루트로 표시합니다.
        </div>
      )}
      {slowest && (
        <div
          className="bottleneck"
          title="하위 호출을 포함한 Span 시간입니다. 병렬 호출과 중첩을 고려한 Critical Path 계산은 아닙니다."
        >
          <span className="bottleneck-icon">
            <Icon name="clock" />
          </span>
          <div>
            <strong>가장 긴 하위 Span · 병목 후보</strong>
            <span>
              {slowest.serviceName} <span className="muted">/</span> {slowest.operationName}
            </span>
          </div>
          <b>{duration(slowest.durationMs)}</b>
          <button className="text-button" onClick={() => onInspect(slowest.handle)}>
            슬롯 <Icon name="arrow" size={13} />
          </button>
        </div>
      )}
      <div className="waterfall-toolbar">
        <h3>Waterfall</h3>
        <div className="service-legend">
          {detail.services.map((service) => (
            <span key={service}>
              <i style={{ background: serviceColor(service) }} />
              {service}
            </span>
          ))}
        </div>
      </div>
      <div className="waterfall-scroll">
        <div className="waterfall" aria-label="Span Waterfall">
          <div className="waterfall-axis">
            <span>SERVICE / OPERATION</span>
            <div>
              {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
                <span key={tick} style={{ left: `${tick * 100}%` }}>
                  {duration(tick * detail.durationMs)}
                </span>
              ))}
            </div>
            <span>소요 시간</span>
          </div>
          {spans.map((span) => {
            const isError = span.status.toLowerCase() === 'error'
            const left = Math.min(99.8, Math.max(0, (span.offsetMs / totalDuration) * 100))
            const width = Math.max(
              0.25,
              Math.min(100 - left, (span.durationMs / totalDuration) * 100),
            )
            return (
              <button
                className={`waterfall-row ${selected?.spanId === span.spanId ? 'selected' : ''}`}
                key={`${span.handle.index}:${span.handle.generation}`}
                onClick={() => select(span)}
                aria-label={`Span ${span.operationName}`}
                aria-pressed={selected?.spanId === span.spanId}
              >
                <span
                  className="span-label"
                  style={{ paddingLeft: `${12 + Math.min(span.depth, 8) * 12}px` }}
                >
                  <i style={{ background: serviceColor(span.serviceName) }} />
                  <span>
                    <strong>{span.operationName}</strong>
                    <small>
                      {span.serviceName}
                      {span.missingParent ? ' · 부모 누락' : ''}
                    </small>
                  </span>
                  {isError && <Icon name="error" size={13} />}
                </span>
                <span className="timeline-track">
                  <span
                    className={`timeline-bar ${isError ? 'has-error' : ''}`}
                    style={{
                      left: `${left}%`,
                      width: `${width}%`,
                      background: serviceColor(span.serviceName),
                    }}
                  >
                    <span>{width > 30 ? duration(span.durationMs) : ''}</span>
                  </span>
                </span>
                <span className={`span-duration mono ${isError ? 'text-error' : ''}`}>
                  {duration(span.durationMs)}
                </span>
              </button>
            )
          })}
        </div>
      </div>
      {detail.totalSpans > PAGE_SIZE && (
        <div className="waterfall-pagination">
          <span>
            {number(detail.offset + 1)}–{number(detail.offset + detail.spans.length)} /{' '}
            {number(detail.totalSpans)} spans
          </span>
          <div>
            <button
              className="button tiny subtle"
              aria-label="이전 Span 페이지"
              disabled={detail.offset === 0}
              onClick={() => onPage(Math.max(0, detail.offset - PAGE_SIZE))}
            >
              이전
            </button>
            <button
              className="button tiny subtle"
              aria-label="다음 Span 페이지"
              disabled={detail.offset + detail.spans.length >= detail.totalSpans}
              onClick={() => onPage(detail.offset + PAGE_SIZE)}
            >
              다음
            </button>
          </div>
        </div>
      )}
      {selected && (
        <div className="span-detail" aria-label="선택한 Span">
          <div className="span-detail-heading">
            <div>
              <span className="eyebrow">SELECTED SPAN</span>
              <h3>
                <i style={{ background: serviceColor(selected.serviceName) }} />
                {selected.operationName}
              </h3>
            </div>
            <button className="button tiny subtle" onClick={() => onInspect(selected.handle)}>
              <Icon name="memory" size={14} />
              Handle 추적 <Icon name="arrow" size={13} />
            </button>
          </div>
          <div className="span-properties">
            <div>
              <span>Span ID</span>
              <code>{selected.spanId}</code>
            </div>
            <div>
              <span>Duration</span>
              <b>{duration(selected.durationMs)}</b>
            </div>
            <div>
              <span>Status</span>
              <b
                className={
                  selected.status.toLowerCase() === 'error' ? 'text-error' : 'text-success'
                }
              >
                {selected.status}
              </b>
            </div>
            <div>
              <span>Rust Handle</span>
              <code>
                {selected.handle.index}:{selected.handle.generation}
              </code>
            </div>
          </div>
          <div className="attribute-tabs" role="tablist" aria-label="Span 속성">
            {(['attributes', 'resource', 'scope', 'events', 'links', 'metadata'] as const).map(
              (value) => (
                <button
                  key={value}
                  role="tab"
                  aria-selected={tab === value}
                  onClick={() => setTab(value)}
                >
                  {
                    {
                      attributes: 'Attributes',
                      resource: 'Resource',
                      scope: 'Scope',
                      events: 'Events',
                      links: 'Links',
                      metadata: 'Metadata',
                    }[value]
                  }
                  {value === 'events'
                    ? ` (${selected.events.length})`
                    : value === 'links'
                      ? ` (${selected.links.length})`
                      : ''}
                </button>
              ),
            )}
          </div>
          <AttributeData value={field} />
          <details className="precision-details">
            <summary>원본 시간 · 나노초 정밀도</summary>
            <dl>
              <dt>Start</dt>
              <dd>{selected.startTimeNs} ns</dd>
              <dt>End</dt>
              <dd>{selected.endTimeNs} ns</dd>
              <dt>Parent</dt>
              <dd>{selected.parentSpanId ?? 'Root Span'}</dd>
            </dl>
          </details>
        </div>
      )}
    </section>
  )
}

function AttributeData({ value }: { value: unknown }) {
  if (
    (Array.isArray(value) && value.length === 0) ||
    (value && typeof value === 'object' && Object.keys(value).length === 0) ||
    value === null ||
    value === undefined
  )
    return <p className="no-attributes">저장된 항목이 없습니다.</p>
  const items: [string, unknown][] = Array.isArray(value)
    ? value.map((item: unknown, index: number) =>
        item && typeof item === 'object' && 'key' in item && 'value' in item
          ? [String(item.key), item.value]
          : [String(index + 1), item],
      )
    : typeof value === 'object' && value
      ? Object.entries(value)
      : [['value', value]]
  return (
    <dl className="attribute-list">
      {items.map(([key, item], index) => (
        <div key={`${key}-${index}`}>
          <dt>{key}</dt>
          <dd>{typeof item === 'string' ? item : JSON.stringify(item)}</dd>
        </div>
      ))}
    </dl>
  )
}
