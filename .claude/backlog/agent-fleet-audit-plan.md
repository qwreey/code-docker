# 병렬 Claude Code 에이전트 격리 + 감사 기록 (아이디어 단계 — 구현 안 함, 질문 정리용)

> **이 문서는 구현하지 않는다.** 조사 + 착수 전 결정 필요한 질문을 정리해두는
> 문서. 특히 "감사 기록의 목적이 뭔지"(회고용 vs 실시간 승인 게이트)와
> "studio 환경까지 계정을 분리할지" 두 가지가 구현 방향을 크게 바꾸므로, 이
> 문서를 읽고 바로 만들지 말고 아래 "미해결 질문"부터 사용자와 확인할 것.

## 동기 (사용자 설명 그대로)

병렬로 컨테이너 여럿을 켜서 Claude에게 개발 도구를 주고 개발을 맡기려 함:

- **Git 저장소 접근 제한**: 모델이 어디로 튈지 모르니 GitHub에서는 작업하지
  않음 — 대신 자체 호스팅 git(예: `git.qwreey.moe`)에 제한된 계정을 만들어
  그것만 쓰게 함.
- **code-docker로 격리**: 컨테이너 환경으로 한 번 감싸서 사용. "studio" 환경도
  메인 계정이 아닌 다른 계정을 사용해야 함.
- 다만 이렇게 격리해도 Claude가 뭘 했는지/뭘 시도했는지 정도의 **기록은
  남기고 싶음**.

## 조사 결과

### 1. Claude Code 자체가 이미 제공하는 기록 메커니즘 (harness 레벨)

- **세션 트랜스크립트**: `~/.claude/projects/<project>/<session-id>.jsonl`에
  프롬프트/모델 응답/툴콜 입력·결과가 전부 JSONL로 남음. **모델이 아니라
  harness 자체가** 세션 진행과 동시에 계속 기록하므로, 정상적으로 동작하는
  에이전트라면 우회할 수 없음. 단 JSONL 스키마는 내부용이라 버전 간 호환을
  보장하지 않는다고 함 — 직접 파싱보다는 `/export`나 `-p --output-format
  json` 같은 구조화 인터페이스를 우선 고려할 것.
  - **이 프로젝트에서는 이미 공짜로 영속화됨, 추가 작업 불필요**:
    `config/user-init.default.sh`가 `HOME=/code`로 고정하고
    `docker-compose.yml`이 `./code:/code`를 이미 영속 마운트하므로,
    `~/.claude/projects/...`는 곧 `/code/.claude/projects/...`가 되어
    호스트에 자동으로 남음(별도 볼륨 마운트나 `CLAUDE_CONFIG_DIR` 지정이
    필요 없음). webmanager 백엔드도 이미 `CLAUDE_CONFIG_DIR` 기본값을
    `/code/.claude`로 잡고 그 밑을 읽고 있어(`webmanager/backend/README.md`)
    이 경로가 이미 이 프로젝트의 공식 관례임. **조건**: 이건 그 인스턴스의
    호스트 `/code` 폴더(또는 `PREFIX`별 상응 폴더)를 지우지 않고 재사용할
    때만 유효 — 병렬 에이전트 컨테이너를 매번 완전히 새 폴더/완전 폐기로
    운영하면 그 인스턴스의 히스토리도 같이 사라짐(순수 운영 방침 문제,
    코드로 막을 방법 아님).
  - **"클로드 기능"으로 나중에 열람하는 것도 이미 내장 기능**: `claude
    --resume`(`-r`, 그 프로젝트 디렉토리의 과거 세션 목록을 보여주고 골라서
    열람/이어가기), `claude --continue`(`-c`, 최근 세션 바로 이어가기),
    세션 안에서 `/resume` 슬래시 커맨드 — 전부 위 트랜스크립트를 그대로
    읽는 Claude Code 자체 기능이라 새로 구현할 게 없음.
- **비대화형(headless) 실행**: `-p`/`--print` + `--output-format
  stream-json`으로 실시간 구조화 이벤트를 stdout에 NDJSON으로 흘려보낼 수
  있음 — 파이프로 외부 수집기에 바로 연결 가능. 자율 개발을 맡기는 시나리오와
  정확히 맞음.
- **훅(hooks)**: `PreToolUse`/`PostToolUse`/`SessionStart`/`SessionEnd` 등
  다수의 이벤트가 있고, 프로젝트 레벨(`.claude/settings.json`) 또는 유저
  레벨(`~/.claude/settings.json`)에서 셸 커맨드나 HTTP 웹훅을 걸 수 있음 —
  Bash/git 명령만 골라 별도로 로깅하는 데 적합. **정확한 전체 이벤트
  목록·페이로드 스키마는 착수 시 실제 설치된 Claude Code 버전 문서로
  재검증 필요**(조사 중 30개 가까운 이벤트가 언급됐으나 전부 확인된 건
  아님, 과신 금지).
- **OpenTelemetry 내보내기**: `CLAUDE_CODE_ENABLE_TELEMETRY=1` +
  `OTEL_EXPORTER_OTLP_ENDPOINT` 등으로 메트릭/이벤트를 외부 OTel
  콜렉터로 보낼 수 있다고 함. `claude_code.tool_decision`,
  `claude_code.tool_result` 같은 이벤트가 감사 목적에 특히 유의미해 보이나
  **정확한 payload 스키마는 실제 붙여봐야 확인 가능**.
- **엔터프라이즈 managed settings**: 조직 단위로 훅/권한 규칙을 강제해서
  에이전트(세션)가 오버라이드 못 하게 하는 기능이 있다고 함 — **개인/
  self-host 규모인 이 프로젝트가 실제로 쓸 수 있는 플랜인지 미확인**(유료
  Team/Enterprise 전용일 가능성 높음). 안 되면 project-level
  `.claude/settings.json` 정도로 타협해야 함.

### 2. "훅 = 보안 경계"는 아니라는 점을 분명히 해둘 것

code-docker 컨테이너 안에서 에이전트가 (보통 그렇듯) 완전한 셸 권한을 가지면,
그 컨테이너 **안에** 있는 로그/훅 설정은 에이전트 자신이 마음만 먹으면
지우거나 우회할 수 있음. 즉 트랜스크립트/훅은 "정상 동작 중인 에이전트의
행동을 기록"하는 용도로는 훌륭하지만, "탈옥/오작동한 에이전트로부터 방어"하는
장치는 아님. 진짜 방어선은 사용자가 이미 설계한 대로 **컨테이너 격리 + 제한된
git 계정** 그 자체 — 기록 시스템은 그 다음 계층인 "사후 가시성/책임 추적"
용도로 자리매김해야 함. 진짜 변조 방지(tamper-evidence)가 필요하다면 로그
싱크가 반드시 해당 컨테이너 **바깥**(호스트, 또는 격리된 별도 컨테이너/
git 서버 자체)에 있어야 의미가 있음.

### 3. code-docker 기존 인프라와의 접점

- **vector 파이프라인 재사용**: 이미 모든 supervisord program의
  `stdout.log`를 태깅해서 `/code/.vector/logs/<date>.jsonl`로 만들고
  webmanager Logs 페이지가 그대로 읽음(루트 `CLAUDE.md` 참고). override
  패턴 그대로 새 supervisord program(예: `config/claude-audit-service.
  default.sh`)을 하나 추가해서 세션 트랜스크립트나 훅 출력을 정규화해
  stdout으로 재발행하면, **새 UI를 만들지 않고도** 기존 Logs 페이지에서 바로
  조회 가능 — 비용 대비 가장 먼저 시도해볼 만한 1단계.
- **webmanager Claude Code 탭**: 이미 존재(설치/버전확인/로그인 자동화까지
  구현됨, `webmanager/plan.md` 참고). 여기에 세션/시도 내역 뷰어를 추가하는
  건 자연스러운 확장처럼 보이지만, `webmanager/.claude/research/
  session-viewer-plan.md`가 이미 "세션"이라는 단어가 이 코드베이스에서
  최소 두 가지(webmanager 인증 게이트 세션, 터미널 PTY 세션)를 가리킨다고
  경고해뒀음 — 여기에 "Claude Code 대화 세션"까지 추가되면 세 번째 의미가
  됨. 착수 시 반드시 용어를 구분해서 명명할 것, 혼동 금지.
- **PREFIX 다중 인스턴스**: `docker compose`가 `PREFIX`로 여러 스택을
  나란히 띄우는 걸 이미 지원함(루트 `CLAUDE.md` 참고) — "병렬 컨테이너"
  자체는 이미 있는 메커니즘이라 새로 만들 필요 없음. 다만 인스턴스별로
  로그/세션이 흩어지므로, 여러 인스턴스를 한 곳에서 모아 보고 싶다면
  (아래 질문 3) 별도의 중앙 수집 지점이 필요함.
- **git 자격증명 UI 재사용**: webmanager Git 설정 탭이 이미 HTTPS
  credential/SSH host 관리 기능을 갖고 있음(`webmanager/.claude/
  qa-request/gitconfig-plan-done.md`) — 제한된 계정의 토큰을 여기로 넣으면
  새로 만들 것 없이 기존 UI를 그대로 재사용 가능.

### 4. git 계정 분리 설계 메모

- `git.qwreey.moe`가 어떤 forge인지(Gitea/Forgejo/GitLab 등)에 따라 세밀한
  스코프 토큰 발급 방식이 다름 — 저장소 단위로 회수 가능하고 만료를 걸 수
  있는 **fine-grained 토큰/deploy token**이 계정 전체 권한을 주는 SSH 키
  하나보다 우수함.
- 자격증명은 이미지에 굽지 않고 컨테이너 기동 시 주입(env var 또는 마운트된
  secret) — webmanager Git 설정 탭이 이미 이 패턴(HTTPS credential 저장)을
  지원하므로 그대로 재사용 가능.
- git 서버 자체의 서버사이드 로그(push 이벤트, webhook)도 별도의 신뢰
  가능한 기록 소스로 쓸 수 있음 — 컨테이너 내부 기록이 전부 지워져도 "실제로
  뭐가 push됐는지"는 git 서버 쪽에 남음. code-docker 범위 밖이지만 감사
  체계의 한 축으로 언급해둠.

## 제안하는 단계적 접근 (아이디어 수준, 우선순위 미정)

1. **0단계(이미 완료됨, 코드 변경 불필요)**: 세션 트랜스크립트 영속화
   자체는 `HOME=/code` + `./code:/code` 마운트 덕분에 이미 동작함 —
   `claude --resume`/`--continue`로 바로 열람 가능. 남은 건 병렬 인스턴스
   운영 시 `/code`에 대응하는 호스트 폴더를 지우지 않고 유지하는 방침뿐.
   **최소 비용 다음 단계**: 이 트랜스크립트를 새 supervisord program 하나로
   기존 vector 파이프라인에 흘려보내서 webmanager Logs 페이지에서도
   조회 가능하게 만들기(원한다면).
2. Bash/git 명령만 골라 사람이 훑어보기 쉬운 요약으로 남기는 `PreToolUse`/
   `PostToolUse` 훅 — 정확한 훅 스키마는 실제 설치 버전 기준 재확인 후 설계.
3. (선택) 여러 `PREFIX` 인스턴스를 한 곳에서 보고 싶다면 OTel 콜렉터 또는
   단순 중앙 로그 디렉토리로 통합.
4. (선택, 최하 우선순위) webmanager에 "에이전트 활동" 뷰어 탭 추가 —
   `session-viewer-plan.md`와 동일하게, 스코프를 사용자와 확정하기 전엔
   만들지 않음.

## 미해결 질문 (사용자가 답할 차례)

1. 감사 기록의 목적이 **"나중에 훑어보는 회고용"**인지, **"위험 행동을
   실시간으로 막는 것"**인지? 후자면 `permissions.ask`/`deny` 조합으로
   승인 게이트가 필요(예: git push는 항상 사람 승인)하고, 전자면 1~2단계
   (트랜스크립트+로그)만으로 충분해 보임.
2. "studio 환경도 메인 계정이 아닌 별도 계정" — 이게 사람이 직접 쓰는 주
   code-docker 인스턴스까지 포함하는 요구인지, 에이전트 전용 병렬 인스턴스
   에만 해당하는지? (전자라면 순수 "에이전트 격리"를 넘어서는, 개인 계정
   전체의 blast-radius 분리 문제로 스코프가 커짐.)
3. 병렬 컨테이너들을 한곳(예: 메인 webmanager)에서 모아 보고 싶은지, 아니면
   인스턴스별로 각자 들여다보는 걸로 충분한지 — 3단계(중앙 수집기)
   착수 여부가 여기 달림.
4. `git.qwreey.moe`가 실제로 어떤 forge인지 — fine-grained 토큰 발급
   방식이 forge마다 달라서 확인 필요.
5. Claude Code의 "managed settings"가 이 프로젝트가 쓰는 플랜(개인/무료 
   /Pro 등)에서 실제로 쓸 수 있는 기능인지 확인 필요.

## 참고

- `webmanager/.claude/research/session-viewer-plan.md` — "세션"이라는
  단어의 다의성 경고, 착수 전 사용자와 인터랙티브 스코프 확인이 필요하다는
  문서 스타일도 동일하게 참고.
- 루트 `CLAUDE.md` — override 패턴, vector 로그 파이프라인, `PREFIX` 다중
  인스턴스 설명.
- `webmanager/.claude/qa-request/gitconfig-plan-done.md` — 기존 git
  자격증명 관리 UI, 재사용 대상.
