mod arena;
mod ingest;
mod query;
mod store;
mod trace;

use store::Store;
use wasm_bindgen::prelude::*;

/// Single owner of all imported trace data. String DTOs at the WASM boundary
/// preserve uint64 timestamps and return only requested view pages.
#[wasm_bindgen]
pub struct Engine {
    store: Store,
}

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new(now_ms: f64) -> Self {
        Self {
            store: Store::new(now_ms),
        }
    }
    pub fn ingest(&mut self, input: &str, format: &str) -> Result<String, JsValue> {
        self.store
            .ingest(input, format)
            .map(|report| serde_json::to_string(&report).expect("finite ingest metrics"))
            .map_err(js_error)
    }
    pub fn query(&self, params: &str) -> Result<String, JsValue> {
        self.store.query(params).map_err(js_error)
    }
    pub fn detail(&self, trace_id: &str) -> String {
        self.store.detail(trace_id, 0, 2000).to_string()
    }
    pub fn detail_page(&self, trace_id: &str, offset: u32, limit: u32) -> String {
        self.store
            .detail(trace_id, offset as usize, limit as usize)
            .to_string()
    }
    pub fn metrics(&mut self) -> String {
        self.store.metrics()
    }
    pub fn pin(&mut self, trace_id: &str, pinned: bool) -> bool {
        self.store.pin(trace_id, pinned)
    }
    pub fn set_retention(&mut self, ms: f64) -> Result<(), JsValue> {
        self.store.set_retention(ms).map_err(js_error)
    }
    pub fn advance_time(&mut self, ms: f64) -> Result<(), JsValue> {
        self.store.advance_time(ms).map_err(js_error)
    }
    pub fn expire(&mut self) -> String {
        self.store.expire().to_string()
    }
    pub fn collect(&mut self) -> String {
        self.store.collect().to_string()
    }
    pub fn stats(&self) -> String {
        self.store.stats().to_string()
    }
    pub fn slots(&self, offset: u32, limit: u32) -> String {
        self.store
            .slots(offset as usize, limit as usize)
            .to_string()
    }
    pub fn inspect(&self, index: u32, generation: u32) -> String {
        self.store
            .slot(index as usize, Some(generation))
            .to_string()
    }
}

fn js_error(message: String) -> JsValue {
    JsValue::from_str(&message)
}

#[cfg(test)]
mod tests;
