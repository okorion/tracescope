use crate::{
    store::Store,
    trace::{Span, Trace},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Query {
    pub search: String,
    pub service: String,
    pub operation: String,
    pub error_only: bool,
    pub min_duration_ms: Option<f64>,
    pub max_duration_ms: Option<f64>,
    pub sort: Option<String>,
    pub offset: usize,
    pub limit: Option<usize>,
}

impl Store {
    pub fn query(&self, input: &str) -> Result<String, String> {
        let query: Query = serde_json::from_str(input)
            .map_err(|e| format!("조회 조건이 올바르지 않습니다: {e}"))?;
        if query
            .min_duration_ms
            .is_some_and(|v| !v.is_finite() || v < 0.0)
            || query
                .max_duration_ms
                .is_some_and(|v| !v.is_finite() || v < 0.0)
        {
            return Err("Duration은 0 이상의 유한한 값이어야 합니다.".into());
        }
        if let (Some(min), Some(max)) = (query.min_duration_ms, query.max_duration_ms)
            && min > max
        {
            return Err("최소 Duration이 최대 Duration보다 큽니다.".into());
        }
        let sort = query.sort.as_deref().unwrap_or("newest");
        if !["newest", "oldest", "slowest", "fastest"].contains(&sort) {
            return Err("지원하지 않는 정렬입니다.".into());
        }
        let search = query.search.to_lowercase();
        let service = query.service.to_lowercase();
        let operation = query.operation.to_lowercase();
        let mut traces: Vec<&Trace> = self
            .traces
            .values()
            .filter(|trace| {
                if query.error_only && !trace.error {
                    return false;
                }
                let duration = trace.duration_ms();
                if query.min_duration_ms.is_some_and(|v| duration < v)
                    || query.max_duration_ms.is_some_and(|v| duration > v)
                {
                    return false;
                }
                if !service.is_empty()
                    && !trace
                        .services
                        .iter()
                        .any(|s| s.to_lowercase().contains(&service))
                {
                    return false;
                }
                if !operation.is_empty()
                    && !trace.spans.iter().any(|h| {
                        self.arena.get(*h).is_some_and(|span| {
                            span.operation_name.to_lowercase().contains(&operation)
                        })
                    })
                {
                    return false;
                }
                search.is_empty()
                    || trace.trace_id.contains(&search)
                    || trace
                        .services
                        .iter()
                        .any(|s| s.to_lowercase().contains(&search))
                    || trace.spans.iter().any(|h| {
                        self.arena.get(*h).is_some_and(|span| {
                            span.operation_name.to_lowercase().contains(&search)
                        })
                    })
            })
            .collect();
        traces.sort_unstable_by(|a, b| {
            let order = match sort {
                "oldest" => a.start_ns.cmp(&b.start_ns),
                "slowest" => b.duration_ms().total_cmp(&a.duration_ms()),
                "fastest" => a.duration_ms().total_cmp(&b.duration_ms()),
                _ => b.start_ns.cmp(&a.start_ns),
            };
            order.then_with(|| a.trace_id.cmp(&b.trace_id))
        });
        let limit = query.limit.unwrap_or(50).clamp(1, 200);
        let now = self.now();
        let results: Vec<_> = traces
            .iter()
            .skip(query.offset)
            .take(limit)
            .map(|trace| trace.summary(now, self.retention_ms))
            .collect();
        Ok(json!({ "traces": results, "total": traces.len(), "offset": query.offset, "limit": limit }).to_string())
    }

    pub fn detail(&self, id: &str, offset: usize, limit: usize) -> Value {
        let Some(trace) = self.traces.get(id) else {
            return Value::Null;
        };
        let limit = limit.clamp(1, 2000);
        let mut visited = HashSet::new();
        let mut stack: Vec<_> = trace.roots.iter().rev().map(|h| (*h, 0usize)).collect();
        let mut output = Vec::new();
        // Resource/scope metadata is shared, not copied for every span. A large
        // resource attribute must never amplify a small input into a huge DTO.
        let mut resources = Vec::new();
        let mut scopes = Vec::new();
        let mut resource_indices = HashMap::new();
        let mut scope_indices = HashMap::new();
        let end = offset.saturating_add(limit);
        while let Some((handle, depth)) = stack.pop() {
            if !visited.insert(handle) {
                continue;
            }
            let Some(span) = self.arena.get(handle) else {
                continue;
            };
            if visited.len() > offset && visited.len() <= end {
                let resource_index = *resource_indices.entry(std::sync::Arc::as_ptr(&span.resource_attributes) as usize).or_insert_with(|| {
                    let index = resources.len();
                    resources.push(json!({ "attributes": span.resource_attributes, "metadata": span.resource_metadata }));
                    index
                });
                let scope_index = *scope_indices
                    .entry(std::sync::Arc::as_ptr(&span.scope) as usize)
                    .or_insert_with(|| {
                        let index = scopes.len();
                        scopes.push((*span.scope).clone());
                        index
                    });
                output.push(json!({ "handle": handle, "traceId": span.trace_id, "spanId": span.span_id,
                    "parentSpanId": span.parent_span_id, "serviceName": span.service_name, "operationName": span.operation_name,
                    "startTimeNs": span.start_ns.to_string(), "endTimeNs": span.end_ns.to_string(),
                    "offsetMs": span.start_ns.saturating_sub(trace.start_ns) as f64 / 1_000_000.0,
                    "durationMs": span.duration_ms(), "status": span.status, "depth": depth,
                    "attributes": span.attributes, "resourceIndex": resource_index,
                    "scopeIndex": scope_index, "events": span.events, "links": span.links, "metadata": span.metadata,
                    "children": span.children.iter().take(256).collect::<Vec<_>>(), "childCount": span.children.len(),
                    "parent": span.parent, "missingParent": span.parent_span_id.is_some() && span.parent.is_none() }));
            }
            if visited.len() >= end {
                break;
            }
            stack.extend(span.children.iter().rev().map(|child| (*child, depth + 1)));
        }
        let mut result = serde_json::to_value(trace.summary(self.now(), self.retention_ms))
            .expect("finite trace metrics");
        result["spans"] = Value::Array(output);
        result["resources"] = Value::Array(resources);
        result["scopes"] = Value::Array(scopes);
        result["totalSpans"] = json!(trace.spans.len());
        result["truncated"] = json!(offset > 0 || end < trace.spans.len());
        result["roots"] = json!(trace.roots.iter().take(2000).collect::<Vec<_>>());
        result["rootCount"] = json!(trace.roots.len());
        result["errorSpanCount"] = json!(trace.error_span_count);
        result["slowestChildSpan"] = json!(trace.slowest_child_span);
        result["offset"] = json!(offset);
        result["limit"] = json!(limit);
        result
    }

    pub fn metrics(&mut self) -> String {
        if let Some(cached) = &self.metrics_cache {
            return cached.clone();
        }
        let mut durations: Vec<f64> = self.traces.values().map(Trace::duration_ms).collect();
        durations.sort_unstable_by(f64::total_cmp);
        let errors = self.traces.values().filter(|trace| trace.error).count();
        let mut services: HashMap<&str, ServiceAggregate> = HashMap::new();
        let mut span_count = 0;
        for trace in self.traces.values() {
            for handle in &trace.spans {
                if let Some(span) = self.arena.get(*handle) {
                    services.entry(&span.service_name).or_default().add(span);
                    span_count += 1;
                }
            }
        }
        let service_count = services.len();
        let mut services: Vec<_> = services.into_iter().collect();
        services.sort_unstable_by(|a, b| b.1.count.cmp(&a.1.count).then_with(|| a.0.cmp(b.0)));
        let service_values: Vec<_> = services.into_iter().take(100).map(|(name, s)| json!({ "serviceName": name, "spanCount": s.count, "errorCount": s.errors, "totalDurationMs": s.total, "maxDurationMs": s.max })).collect();
        let count = durations.len();
        // Nearest-rank quantiles; UI displays sample count. A quantile is withheld
        // below the minimum count required to distinguish its upper tail.
        let result = json!({ "totalTraces": count, "totalSpans": span_count, "sampleSize": count,
            "p50Ms": percentile(&durations, 0.50, 2), "p95Ms": percentile(&durations, 0.95, 20),
            "p99Ms": percentile(&durations, 0.99, 100),
            "errorRate": if count == 0 { None } else { Some(errors as f64 / count as f64) },
            "services": service_values, "totalServices": service_count })
        .to_string();
        self.metrics_cache = Some(result.clone());
        result
    }
}

fn percentile(values: &[f64], quantile: f64, minimum: usize) -> Option<f64> {
    if values.len() < minimum {
        None
    } else {
        Some(values[(values.len() as f64 * quantile).ceil() as usize - 1])
    }
}
#[derive(Default)]
struct ServiceAggregate {
    count: usize,
    errors: usize,
    total: f64,
    max: f64,
}
impl ServiceAggregate {
    fn add(&mut self, span: &Span) {
        self.count += 1;
        self.errors += usize::from(span.is_error());
        self.total += span.duration_ms();
        self.max = self.max.max(span.duration_ms());
    }
}
