# WebTestPilot 백엔드 가져오기 및 GUI 연동 메모

## 가져온 소스

- 저장소: https://github.com/bibimmando/WebTestPilot
- 선택 브랜치: `feature/member-01/qa-v2`
- 커밋: `3732f56b54906b48bb4bf69e9930138dabceca78`
- 확인일: 2026-11-26 (Asia/Seoul)
- 실제 제품: [`qa/`](qa/), 실행 진입점: [`qa/src/cli.ts`](qa/src/cli.ts)
- 최초 가져오기에서는 원본 브랜치의 전체 192개 파일이 줄바꿈을 포함해 Git blob 해시와 일치함을 확인했다.
- 이후 사용자 요청에 따라 GUI 연결용 로컬 수정을 적용했다. [`LOCAL_SOURCE.json`](LOCAL_SOURCE.json)의 원본 파일 해시는 출처 기준이며 `localIntegration`에 로컬 변경을 구분한다.
- 원격 작업은 브랜치 조회와 다운로드뿐이었다. 푸시·PR·원격 설정 변경은 하지 않았다. 이 폴더에는 `.git`이나 원격 저장소 연결이 없다.

## 이 브랜치를 선택한 근거

14개 브랜치의 파일 구조와 제품 구현을 비교했다. 날짜가 더 최근인 테스트 사이트 브랜치보다 실제 검사 프로그램의 완성 범위를 기준으로 선택했다.

| 브랜치 | 확인 결과 |
|---|---|
| `feature/member-01/qa-v2` | 사이트 탐색·계획 → 실제 Playwright 검사 → 증거 대조 → 분류·재현·판정 → JSON·HTML·PDF 생성이 연결되어 있다. 원본 README와 AGENTS.md가 현재 제품 소스를 `qa/`로 지정한다. |
| `development` | 이전 Python 통합 프로그램이다. 실제 검사와 JSON 보고서는 있으나 README에 PDF가 후속 범위로 남아 있다. |
| `feature/member-02/judgment-integration` | 이전 통합 프로그램과 판단 모듈 보완 코드다. 최종 PDF 생성 제품으로 v2를 대체할 근거가 없다. |
| `feature/member-02/ai-inspector`, `claude-playwright-chain` | 증거 분석 또는 초기 Claude·MCP 연결 단계다. |
| `feature/member-03/*`, `feature/member-04/*` | 주로 테스트 대상 사이트 작업이다. 이전 `integration/`을 포함한 브랜치들은 해당 폴더의 Git tree가 `development`와 동일했다. |
| `main` | 초기 프로젝트·협업 구조다. |

핵심 구현은 [`explore.ts`](qa/src/explore.ts), [`run.ts`](qa/src/run.ts), [`triage.ts`](qa/src/triage.ts), [`report.ts`](qa/src/report.ts)다. `cli.ts`가 이들을 호출하며, `report.ts`의 `writeReport()`는 Chromium의 `page.pdf()`로 PDF를 실제 작성한다.

## 설치 및 실행

원본 CI는 Node.js 24를 사용한다. 다음 명령은 이 폴더에서 실행한다. GUI 프로젝트의 패키지와 별도로 설치한다.

```powershell
npm ci
npm ci --prefix qa
npx playwright install chromium
```

가져온 시점의 실제 검사는 **Anthropic API**를 사용했다. 현재 로컬 GUI 통합은 아래 계약처럼 GPT도 지원한다. `ANTHROPIC_API_KEY` 환경변수 또는 이 폴더 루트의 `.env`가 필요하며, GUI의 OpenAI API 키와는 별개다. 이번 가져오기 작업에서는 키를 설정하거나 모델·API 계약을 변경하지 않았다.

키를 별도로 설정한 후의 실행 예시다. 실제 실행에는 API 비용이 발생한다.

```powershell
node qa/src/cli.ts --url http://localhost:8080/ --name gui-run --budget 2
```

무료 회귀 테스트와 타입 검사는 의존성과 Chromium 설치 후 실행할 수 있다.

```powershell
npx --prefix qa tsc -p qa --noEmit
npm test --prefix qa
```

더 많은 옵션·로그인 설정은 [원본 사용 안내](qa/README.md)를 참고한다. 기본은 시작 URL과 같은 origin 및 쓰기 요청 차단이다. GUI 연동을 이유로 `--allow-writes`나 추가 origin을 자동 허용하면 안 된다.

## GUI 연동에 필요한 계약

현재 GUI 1.0.2은 이 CLI를 별도 Node 프로세스로 실행한다. 내부 `--desktop-events --output-dir` 옵션과 Node IPC로 진행 위치·단계를 받고, 실행별 PDF를 검증한 후 첨부한다. HTTP 서버는 필요하지 않다. 앱 사용법과 설치는 [상위 README](../README.md)를 따른다.

| 항목 | 백엔드의 현재 동작 / 연동 시 처리 |
|---|---|
| 실행 | `electron/backend.cjs`가 별도 Node 24 프로세스로 `qa/src/cli.ts`를 실행한다. 전용 Chromium·의존성과 Node 실행 파일을 배포에 포함한다. |
| 입력 | 테스트 설정의 URL·요구사항·제공자·계획/판정 모델·예산·탐색 시간·페이지/페이지 종류/턴 수·동시 실행 수·추론 수준·탐색 묶음 방식을 검증하여 해당 CLI 옵션으로 전달한다. 자연어 요구사항은 `--requirements` 파일의 `{ "id": "R1", "text": "..." }` 배열이며 화면 표현 프롬프트와 별도다. 임의 CLI 옵션·쓰기 권한·추가 origin은 받지 않는다. |
| 모델·키 | 실제 검사 백엔드 탭에서 Claude/GPT와 계획·판정 모델을 각각 지정하고 이 폴더의 `.env`에 저장한다. 키는 `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` 중 선택된 제공자 것만 전달한다. 화면 표현 AI 탭의 키·모델은 백엔드에 전달하지 않는다. 실행 시 백엔드 전용 설정을 고정하여 전달한다. [.env.example](.env.example)을 참고한다. |
| 로그인 | 사용자가 지정한 일회성 계정은 백엔드와 화면 표현 로그인에 사용한다. 백엔드에는 전용 자식 프로세스 환경변수로만 전달한다. 임시 `--app` 파일에는 같은 출처 로그인 URL·자동 폼 감지 설정·환경변수 이름만 기록하고 실행 후 삭제한다. 계정값은 파일·명령줄·모델 요청·로그에 보관하지 않는다. 로그인 성공과 새 세션의 인증 상태를 확인하며 추가 인증·모호한 폼·실패는 검사 제한으로 기록한다. |
| 화면 표현 | GUI의 횟수 설정은 제거했다. 새 백엔드 탐색·검사 실행 관측에 맞춰 별도 화면 동작을 선택하고 관측이 없으면 기다리며 백엔드 종료 시 함께 정리한다. 실제 검사 범위는 백엔드의 `--max-pages`, `--max-templates`, 턴 등 실행 옵션으로 지정한다. |
| 산출물 | GUI 실행은 앱 데이터의 `backend-runs/<UUID>/report.pdf`, `report.html`, `report.json`에 저장한다. 원래 CLI 실행은 `qa/runs/<name>-<ISO시각>/`을 사용한다. 계획·비용·판정·실행 증거도 해당 실행 폴더에 생성된다. |
| JSON 계약 | 소스 기준 `report.json`의 버전은 **`report/2`**다. 원본 README의 `report/1` 설명은 오래된 내용이다. |
| 완료 판단 | 정상 프로세스 종료·IPC 결과·`report/2`의 대상 URL/해당 실행의 제공자·모델/parameters/판정 단계·PDF 형식과 해시를 검증한다. 미완료 결과는 부분 보고서로 첨부하며 완료 문구를 표시하지 않는다. 전체 페이지 열기 실패는 모델을 호출하지 않고 미완료 진단 보고서를 생성한다. 로컬 서버 연결 거부·DNS·시간 초과 등 실패 종류를 표시하며 미검사를 통과로 세지 않는다. |
| GUI 보고서 연결 | 검증된 이번 실행 PDF를 기존 사본 저장소에 첨부한다. 재첨부도 같은 실행 ID·해시를 확인한다. 원본 `testReport/report.pdf`를 덮어쓰거나 이전 파일로 대체하지 않는다. GUI는 PDF 내용을 생성·수정하지 않는다. |
| 상태 표시 | IPC는 실제 단계·관측 URL·동작 종류만 전달한다. 실행 워커도 실제 이동·조작·검사 시점에 정제한 메타데이터를 임시 진행 파일로 전달하며 부모 실행기가 실행 중 읽어 `executing` IPC로 보낸다. 표시 수집 실패는 검사 결과를 바꾸지 않는다. 화면 표현용 GPT 또는 Claude 모델이 전용 Edge에서 해당 위치를 따라 읽기·클릭·입력을 표현한다. 본문·계정·키·입력값·스크린샷은 표시 채널에 포함하지 않는다. 쿼리는 제거하므로 쿼리로만 구분되는 페이지는 경로 단위로 따라간다. |
| 중지 | Esc·응답 중지·앱 종료는 표시용 Edge와 백엔드 자식 프로세스 트리를 함께 종료한다. 종료를 확인하지 못하면 별도 오류를 알린다. |

연결 책임은 `electron/main.cjs`·`electron/inspection.cjs`·`electron/backend.cjs`에 있다. `electron/site-agent.cjs`는 화면 표현만 담당한다. 모델/키 설정, 진행 상태, 버그 판정 책임은 분리한다. 표시용 Edge의 중복 글 등록은 차단한다.

## 가져오기 당시 검증

- Git 원본과 파일 192개 전체 해시 일치 확인.
- Node.js v24.20.0에서 `qa/src/`·`qa/test/` TypeScript 파일 32개 `node --check` 통과.
- 루트·qa의 `package.json` 및 잠금 파일 4개 JSON 구문 확인.
- 위 항목은 최초 가져오기 시점의 기록이다. 이후 GUI 연결 작업에서는 의존성·전용 Chromium·Node 실행 환경을 설치하고 무료 단위·브라우저 회귀를 수행했다.
- 사용자 요청에 따라 유료 API를 사용하는 실제 사이트 검사는 실행하지 않았다. 기존 `testReport/report.pdf`는 변경하지 않았다.
