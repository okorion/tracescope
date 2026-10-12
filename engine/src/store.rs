use crate::{
    arena::{Arena, Handle, Slot},
    ingest,
    trace::{SlowestSpan, Span, Trace},
};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

pub struct Store {
    pub arena: Arena<Span>,
    pub traces: HashMap<String, Trace>,
    pub retention_ms: f64,
    pub clock_origin_ms: f64,
    pub monotonic_origin_ms: f64,
    pub demo_offset_ms: f64,
    pub collections: u64,
    pub last_gc_ms: f64,
    pub last_reclaimed: usize,
    pub reclaimed_total: u64,
    pub metrics_cache: Option<String>,
    // The current API is synchronous; this also documents transient ingest roots.
    pub ingesting_traces: HashSet<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestReport {
    pub accepted_spans: usize,
    pub duplicate_spans: usize,
    pub rejected_spans: usize,
    pub trace_count: usize,
    pub warnings: Vec<String>,
    pub duration_ms: f64,
}

impl Store {
    pub fn new(now_ms: f64) -> Self {
        Self {
            arena: Arena::default(),
            traces: HashMap::new(),
            retention_ms: 300_000.0,
            clock_origin_ms: if now_ms.is_finite() {
                now_ms.max(0.0)
            } else {
                0.0
            },
            monotonic_origin_ms: monotonic_ms(),
            demo_offset_ms: 0.0,
            collections: 0,
            last_gc_ms: 0.0,
            last_reclaimed: 0,
            reclaimed_total: 0,
            metrics_cache: None,
            ingesting_traces: HashSet::new(),
        }
    }
    pub fn now(&self) -> f64 {
        self.clock_origin_ms
            + (monotonic_ms() - self.monotonic_origin_ms).max(0.0)
            + self.demo_offset_ms
    }

    pub fn set_retention(&mut self, ms: f64) -> Result<(), String> {
        if !ms.is_finite() || !(0.0..=2_592_000_000.0).contains(&ms) {
            return Err("Retention은 0~30일 사이의 밀리초 값이어야 합니다.".into());
        }
        self.retention_ms = ms;
        Ok(())
    }
    pub fn advance_time(&mut self, ms: f64) -> Result<(), String> {
        if !ms.is_finite()
            || !(0.0..=2_592_000_000.0).contains(&ms)
            || self.demo_offset_ms + ms > 31_536_000_000.0
        {
            return Err(
                "데모 시간은 한 번에 0~30일, 누적 365일까지 앞으로 이동할 수 있습니다.".into(),
            );
        }
        self.demo_offset_ms += ms;
        Ok(())
    }
    pub fn pin(&mut self, id: &str, pinned: bool) -> bool {
        if let Some(trace) = self.traces.get_mut(id) {
            trace.pinned = pinned;
            true
        } else {
            false
        }
    }

    pub fn ingest(&mut self, input: &str, format: &str) -> Result<IngestReport, String> {
        let start = monotonic_ms();
        let batch = ingest::parse(input, format)?;
        // Count unique new (trace, span) pairs before any mutation, including batch duplicates.
        let mut unique = HashSet::new();
        let needed = batch
            .spans
            .iter()
            .filter(|span| {
                !self
                    .traces
                    .get(&span.trace_id)
                    .is_some_and(|trace| trace.by_span_id.contains_key(&span.span_id))
                    && unique.insert((span.trace_id.as_str(), span.span_id.as_str()))
            })
            .count();
        if self.arena.active + needed > ingest::MAX_ACTIVE_SPANS {
            return Err("보관 가능한 Span 1,000,000개를 초과합니다. Retention을 줄이고 GC를 실행한 뒤 다시 가져와 주세요.".into());
        }
        drop(unique);
        let now = self.now();
        let mut accepted = 0;
        let mut duplicates = 0;
        let mut warnings = batch.warnings;
        for span in batch.spans {
            if self
                .traces
                .get(&span.trace_id)
                .is_some_and(|trace| trace.by_span_id.contains_key(&span.span_id))
            {
                duplicates += 1;
                continue;
            }
            let trace_id = span.trace_id.clone();
            let span_id = span.span_id.clone();
            let handle = self.arena.insert(span);
            let trace = self
                .traces
                .entry(trace_id.clone())
                .or_insert_with(|| Trace::new(trace_id.clone(), now));
            trace.spans.push(handle);
            trace.by_span_id.insert(span_id, handle);
            trace.last_ingest_ms = now;
            self.ingesting_traces.insert(trace_id);
            accepted += 1;
        }
        let mut affected: Vec<_> = self.ingesting_traces.iter().cloned().collect();
        affected.sort();
        for id in &affected {
            let anomalies = self.rebuild_trace(id);
            if anomalies.0 > 0 && warnings.len() < 50 {
                warnings.push(format!(
                    "Trace {id}: 부모가 없는 Span {}개를 루트로 보존했습니다.",
                    anomalies.0
                ));
            }
            if anomalies.1 > 0 && warnings.len() < 50 {
                warnings.push(format!(
                    "Trace {id}: 순환 참조 구성요소 {}개에 탐색 루트를 추가했습니다.",
                    anomalies.1
                ));
            }
        }
        self.ingesting_traces.clear();
        if accepted > 0 {
            self.metrics_cache = None;
        }
        Ok(IngestReport {
            accepted_spans: accepted,
            duplicate_spans: duplicates,
            rejected_spans: batch.rejected,
            trace_count: affected.len(),
            warnings,
            duration_ms: monotonic_ms() - start,
        })
    }

    /// Rebuild only traces affected by a batch. Missing-parent and cyclic components
    /// each receive a root, so every span belonging to a retained trace stays alive.
    fn rebuild_trace(&mut self, id: &str) -> (usize, usize) {
        let Some(trace) = self.traces.get_mut(id) else {
            return (0, 0);
        };
        trace.spans.sort_by(|a, b| {
            let a = self.arena.get(*a).expect("live trace index");
            let b = self.arena.get(*b).expect("live trace index");
            a.start_ns
                .cmp(&b.start_ns)
                .then_with(|| a.span_id.cmp(&b.span_id))
        });
        trace.roots.clear();
        trace.services.clear();
        trace.error = false;
        trace.sample = false;
        trace.start_ns = u64::MAX;
        trace.end_ns = 0;
        trace.missing_parents = 0;
        trace.error_span_count = 0;
        trace.slowest_child_span = None;
        for handle in &trace.spans {
            let span = self.arena.get_mut(*handle).expect("live trace index");
            span.children.clear();
            span.parent = span
                .parent_span_id
                .as_ref()
                .and_then(|parent| trace.by_span_id.get(parent))
                .copied();
            if span.parent.is_none() {
                trace.roots.push(*handle);
                if span.parent_span_id.is_some() {
                    trace.missing_parents += 1;
                }
            }
            trace.services.insert(span.service_name.to_string());
            trace.start_ns = trace.start_ns.min(span.start_ns);
            trace.end_ns = trace.end_ns.max(span.end_ns);
            trace.error |= span.is_error();
            trace.error_span_count += usize::from(span.is_error());
            trace.sample |= span.sample;
            if span.parent.is_some()
                && trace
                    .slowest_child_span
                    .as_ref()
                    .is_none_or(|s| span.duration_ms() > s.duration_ms)
            {
                trace.slowest_child_span = Some(SlowestSpan {
                    span_id: span.span_id.clone(),
                    service_name: span.service_name.to_string(),
                    operation_name: span.operation_name.clone(),
                    duration_ms: span.duration_ms(),
                    handle: *handle,
                });
            }
        }
        for handle in &trace.spans {
            if let Some(parent) = self.arena.get(*handle).and_then(|span| span.parent)
                && let Some(parent_span) = self.arena.get_mut(parent)
            {
                parent_span.children.push(*handle);
            }
        }
        let mut visited = HashSet::with_capacity(trace.spans.len());
        let mut pending = trace.roots.clone();
        visit(&self.arena, &mut pending, &mut visited);
        let mut cycle_components = 0;
        for handle in &trace.spans {
            if !visited.contains(handle) {
                trace.roots.push(*handle);
                pending.push(*handle);
                visit(&self.arena, &mut pending, &mut visited);
                cycle_components += 1;
            }
        }
        trace.operation_name = trace
            .roots
            .first()
            .and_then(|handle| self.arena.get(*handle))
            .map(|span| span.operation_name.clone())
            .unwrap_or_default();
        (trace.missing_parents, cycle_components)
    }

    pub fn expire(&mut self) -> Value {
        let now = self.now();
        let before = self.traces.len();
        self.traces.retain(|id, trace| {
            trace.pinned
                || self.ingesting_traces.contains(id)
                || now - trace.last_ingest_ms < self.retention_ms
        });
        let expired = before - self.traces.len();
        if expired > 0 {
            self.metrics_cache = None;
        }
        let indexed: usize = self.traces.values().map(|trace| trace.spans.len()).sum();
        json!({ "expiredTraces": expired, "pendingSpans": self.arena.active.saturating_sub(indexed) })
    }

    pub fn collect(&mut self) -> Value {
        let start = monotonic_ms();
        self.expire();
        let before = self.arena.active;
        let free_before = self.arena.free_count();
        self.collections += 1;
        self.arena.clear_marks();
        let mut pending: Vec<Handle> = self
            .traces
            .values()
            .flat_map(|trace| trace.roots.iter().copied())
            .collect();
        // Normalization currently cannot interleave with collection, but transient
        // roots still cover accepted spans if collection is later chunked.
        for id in &self.ingesting_traces {
            if let Some(trace) = self.traces.get(id) {
                pending.extend(trace.spans.iter().copied());
            }
        }
        let mut marked = 0;
        while let Some(handle) = pending.pop() {
            if self.arena.mark(handle) {
                marked += 1;
                if let Some(span) = self.arena.get(handle) {
                    pending.extend(span.children.iter().copied());
                }
            }
        }
        self.last_reclaimed = self.arena.sweep(self.collections);
        self.reclaimed_total += self.last_reclaimed as u64;
        // Defensive cleanup keeps view indexes consistent even if a corrupt internal
        // edge made a previously indexed handle unreachable.
        let arena = &self.arena;
        self.traces.retain(|_, trace| {
            trace.spans.retain(|h| arena.get(*h).is_some());
            trace.roots.retain(|h| arena.get(*h).is_some());
            trace.by_span_id.retain(|_, h| arena.get(*h).is_some());
            !trace.spans.is_empty()
        });
        self.last_gc_ms = monotonic_ms() - start;
        json!({ "beforeActiveSpans": before, "afterActiveSpans": self.arena.active,
            "reclaimedCount": self.last_reclaimed, "markedCount": marked,
            "freeSlotsBefore": free_before, "freeSlotsAfter": self.arena.free_count(),
            "durationMs": self.last_gc_ms, "collection": self.collections })
    }

    pub fn stats(&self) -> Value {
        let indexed: usize = self.traces.values().map(|trace| trace.spans.len()).sum();
        json!({ "activeSpans": self.arena.active, "indexedSpans": indexed, "totalTraces": self.traces.len(),
            "arenaSlotCount": self.arena.slots.len(), "arenaCapacity": self.arena.slots.capacity(),
            "freeSlots": self.arena.free_count(), "retiredSlots": self.arena.retired,
            "totalAllocations": self.arena.allocations, "reusedSlots": self.arena.reused,
            "gcCollections": self.collections, "lastGcDurationMs": self.last_gc_ms,
            "lastReclaimedCount": self.last_reclaimed, "cumulativeReclaimedCount": self.reclaimed_total,
            "retentionMs": self.retention_ms, "engineTimeMs": self.now(), "demoOffsetMs": self.demo_offset_ms,
            "expiredPendingSpans": self.arena.active.saturating_sub(indexed), "wasmMemoryBytes": 0,
            "arenaSlotBytesEstimate": self.arena.slots.capacity() * std::mem::size_of::<Slot<Span>>() })
    }

    pub fn slot(&self, index: usize, requested_generation: Option<u32>) -> Value {
        let Some(slot) = self.arena.slots.get(index) else {
            return Value::Null;
        };
        let valid =
            slot.value.is_some() && requested_generation.is_none_or(|g| g == slot.generation);
        let state = if slot.retired {
            "retired"
        } else if slot.value.is_some() {
            if slot.marked { "marked" } else { "occupied" }
        } else if slot.last_reclaimed_collection == Some(self.collections) {
            "reclaimed"
        } else {
            "free"
        };
        // Invalid handles reveal slot generation/state but never the new occupant.
        let span = if valid { slot.value.as_ref() } else { None };
        json!({ "index": index, "generation": slot.generation, "occupied": slot.value.is_some(), "state": state,
            "handleValid": valid, "spanId": span.map(|s| &s.span_id), "traceId": span.map(|s| &s.trace_id),
            "parent": span.and_then(|s| s.parent), "children": span.map(|s| s.children.iter().take(256).collect::<Vec<_>>()).unwrap_or_default(),
            "childCount": span.map(|s| s.children.len()).unwrap_or(0),
            "lastReclaimedCollection": slot.last_reclaimed_collection })
    }
    pub fn slots(&self, offset: usize, limit: usize) -> Value {
        let limit = limit.clamp(1, 4096);
        let slots: Vec<_> = (offset.min(self.arena.slots.len())
            ..offset.saturating_add(limit).min(self.arena.slots.len()))
            .map(|i| self.slot(i, None))
            .collect();
        json!({ "slots": slots, "total": self.arena.slots.len(), "offset": offset, "limit": limit })
    }
}

fn visit(arena: &Arena<Span>, pending: &mut Vec<Handle>, visited: &mut HashSet<Handle>) {
    while let Some(handle) = pending.pop() {
        if visited.insert(handle)
            && let Some(span) = arena.get(handle)
        {
            pending.extend(span.children.iter().copied());
        }
    }
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = performance, js_name = now)]
    fn browser_monotonic_now() -> f64;
}
pub fn monotonic_ms() -> f64 {
    #[cfg(target_arch = "wasm32")]
    {
        browser_monotonic_now()
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        static ORIGIN: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
        ORIGIN
            .get_or_init(std::time::Instant::now)
            .elapsed()
            .as_secs_f64()
            * 1000.0
    }
}
