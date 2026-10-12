use crate::arena::Handle;
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{BTreeSet, HashMap},
    sync::Arc,
};

pub struct Span {
    pub trace_id: String,
    pub span_id: String,
    pub parent_span_id: Option<String>,
    pub service_name: Arc<str>,
    pub operation_name: String,
    pub start_ns: u64,
    pub end_ns: u64,
    pub status: String,
    pub attributes: Value,
    pub resource_attributes: Arc<Value>,
    pub resource_metadata: Arc<Value>,
    pub scope: Arc<Value>,
    pub events: Vec<Value>,
    pub links: Vec<Value>,
    pub metadata: Value,
    pub children: Vec<Handle>,
    pub parent: Option<Handle>,
    pub sample: bool,
}

impl Span {
    pub fn duration_ms(&self) -> f64 {
        (self.end_ns - self.start_ns) as f64 / 1_000_000.0
    }
    pub fn is_error(&self) -> bool {
        self.status == "error"
    }
}

pub struct Trace {
    pub trace_id: String,
    pub spans: Vec<Handle>,
    pub by_span_id: HashMap<String, Handle>,
    pub roots: Vec<Handle>,
    pub services: BTreeSet<String>,
    pub operation_name: String,
    pub start_ns: u64,
    pub end_ns: u64,
    pub error: bool,
    pub pinned: bool,
    pub last_ingest_ms: f64,
    pub sample: bool,
    pub missing_parents: usize,
    pub error_span_count: usize,
    pub slowest_span: Option<SlowestSpan>,
}

impl Trace {
    pub fn new(trace_id: String, now: f64) -> Self {
        Self {
            trace_id,
            spans: Vec::new(),
            by_span_id: HashMap::new(),
            roots: Vec::new(),
            services: BTreeSet::new(),
            operation_name: String::new(),
            start_ns: u64::MAX,
            end_ns: 0,
            error: false,
            pinned: false,
            last_ingest_ms: now,
            sample: false,
            missing_parents: 0,
            error_span_count: 0,
            slowest_span: None,
        }
    }
    pub fn duration_ms(&self) -> f64 {
        self.end_ns.saturating_sub(self.start_ns) as f64 / 1_000_000.0
    }
    pub fn summary(&self, now: f64, retention_ms: f64) -> TraceSummary {
        TraceSummary {
            trace_id: self.trace_id.clone(),
            operation_name: self.operation_name.clone(),
            services: self.services.iter().cloned().collect(),
            start_time_ns: self.start_ns.to_string(),
            duration_ms: self.duration_ms(),
            span_count: self.spans.len(),
            error: self.error,
            pinned: self.pinned,
            expires_in_ms: (self.last_ingest_ms + retention_ms - now).max(0.0),
            sample: self.sample,
            missing_parents: self.missing_parents,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlowestSpan {
    pub span_id: String,
    pub service_name: String,
    pub operation_name: String,
    pub duration_ms: f64,
    pub handle: Handle,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceSummary {
    pub trace_id: String,
    pub operation_name: String,
    pub services: Vec<String>,
    pub start_time_ns: String,
    pub duration_ms: f64,
    pub span_count: usize,
    pub error: bool,
    pub pinned: bool,
    pub expires_in_ms: f64,
    pub sample: bool,
    pub missing_parents: usize,
}
