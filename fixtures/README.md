# 가져오기용 합성 데이터

두 파일 모두 사람이 만든 샘플입니다. 실제 요청·고객·회사 데이터는 포함하지 않습니다.

- `otlp-checkout.json`: 3개 서비스, 3개 Trace, 5개 Span. 결제 오류, 부모보다 먼저 도착한 자식, 누락된 부모, 약한 Trace Link, 나노초 정밀도를 확인합니다.
- `otlp-records.jsonl`: 빈 줄을 제외한 각 줄이 하나의 완전한 OTLP `ExportTraceServiceRequest` JSON 객체입니다. Span 하나를 한 줄에 쓰는 형식은 지원하지 않습니다.

앱의 가져오기 버튼에서 파일을 선택할 수 있습니다. 기존 `(traceId, spanId)`와 겹치면 먼저 저장된 Span을 유지하고 중복 수를 보고합니다.
