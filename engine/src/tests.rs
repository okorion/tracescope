use crate::{
    arena::Handle,
    ingest::{self, MAX_INPUT_BYTES},
    store::Store,
};
use serde_json::{Value, json};

fn span(trace: u64, id: u64, parent: Option<u64>, start: u64, duration: u64) -> Value {
    json!({ "traceId": format!("{trace:032x}"), "spanId": format!("{id:016x}"),
        "parentSpanId": parent.map(|p| format!("{p:016x}")).unwrap_or_default(),
        "name": format!("operation-{id}"), "startTimeUnixNano": start.to_string(),
        "endTimeUnixNano": (start + duration).to_string(), "status": {"code": 1},
        "attributes": [{"key":"test.id","value":{"intValue":id.to_string()}}] })
}
fn document(spans: Vec<Value>) -> String {
    json!({"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"api"}}]},"scopeSpans":[{"scope":{"name":"tests","version":"1.0"},"spans":spans}]}]}).to_string()
}
fn id(value: u64) -> String {
    format!("{value:032x}")
}
fn ingest(store: &mut Store, spans: Vec<Value>) {
    store.ingest(&document(spans), "otlp").unwrap();
}
fn int(value: &Value, key: &str) -> u64 {
    value[key].as_u64().unwrap()
}

#[test]
fn otlp_ingest_and_out_of_order_parent_relationships() {
    let mut store = Store::new(1000.0);
    ingest(
        &mut store,
        vec![span(1, 2, Some(1), 1001, 50), span(1, 1, None, 1000, 100)],
    );
    let detail = store.detail(&id(1), 0, 2000);
    assert_eq!(int(&detail, "totalSpans"), 2);
    assert_eq!(detail["spans"][0]["spanId"], "0000000000000001");
    assert_eq!(detail["spans"][1]["depth"], 1);
    assert_eq!(detail["spans"][1]["parent"], detail["spans"][0]["handle"]);
    assert_eq!(detail["spans"][1]["offsetMs"], 0.000001);
    assert_eq!(store.collect()["markedCount"], 2);
    assert_eq!(detail["slowestChildSpan"]["spanId"], "0000000000000002");
}

#[test]
fn multiple_resource_spans_and_same_span_ids_in_different_traces() {
    let a: Value = serde_json::from_str(&document(vec![span(1, 1, None, 0, 10)])).unwrap();
    let mut b = a.clone();
    b["resourceSpans"][0]["resource"]["attributes"][0]["value"]["stringValue"] = json!("database");
    b["resourceSpans"][0]["scopeSpans"][0]["spans"][0]["traceId"] = json!(id(2));
    let payload = json!({"resourceSpans":[a["resourceSpans"][0],b["resourceSpans"][0]]});
    let mut store = Store::new(0.0);
    assert_eq!(
        store
            .ingest(&payload.to_string(), "otlp")
            .unwrap()
            .accepted_spans,
        2
    );
    assert_eq!(store.traces.len(), 2);
    let metrics: Value = serde_json::from_str(&store.metrics()).unwrap();
    assert_eq!(metrics["services"].as_array().unwrap().len(), 2);
}

#[test]
fn missing_parent_and_cycles_keep_every_live_span() {
    let mut store = Store::new(0.0);
    let report = store
        .ingest(
            &document(vec![
                span(1, 1, Some(99), 0, 10),
                span(1, 2, Some(3), 1, 5),
                span(1, 3, Some(2), 2, 3),
                span(1, 4, Some(4), 3, 1),
            ]),
            "otlp",
        )
        .unwrap();
    assert_eq!(report.warnings.len(), 2);
    let detail = store.detail(&id(1), 0, 2000);
    assert_eq!(detail["missingParents"], 1);
    assert_eq!(detail["rootCount"], 3);
    assert_eq!(detail["spans"].as_array().unwrap().len(), 4);
    assert_eq!(store.collect()["reclaimedCount"], 0);
    assert_eq!(store.arena.active, 4);
}

#[test]
fn first_duplicate_wins_within_and_between_batches() {
    let mut store = Store::new(0.0);
    let original = span(1, 1, None, 0, 10);
    let mut changed = original.clone();
    changed["name"] = json!("changed");
    let report = store
        .ingest(&document(vec![original, changed.clone()]), "otlp")
        .unwrap();
    assert_eq!(report.accepted_spans, 1);
    assert_eq!(report.duplicate_spans, 1);
    assert_eq!(
        store
            .ingest(&document(vec![changed]), "otlp")
            .unwrap()
            .duplicate_spans,
        1
    );
    assert_eq!(store.detail(&id(1), 0, 10)["operationName"], "operation-1");
    assert_eq!(store.arena.allocations, 1);
}

#[test]
fn invalid_duration_and_ids_are_rejected_without_crash() {
    let mut reversed = span(1, 1, None, 100, 10);
    reversed["endTimeUnixNano"] = json!("99");
    let mut invalid_id = span(1, 2, None, 100, 10);
    invalid_id["spanId"] = json!("0000000000000000");
    let mut invalid_parent = span(1, 3, None, 100, 10);
    invalid_parent["parentSpanId"] = json!("???");
    let mut invalid_status = span(1, 4, None, 100, 10);
    invalid_status["status"] = json!(false);
    let report = ingest::parse(
        &document(vec![reversed, invalid_id, invalid_parent, invalid_status]),
        "otlp",
    )
    .unwrap();
    assert_eq!(report.rejected, 4);
    assert!(report.spans.is_empty());
}

#[test]
fn exact_nanoseconds_above_js_safe_integer_and_u64_boundary() {
    let exact = 18_446_744_073_709_551_610u64;
    let mut numeric = span(1, 1, None, exact, 5);
    numeric["startTimeUnixNano"] = json!(exact);
    numeric["endTimeUnixNano"] = json!(u64::MAX);
    let mut store = Store::new(0.0);
    ingest(&mut store, vec![numeric]);
    let detail = store.detail(&id(1), 0, 10);
    assert_eq!(detail["spans"][0]["startTimeNs"], exact.to_string());
    assert_eq!(detail["spans"][0]["endTimeNs"], u64::MAX.to_string());
    assert_eq!(detail["spans"][0]["durationMs"], 0.000005);
    let mut overflow = span(2, 2, None, 0, 1);
    overflow["endTimeUnixNano"] = json!("18446744073709551616");
    assert_eq!(
        ingest::parse(&document(vec![overflow]), "otlp")
            .unwrap()
            .rejected,
        1
    );
}

#[test]
fn invalid_json_empty_unsupported_and_bad_envelopes_fail() {
    for (text, format) in [
        ("", "otlp"),
        ("{", "otlp"),
        ("{}", "otlp"),
        ("[]", "otlp"),
        ("{\"resource_spans\":[]}", "otlp"),
        ("{}", "protobuf"),
    ] {
        assert!(ingest::parse(text, format).is_err(), "{text}");
    }
    assert!(ingest::parse("{\"resourceSpans\":[{}]}", "otlp").is_err());
    let empty = ingest::parse("{\"resourceSpans\":[]}", "otlp").unwrap();
    assert!(empty.spans.is_empty());
    assert!(!empty.warnings.is_empty());
}

#[test]
fn jsonl_envelopes_are_atomic_on_structural_or_json_error() {
    let mut store = Store::new(0.0);
    let valid = document(vec![span(1, 1, None, 0, 1)]);
    for invalid in ["{", "{}"] {
        assert!(
            store
                .ingest(&format!("{valid}\n{invalid}"), "jsonl")
                .is_err()
        );
        assert_eq!(store.arena.active, 0);
    }
    assert_eq!(
        store
            .ingest(
                &format!("{valid}\n\n{}", document(vec![span(2, 2, None, 0, 1)])),
                "jsonl"
            )
            .unwrap()
            .accepted_spans,
        2
    );
}

#[test]
fn input_size_limit_checked_before_parsing() {
    assert!(
        ingest::parse(&" ".repeat(MAX_INPUT_BYTES + 1), "otlp")
            .err()
            .unwrap()
            .contains("32 MiB")
    );
}

#[test]
fn retained_roots_mark_parent_child_and_expired_objects_sweep() {
    let mut store = Store::new(1000.0);
    ingest(
        &mut store,
        vec![span(1, 1, None, 0, 100), span(1, 2, Some(1), 10, 50)],
    );
    let first = store.collect();
    assert_eq!(first["markedCount"], 2);
    assert_eq!(first["reclaimedCount"], 0);
    store.advance_time(300_001.0).unwrap();
    let expired = store.expire();
    assert_eq!(expired["expiredTraces"], 1);
    assert_eq!(expired["pendingSpans"], 2);
    assert_eq!(store.arena.active, 2);
    assert!(store.detail(&id(1), 0, 10).is_null());
    let collected = store.collect();
    assert_eq!(collected["reclaimedCount"], 2);
    assert_eq!(collected["freeSlotsAfter"], 2);
    assert_eq!(store.arena.active, 0);
    assert_eq!(store.collect()["reclaimedCount"], 0);
}

#[test]
fn pin_preserves_expired_trace_unpin_allows_next_collection() {
    let mut store = Store::new(0.0);
    ingest(
        &mut store,
        vec![span(1, 1, None, 0, 100), span(2, 2, None, 0, 100)],
    );
    assert!(store.pin(&id(1), true));
    assert!(!store.pin("missing", true));
    store.advance_time(300_001.0).unwrap();
    assert_eq!(store.collect()["reclaimedCount"], 1);
    assert_eq!(store.traces.len(), 1);
    assert_eq!(store.detail(&id(1), 0, 10)["pinned"], true);
    store.pin(&id(1), false);
    assert_eq!(store.collect()["reclaimedCount"], 1);
    assert!(store.traces.is_empty());
}

#[test]
fn reclaimed_slots_reuse_generations_and_stale_inspection_hides_occupant() {
    let mut store = Store::new(0.0);
    ingest(&mut store, vec![span(1, 1, None, 0, 10)]);
    let old = store.traces[&id(1)].spans[0];
    store.set_retention(0.0).unwrap();
    store.collect();
    assert_eq!(store.slot(old.index as usize, None)["state"], "reclaimed");
    store.set_retention(300_000.0).unwrap();
    ingest(&mut store, vec![span(2, 2, None, 0, 10)]);
    let current = store.traces[&id(2)].spans[0];
    assert_eq!(old.index, current.index);
    assert_eq!(current.generation, old.generation + 1);
    assert!(store.arena.get(old).is_none());
    let old_view = store.slot(old.index as usize, Some(old.generation));
    assert_eq!(old_view["handleValid"], false);
    assert!(old_view["spanId"].is_null());
    assert_eq!(
        store.slot(current.index as usize, Some(current.generation))["handleValid"],
        true
    );
    assert_eq!(store.arena.reused, 1);
}

#[test]
fn expired_same_id_late_ingest_does_not_resurrect_old_handles() {
    let mut store = Store::new(0.0);
    ingest(&mut store, vec![span(1, 1, None, 0, 10)]);
    let old = store.traces[&id(1)].spans[0];
    store.advance_time(300_001.0).unwrap();
    store.expire();
    ingest(&mut store, vec![span(1, 1, None, 0, 10)]);
    let current = store.traces[&id(1)].spans[0];
    assert_ne!(current, old);
    assert_eq!(store.collect()["reclaimedCount"], 1);
    assert!(store.arena.get(current).is_some());
    assert!(store.arena.get(old).is_none());
    assert_eq!(store.traces[&id(1)].by_span_id.len(), 1);
}

#[test]
fn live_roots_retain_reachable_objects_and_invalid_edges_are_safe() {
    let mut store = Store::new(0.0);
    ingest(
        &mut store,
        vec![span(1, 1, None, 0, 10), span(2, 2, None, 0, 10)],
    );
    let a = store.traces[&id(1)].spans[0];
    let b = store.traces[&id(2)].spans[0];
    // Internal corruption/extended graph test; OTLP links are never strong edges.
    store.arena.get_mut(a).unwrap().children.extend([
        b,
        a,
        Handle {
            index: u32::MAX,
            generation: 1,
        },
        Handle {
            index: b.index,
            generation: b.generation + 1,
        },
    ]);
    store.pin(&id(1), true);
    store.advance_time(300_001.0).unwrap();
    assert_eq!(store.collect()["markedCount"], 2);
    assert!(store.arena.get(b).is_some());
    store.pin(&id(1), false);
    assert_eq!(store.collect()["reclaimedCount"], 2);
}

#[test]
fn links_do_not_keep_other_trace_alive() {
    let mut a = span(1, 1, None, 0, 100);
    a["links"] = json!([{"traceId":id(2),"spanId":"0000000000000002"}]);
    let mut store = Store::new(0.0);
    ingest(&mut store, vec![a, span(2, 2, None, 0, 100)]);
    store.pin(&id(1), true);
    store.advance_time(300_001.0).unwrap();
    assert_eq!(store.collect()["reclaimedCount"], 1);
    assert_eq!(
        store.detail(&id(1), 0, 10)["spans"][0]["links"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn query_filters_sort_pages_and_child_operations() {
    let mut store = Store::new(0.0);
    let mut error = span(2, 3, None, 200, 200);
    error["status"]["code"] = json!(2);
    ingest(
        &mut store,
        vec![
            span(1, 1, None, 100, 100),
            span(1, 2, Some(1), 101, 10),
            error,
        ],
    );
    let result: Value =
        serde_json::from_str(&store.query(r#"{"operation":"operation-2"}"#).unwrap()).unwrap();
    assert_eq!(result["total"], 1);
    assert_eq!(result["traces"][0]["traceId"], id(1));
    let result: Value = serde_json::from_str(
        &store
            .query(r#"{"errorOnly":true,"service":"API","sort":"slowest"}"#)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(result["traces"][0]["traceId"], id(2));
    let result: Value = serde_json::from_str(
        &store
            .query(r#"{"sort":"oldest","offset":1,"limit":1}"#)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(result["traces"].as_array().unwrap().len(), 1);
    assert_eq!(result["total"], 2);
    for bad in [
        r#"{"minDurationMs":-1}"#,
        r#"{"minDurationMs":2,"maxDurationMs":1}"#,
        r#"{"sort":"wat"}"#,
        r#"{"offset":-1}"#,
        r#"{"unknown":true}"#,
    ] {
        assert!(store.query(bad).is_err());
    }
}

#[test]
fn metrics_empty_sparse_and_cache_invalidation() {
    let mut store = Store::new(0.0);
    let empty: Value = serde_json::from_str(&store.metrics()).unwrap();
    assert!(empty["p50Ms"].is_null());
    assert!(empty["errorRate"].is_null());
    ingest(&mut store, vec![span(1, 1, None, 0, 1000000)]);
    let sparse: Value = serde_json::from_str(&store.metrics()).unwrap();
    assert!(sparse["p95Ms"].is_null());
    assert_eq!(sparse["totalSpans"], 1);
    ingest(
        &mut store,
        (2..=100)
            .map(|i| span(i, i, None, 0, i * 1000000))
            .collect(),
    );
    let full: Value = serde_json::from_str(&store.metrics()).unwrap();
    assert_eq!(full["p50Ms"], 50.0);
    assert_eq!(full["p95Ms"], 95.0);
    assert_eq!(full["p99Ms"], 99.0);
    assert_eq!(full["sampleSize"], 100);
    store.set_retention(0.0).unwrap();
    store.expire();
    let expired: Value = serde_json::from_str(&store.metrics()).unwrap();
    assert_eq!(expired["totalSpans"], 0);
}

#[test]
fn clock_and_retention_reject_invalid_inputs() {
    let mut store = Store::new(1000.0);
    for value in [-1.0, f64::NAN, f64::INFINITY, 2_592_000_001.0] {
        assert!(store.set_retention(value).is_err());
        assert!(store.advance_time(value).is_err());
    }
    store.advance_time(50.0).unwrap();
    assert!(store.now() >= 1050.0);
}

#[test]
fn partial_parent_arrival_rebuilds_orphan_into_child() {
    let mut store = Store::new(0.0);
    ingest(&mut store, vec![span(1, 2, Some(1), 2, 10)]);
    assert_eq!(store.detail(&id(1), 0, 10)["missingParents"], 1);
    ingest(&mut store, vec![span(1, 1, None, 1, 100)]);
    let detail = store.detail(&id(1), 0, 10);
    assert_eq!(detail["missingParents"], 0);
    assert_eq!(detail["spans"][1]["depth"], 1);
    assert_eq!(store.collect()["reclaimedCount"], 0);
}

#[test]
fn large_deep_graph_is_iterative_paged_and_reusable() {
    let mut store = Store::new(0.0);
    let report = store
        .ingest(
            &document(
                (1..=10_000)
                    .map(|i| span(1, i, if i == 1 { None } else { Some(i - 1) }, i, 1))
                    .collect(),
            ),
            "otlp",
        )
        .unwrap();
    assert_eq!(report.accepted_spans, 10_000);
    assert_eq!(store.collect()["markedCount"], 10_000);
    let detail = store.detail(&id(1), 9950, 2000);
    assert_eq!(detail["spans"].as_array().unwrap().len(), 50);
    assert_eq!(detail["spans"][0]["depth"], 9950);
    assert_eq!(
        store.slots(0, 100_000)["slots"].as_array().unwrap().len(),
        4096
    );
    assert_eq!(
        store.detail(&id(1), 0, 100_000)["spans"]
            .as_array()
            .unwrap()
            .len(),
        2000
    );
    store.set_retention(0.0).unwrap();
    assert_eq!(store.collect()["reclaimedCount"], 10_000);
    store.set_retention(300_000.0).unwrap();
    ingest(&mut store, vec![span(2, 1, None, 0, 1)]);
    assert_eq!(store.arena.slots.len(), 10_000);
    assert_eq!(store.arena.reused, 1);
}

#[test]
fn shared_metadata_does_not_amplify_detail_payload() {
    let large_text = "x".repeat(4 * 1024 * 1024);
    let mut payload: Value = serde_json::from_str(&document(
        (1..=2000)
            .map(|i| span(1, i, if i == 1 { None } else { Some(1) }, i, 10))
            .collect(),
    ))
    .unwrap();
    payload["resourceSpans"][0]["resource"]["attributes"]
        .as_array_mut()
        .unwrap()
        .push(json!({"key":"large","value":{"stringValue":large_text}}));
    let mut store = Store::new(0.0);
    store.ingest(&payload.to_string(), "otlp").unwrap();
    let detail = store.detail(&id(1), 0, 2000);
    assert_eq!(detail["resources"].as_array().unwrap().len(), 1);
    assert_eq!(detail["scopes"].as_array().unwrap().len(), 1);
    assert!(detail.to_string().len() < 8 * 1024 * 1024);
    assert!(detail["spans"][0].get("resourceAttributes").is_none());
}

#[test]
fn checked_in_synthetic_fixtures_load() {
    let mut store = Store::new(0.0);
    let report = store
        .ingest(include_str!("../../fixtures/otlp-checkout.json"), "otlp")
        .unwrap();
    assert_eq!(report.accepted_spans, 5);
    assert_eq!(report.trace_count, 3);
    assert_eq!(store.detail(&id(1), 0, 10)["errorSpanCount"], 3);
    let report = store
        .ingest(include_str!("../../fixtures/otlp-records.jsonl"), "jsonl")
        .unwrap();
    assert_eq!(report.accepted_spans, 2);
}

#[test]
fn oversized_service_name_fails_before_amplification() {
    let mut payload: Value = serde_json::from_str(&document(vec![span(1, 1, None, 0, 1)])).unwrap();
    payload["resourceSpans"][0]["resource"]["attributes"][0]["value"]["stringValue"] =
        json!("x".repeat(513));
    let mut store = Store::new(0.0);
    assert!(store.ingest(&payload.to_string(), "otlp").is_err());
    assert_eq!(store.arena.active, 0);
}

#[test]
fn slowest_child_summary_is_trace_wide_and_excludes_root() {
    let mut store = Store::new(0.0);
    ingest(
        &mut store,
        vec![
            span(1, 1, None, 0, 1000),
            span(1, 2, Some(1), 1, 10),
            span(1, 3, Some(1), 2, 500),
        ],
    );
    let page = store.detail(&id(1), 0, 1);
    assert_eq!(page["spans"].as_array().unwrap().len(), 1);
    assert_eq!(page["slowestChildSpan"]["spanId"], "0000000000000003");
    ingest(&mut store, vec![span(2, 1, None, 0, 1)]);
    assert!(store.detail(&id(2), 0, 1)["slowestChildSpan"].is_null());
}
