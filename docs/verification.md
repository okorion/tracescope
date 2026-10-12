# 실행 검증 기록

기준일: 2026-10-12 KST. 데이터는 합성 OTLP뿐이다.

| 구분 | 결과와 실제 확인 범위 |
|---|---|
| Rust native | 27개 테스트 통과. Arena 세대·경계·이중 회수·overflow, GC root·cycle·Pin·Unpin·late ingest, OTLP/JSONL, 정밀도, 대량·공유 메타데이터, 페이지 밖 병목 후보 |
| Rust 정적 검사 | rustfmt 및 Clippy all-targets, warnings-as-errors 통과 |
| TypeScript | strict typecheck와 프로덕션 웹 빌드 통과 |
| 브라우저 로컬 | Chromium 기능 10개 + 실제 캡처 시나리오 1개, 총 11개 통과 |
| 브라우저 배포 | GitHub Pages `/tracescope/`에서 기능 10개 통과. 캡처 시나리오는 의도적으로 제외 |
| 반응형 | 390×844에서 문서 가로 overflow 없음, 가져오기·상세·Handle 확인 가능 |
| 네트워크 | 파일 가져오기 중 같은 origin 밖 요청 없음. 별도 수집·업로드 기능 없음 |
| 실패 처리 | 빈 파일, 잘못된 JSONL, 지원하지 않는 구조, WASM 다운로드 실패·재시도 표시 |
| 메모리 | 만료와 회수 분리, Pin 보호, 실제 free-slot 증가·재사용, stale Handle 차단 |
| 부하 | 1만·10만 각 5회, 100만 1회 실제 WASM 실행. 전체 입력·Query·GC·재사용 assertion 통과 |
| 의존성 | npm audit에서 알려진 취약점 0건. 전체 보안 감사나 Rust 의존성 보안 검증을 의미하지 않음 |

실행 환경은 Windows 10, Rust 1.99.0 GNU, Node 25.9.0, Chromium 156.0.8078.4다. Windows native DLL 링크에서 `.drectve` 경고가 있었으나 테스트 실행과 WASM 빌드에는 실패가 없었다. GitHub Actions는 Ubuntu·Node 24에서 잠금 파일로 다시 빌드하고 테스트한다.

Pages 검증 시 테스트 harness의 `/` 경로를 `./`로 수정해 저장소 하위 경로를 유지했다. 앱 자산은 Vite `base: './'`로 배포된다. 로컬 테스트 통과만으로 배포 성공을 판정하지 않았다.

CI에서 드러난 초기 검색 debounce의 페이지 초기화 경쟁은 브라우저 시간을 멈추고 다음 페이지 이동 후 250ms를 진행하는 테스트로 재현했다. 수정 전에는 4개 행이 8개로 돌아갔고, 검색어가 실제로 바뀔 때만 debounce를 시작하도록 수정한 뒤에는 선택한 페이지가 유지된다.

실측 [JSON](benchmarks/latest.json)은 실행 환경·각 반복·WASM SHA-256을 담는다. 100만의 입력 427.5초와 GC 840ms, 최대 frame gap 955.4ms는 현재 메인 스레드 구조의 한계다. 100만 데이터의 정확성 확인과 원활한 상호작용 보장은 다른 판단이다. 동일 PC의 다른 작업을 완전히 격리하지 않았으며, JS 구현과 성능 비교하지 않았다.

## 재현 명령

```sh
npm ci
npm run test:engine
npm run fmt:check
npm run lint:engine
npm run format:check
npm run build
npx playwright install chromium
npm run test:e2e
npm run benchmark
```

배포 검증은 `TRACESCOPE_URL=https://okorion.github.io/tracescope/`를 설정한 뒤 같은 E2E 명령을 실행한다. 캡처와 100만 스트레스는 각각 `CAPTURE_SCREENSHOTS`, `BENCH_MILLION` 환경 변수로 명시적으로 선택한다.
