# 실제 화면 캡처

2026-10-12 KST, Chromium에서 프로덕션 빌드 `http://127.0.0.1:4173`를 실행해 캡처했다. 모든 데이터는 내장 합성 샘플이며 회사·고객·개인의 실제 트레이스를 포함하지 않는다.

| 파일 | 확인한 상태 |
|---|---|
| overview.png | 1,120 Span, 느린순 정렬, 결제 요청 선택 |
| detail.png | 같은 요청의 실제 시간 Waterfall과 Span 속성 |
| inspector.png | Pin한 Trace의 Handle과 실제 Arena Slot |
| gc-before.png | 엔진 시간 +5분, Pin 외 Trace 만료, Arena 객체는 아직 1,120개 |
| gc-after.png | GC 완료, 1,110개 회수, Pin한 10개 보존 |
| mobile.png | 390×844 viewport, 초기 합성 샘플 120개, 문서 가로 overflow 없음 |

데스크톱 viewport는 1440×1000이다. Overview는 full-page, Detail과 Inspector는 해당 요소 전체를 캡처했다. GC 전후 이미지의 높이가 다른 이유는 완료 후 결과 비교 패널이 추가되기 때문이다. 전후 상태는 화면에 표시된 Span 수·회수량·Pin 유지 여부를 기준으로 비교한다.

재현: `CAPTURE_SCREENSHOTS=1 npm run test:e2e`(POSIX) 또는 PowerShell에서 `$env:CAPTURE_SCREENSHOTS='1'` 설정 후 `npm run test:e2e`를 실행한다. 원본과 캡처 manifest는 별도 로컬 capture-artifacts에도 보존한다.
