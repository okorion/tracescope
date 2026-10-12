use crate::trace::Span;
use serde_json::{Map, Value, json};
use std::sync::Arc;

pub const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_ACTIVE_SPANS: usize = 1_000_000;
const MAX_WARNINGS: usize = 50;

pub struct ParsedBatch {
    pub spans: Vec<Span>,
    pub rejected: usize,
    pub warnings: Vec<String>,
}

fn warning(batch: &mut ParsedBatch, message: String) {
    if batch.warnings.len() < MAX_WARNINGS {
        batch.warnings.push(message);
    }
}

pub fn parse(input: &str, format: &str) -> Result<ParsedBatch, String> {
    if input.len() > MAX_INPUT_BYTES {
        return Err(
            "입력은 UTF-8 기준 32 MiB 이하여야 합니다. 파일을 여러 OTLP 문서로 나눠 주세요.".into(),
        );
    }
    if input.trim().is_empty() {
        return Err("빈 파일입니다. resourceSpans가 있는 OTLP JSON을 선택해 주세요.".into());
    }
    let mut batch = ParsedBatch {
        spans: Vec::new(),
        rejected: 0,
        warnings: Vec::new(),
    };
    match format {
        "otlp" => {
            let document = serde_json::from_str(input).map_err(|e| format!("JSON 파싱 실패: {e}"))?;
            parse_document(document, &mut batch)?;
        }
        "jsonl" => {
            // Each nonempty line is one complete OTLP ExportTraceServiceRequest.
            // All lines are parsed before the store is mutated.
            for (line, raw) in input.lines().enumerate().filter(|(_, s)| !s.trim().is_empty()) {
                let document = serde_json::from_str(raw).map_err(|e| format!("JSONL {}행 파싱 실패: {e}", line + 1))?;
                parse_document(document, &mut batch).map_err(|e| format!("JSONL {}행: {e}", line + 1))?;
            }
        }
        _ => return Err("지원 형식은 otlp 또는 jsonl입니다. protobuf, Jaeger JSON, 단일 span JSON은 지원하지 않습니다.".into()),
    }
    if batch.spans.is_empty() && batch.rejected == 0 {
        warning(&mut batch, "문서는 유효하지만 Span이 없습니다.".into());
    }
    Ok(batch)
}

fn parse_document(mut document: Value, batch: &mut ParsedBatch) -> Result<(), String> {
    let resources = document.get_mut("resourceSpans").and_then(Value::as_array_mut)
        .ok_or("OTLP JSON의 resourceSpans 배열이 필요합니다. snake_case, Jaeger JSON 및 단일 Span 형식은 지원하지 않습니다.")?;
    for (ri, resource) in resources.iter_mut().enumerate() {
        let resource_attributes = Arc::new(
            resource
                .pointer("/resource/attributes")
                .cloned()
                .unwrap_or_else(|| json!([])),
        );
        validate_attributes(&resource_attributes)
            .map_err(|e| format!("resourceSpans[{ri}]: {e}"))?;
        let service = string_attribute(&resource_attributes, "service.name")
            .unwrap_or_else(|| "unknown_service".into());
        if service.len() > 512 {
            return Err(format!(
                "resourceSpans[{ri}]: service.name은 UTF-8 기준 512 bytes 이하여야 합니다."
            ));
        }
        let service: Arc<str> = Arc::from(service);
        let sample = bool_attribute(&resource_attributes, "tracescope.sample");
        let mut resource_metadata = resource
            .get("resource")
            .cloned()
            .unwrap_or_else(|| json!({}));
        if let Some(object) = resource_metadata.as_object_mut() {
            object.remove("attributes");
        }
        let resource_metadata = Arc::new(
            json!({ "resource": resource_metadata, "schemaUrl": resource.get("schemaUrl") }),
        );
        let scopes = resource.get_mut("scopeSpans").and_then(Value::as_array_mut)
            .ok_or_else(|| format!("resourceSpans[{ri}].scopeSpans 배열이 필요합니다. instrumentionLibrarySpans는 지원하지 않습니다."))?;
        for (si, scope) in scopes.iter_mut().enumerate() {
            let scope_info = Arc::new(
                json!({ "scope": scope.get("scope"), "schemaUrl": scope.get("schemaUrl") }),
            );
            let spans = scope
                .get_mut("spans")
                .and_then(Value::as_array_mut)
                .ok_or_else(|| {
                    format!("resourceSpans[{ri}].scopeSpans[{si}].spans 배열이 필요합니다.")
                })?;
            for (index, value) in spans.iter_mut().enumerate() {
                if batch.spans.len() + batch.rejected >= MAX_ACTIVE_SPANS {
                    return Err("한 번에 1,000,000개를 초과하는 Span은 가져올 수 없습니다.".into());
                }
                match normalize(
                    std::mem::take(value),
                    service.clone(),
                    resource_attributes.clone(),
                    resource_metadata.clone(),
                    scope_info.clone(),
                    sample,
                ) {
                    Ok(span) => batch.spans.push(span),
                    Err(error) => {
                        batch.rejected += 1;
                        warning(
                            batch,
                            format!("resource[{ri}]/scope[{si}]/span[{index}]: {error}"),
                        );
                    }
                }
            }
        }
    }
    Ok(())
}

fn normalize(
    value: Value,
    service: Arc<str>,
    resource: Arc<Value>,
    resource_metadata: Arc<Value>,
    scope: Arc<Value>,
    sample: bool,
) -> Result<Span, String> {
    let Value::Object(mut value) = value else {
        return Err("Span은 JSON 객체여야 합니다.".into());
    };
    let trace_id = identifier(&take_string(&mut value, "traceId")?, 32, "traceId")?;
    let span_id = identifier(&take_string(&mut value, "spanId")?, 16, "spanId")?;
    let parent_span_id = match value.remove("parentSpanId") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.is_empty() || s == "0000000000000000" => None,
        Some(Value::String(s)) => Some(identifier(&s, 16, "parentSpanId")?),
        _ => return Err("parentSpanId는 16자리 16진수 문자열이어야 합니다.".into()),
    };
    let start_ns = timestamp(&mut value, "startTimeUnixNano")?;
    let end_ns = timestamp(&mut value, "endTimeUnixNano")?;
    if end_ns < start_ns {
        return Err("endTimeUnixNano가 startTimeUnixNano보다 빠릅니다.".into());
    }
    let operation_name = take_string(&mut value, "name")?;
    if value.get("status").is_some_and(|s| !s.is_object()) {
        return Err("status는 JSON 객체여야 합니다.".into());
    }
    let status_code = value.get("status").and_then(|s| s.get("code"));
    let status = match status_code {
        None => "unset",
        Some(Value::Number(n)) if n.as_u64() == Some(0) => "unset",
        Some(Value::Number(n)) if n.as_u64() == Some(1) => "ok",
        Some(Value::Number(n)) if n.as_u64() == Some(2) => "error",
        _ => return Err("알 수 없는 Span status.code입니다.".into()),
    }
    .to_string();
    let attributes = value.remove("attributes").unwrap_or_else(|| json!([]));
    validate_attributes(&attributes)?;
    let sample = sample || bool_attribute(&attributes, "tracescope.sample");
    let events = array_or_default(&mut value, "events")?;
    let links = array_or_default(&mut value, "links")?;
    Ok(Span {
        trace_id,
        span_id,
        parent_span_id,
        service_name: service,
        operation_name,
        start_ns,
        end_ns,
        status,
        attributes,
        resource_attributes: resource,
        resource_metadata,
        scope,
        events,
        links,
        metadata: Value::Object(value),
        children: Vec::new(),
        parent: None,
        sample,
    })
}

fn take_string(value: &mut Map<String, Value>, key: &str) -> Result<String, String> {
    match value.remove(key) {
        Some(Value::String(s)) => Ok(s),
        _ => Err(format!("{key} 문자열이 필요합니다.")),
    }
}
fn timestamp(value: &mut Map<String, Value>, key: &str) -> Result<u64, String> {
    let raw = match value.remove(key) {
        Some(Value::String(raw)) => raw,
        // The JSON text is parsed directly by serde_json, never JSON.parse in JS.
        // Its Number retains the full u64 integer, including values above 2^53.
        Some(Value::Number(number)) => {
            return number
                .as_u64()
                .ok_or_else(|| format!("{key}는 uint64 정수여야 합니다."));
        }
        _ => {
            return Err(format!(
                "{key}는 uint64 정수 또는 10진수 문자열이어야 합니다."
            ));
        }
    };
    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!("{key}는 음수가 아닌 10진수 문자열이어야 합니다."));
    }
    raw.parse::<u64>()
        .map_err(|_| format!("{key}가 uint64 범위를 벗어났습니다."))
}
fn identifier(value: &str, length: usize, key: &str) -> Result<String, String> {
    if value.len() != length
        || !value.bytes().all(|b| b.is_ascii_hexdigit())
        || value.bytes().all(|b| b == b'0')
    {
        return Err(format!(
            "{key}는 0이 아닌 {length}자리 16진수 문자열이어야 합니다. base64 ID는 지원하지 않습니다."
        ));
    }
    Ok(value.to_ascii_lowercase())
}
fn array_or_default(value: &mut Map<String, Value>, key: &str) -> Result<Vec<Value>, String> {
    match value.remove(key) {
        None => Ok(Vec::new()),
        Some(Value::Array(v)) => Ok(v),
        _ => Err(format!("{key}는 배열이어야 합니다.")),
    }
}
fn validate_attributes(value: &Value) -> Result<(), String> {
    let Some(items) = value.as_array() else {
        return Err("attributes는 OTLP KeyValue 배열이어야 합니다.".into());
    };
    if items
        .iter()
        .any(|a| !a.get("key").is_some_and(Value::is_string) || a.get("value").is_none())
    {
        return Err("attribute에는 key 문자열과 value가 필요합니다.".into());
    }
    Ok(())
}
fn string_attribute(value: &Value, key: &str) -> Option<String> {
    value
        .as_array()?
        .iter()
        .find(|a| a.get("key").and_then(Value::as_str) == Some(key))?
        .pointer("/value/stringValue")?
        .as_str()
        .map(str::to_owned)
}
fn bool_attribute(value: &Value, key: &str) -> bool {
    value.as_array().is_some_and(|items| {
        items.iter().any(|a| {
            a.get("key").and_then(Value::as_str) == Some(key)
                && a.pointer("/value/boolValue").and_then(Value::as_bool) == Some(true)
        })
    })
}
