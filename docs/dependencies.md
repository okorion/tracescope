# 의존성 선택

2026-10-12 공식 문서와 npm/crates.io registry를 확인했다. Context7의 라이브러리 검색·문서 조회도 Vite, wasm-bindgen, serde_json에 사용했다. 설치한 전이 의존성은 `package-lock.json`, `engine/Cargo.lock`에 고정한다.

| 기능 | 채택 | 대안과 판단 |
|---|---|---|
| 화면 | React 19.3.0, Vite 8.3.4, TypeScript 7.0.2 | 지정 스택. Vite 8은 Node 20.19+ 또는 22.12+ 필요. 프로젝트는 Node 22.12+를 요구하며 CI는 24 사용 |
| JSON | serde, serde_json | JSON 문법·정수·오류 처리를 직접 구현하지 않음 |
| WASM 경계 | wasm-bindgen 0.2.129 | crate와 CLI 버전 일치, 빌드 시 공식 바이너리 SHA-256 확인 |
| 객체 저장 | 직접 구현한 Generational Arena | slotmap 1.1.1(Zlib)을 검토했으나 Arena·GC 직접 구현 요구를 따름 |
| Waterfall / Arena | 브라우저 렌더링 / Canvas 2D | D3 7.9.0(ISC)은 선형 시간 막대에 불필요한 추가 의존성 |
| 목록 | Rust 페이지네이션 | TanStack Virtual 3.14.15(MIT) 대신 화면 결과만 반환하여 전체 목록 복제를 피함 |
| 통합 검증 | Playwright 1.64.0 | 실제 Chromium에서 WASM·사용자 흐름 확인 |

React·Vite·plugin-react는 MIT, TypeScript·Playwright는 Apache-2.0, serde·serde_json·wasm-bindgen·js-sys는 MIT OR Apache-2.0다. 개발 도구를 포함한 lockfile은 `npm audit`로 점검한다. 보안 공지를 확인한 사실이 미공개 취약점 부재를 보장하지는 않는다.

이 제품에는 수집 서버·OTel SDK·전체 Observability 백엔드가 필요하지 않다. OTLP JSON 파일 입력과 로컬 분석에 필요한 범위만 처리한다. 시간 계산은 원본 나노초를 Rust u64로 유지하고, 브라우저에는 문자열과 상대 ms를 반환한다. 인증·네트워크 저장·실시간 스트림 라이브러리는 사용하지 않는다.

## 확인 자료

- [OTLP JSON 규칙](https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding): hex ID, numeric enum, lowerCamelCase, 64-bit 숫자 인코딩
- [Trace protobuf 스키마](https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/trace/v1/trace.proto)
- [Vite 설치와 Node 조건](https://vite.dev/guide/), [Vite 보안 공지](https://github.com/vitejs/vite/security/advisories)
- [wasm-bindgen 0.2.129](https://github.com/wasm-bindgen/wasm-bindgen/releases/tag/0.2.129)
- [Rust wasm32 플랫폼](https://doc.rust-lang.org/rustc/platform-support/wasm32-unknown-unknown.html)
- [serde_json](https://github.com/serde-rs/json), [slotmap](https://docs.rs/slotmap/latest/slotmap/)
- [D3](https://d3js.org/what-is-d3), [TanStack Virtual](https://github.com/TanStack/virtual)
- [WebAssembly memory.grow](https://webassembly.github.io/spec/js-api/#dom-memory-grow): 증가 뒤 memory buffer를 다시 조회
