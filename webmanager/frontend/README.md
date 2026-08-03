# webmanager frontend

code-docker의 관리자 패널(webmanager) 프론트엔드. Vite + React + TypeScript로 작성된
클라이언트 사이드 렌더링(CSR) 앱이며, 백엔드는 별도 Go 프로젝트(`webmanager/backend`)에서
빌드된다.

## 구현 현황

- 구현됨: Supervisor(프로세스 관리), SSH Keys(authorized_keys 관리), Git Config(gitconfig +
  SSH 호스트 + 커밋 서명(SSH/GPG) + HTTPS credential), Tailscale(전역 설정 + forwards +
  publish 관리 + 상태 조회 — 로그인 필요 시 배너/링크, 내 정보/피어 목록, `GET
  /api/tailscale/status`; 실제 로그인 수행(`tailscale up`)은 범위 밖), Logs(앱/레벨 필터가 있는 로그 뷰어 — vector가
  만드는 실제 로그 데이터를 보여줌, 응답의 `mock` 필드는 항상 `false`), Processes(상단에
  컨테이너 전체 cpu/mem/disk 사용량 요약(cgroup 기준 — `GET /api/system/resources`), 그
  아래 시스템 프로세스 목록 + 리스닝 포트 목록, btop 대체용 — 프로세스/포트 각각에서
  SIGTERM/SIGKILL로 kill 가능), Claude Code(`GET /api/claude/status` 조회 — 로그인 상태 +
  사용 통계 + mise 버전 확인, 그래프/히트맵/Skills/Plugins 포함. 다른 미구현 섹션과 달리
  `implemented: false` placeholder가 아니라 **항상 실제 컴포넌트가 마운트**되고,
  `installed: false`일 때 컴포넌트 내부에서 유령/스켈레톤 배경 + 실제 설치 버튼을 표시(mise
  설치 잡 재사용). 로그인 안 된 상태도 마찬가지로 브라우저 안에서 `claude auth login`
  플로우를 그대로 진행할 수 있는 로그인 패널을 표시)
- 이 문서는 그래프/히트맵 도입 이전(M1) 시점 이후로 갱신되지 않아 나머지도 상당히
  낡아 있음 — mise, Docker (dind), Terminal 모두 이미 구현되어 있고(`../plan.md`의
  "구현 완료" 표가 최신 소스), 테마 토글/Task Manager 개명 등도 이 문서엔 반영 안 됨.
  전체 재정리는 이번 라운드의 범위 밖.

## 개발 모드 실행

```sh
npm install
npm run dev
```

`vite dev`는 `/api/*` 요청을 백엔드 dev 서버로 프록시한다. 프록시 대상은
`VITE_BACKEND_PROXY_TARGET` 환경변수로 지정하며 기본값은 `http://localhost:8081`이다.
Go 백엔드가 다른 포트에서 뜨는 경우 `.env.local`을 만들어 덮어쓴다:

```sh
cp .env.example .env.local
# .env.local 안의 VITE_BACKEND_PROXY_TARGET 값을 실제 백엔드 포트로 수정
```

## 빌드

```sh
npm run build
```

`dist/` 디렉토리가 생성된다. 이 디렉토리는 이후 Docker 이미지 빌드 단계에서 Go 백엔드가
`go:embed`로 포함하게 된다 (별도 통합 작업, 이 프로젝트의 범위 밖).

## 구조

```
src/
  api/            fetch 래퍼(client.ts) + 백엔드 응답 타입(types.ts)
  utils/          시간 포맷 등 유틸리티
  components/
    Layout/       사이드바 + 섹션 메타데이터
    Supervisor/   프로세스 목록/제어(시작/정지/재시작은 window.confirm으로 확인 — webmanager/
                  sshd 정지는 접근 경로가 끊길 수 있다는 추가 경고 문구) + 로그 뷰어
    SshKeys/      authorized_keys 목록/추가/삭제
    GitConfig/    gitconfig, SSH 호스트, 커밋 서명(SSH/GPG 키 관리 포함 — 새로 생성/선택한
                  키는 폼 상태만 바뀔 뿐 저장 버튼을 눌러야 반영된다는 경고를 SSH/GPG 양쪽
                  다 표시), HTTPS credential
    Tailscale/    전역 설정(SOCKS 주소/재시도 간격), forwards, publish 서브섹션 (모든
                  변경 시 tailscale-forward 재시작을 UI에서 안내. add/delete 응답이 에러여도
                  디스크에는 이미 반영됐을 수 있으므로 — 백엔드가 디스크 저장 후 재시작을
                  시도하는 순서라 재시작만 실패할 수 있음 — 성공/실패 관계없이 항상 목록을
                  다시 불러와 실제 상태를 반영)
    Logs/         앱/레벨 필터 + 수동/실시간 새로고침. 빈 문자열/공백만 있는 메시지는
                  "(빈 줄)"로 표시(원본 로그의 공백 줄을 깨진 데이터처럼 보이지 않게)
    Processes/    상단 SystemSummary(컨테이너 전체 메모리/CPU/디스크 사용량 요약 카드 —
                  memory/cpu는 limit이 null이면 퍼센트 바 대신 "제한 없음" 표시, disk는
                  항상 바 표시. 섹션별 `available: false`면 수치 대신 "확인 불가" 표시(다른
                  섹션은 정상 렌더링, 섹션별 독립 처리). 503 등 조회 전체 실패 시 큰 배너
                  대신 요약 자리에 작은 안내문만 표시) + 프로세스 탭(정렬 가능한
                  pid/cpu%/mem%/rss/cmdline 목록) + 포트 탭(LISTEN 중인 tcp/udp 포트 +
                  점유 pid), 각 행에 종료/강제 종료 버튼
    ClaudeCode/   Claude Code CLI 로그인 상태 + 사용 통계(stats-cache.json 기반) 조회.
                  `installed: false`면 스켈레톤 카드 + 설치 안내 오버레이, `installed:
                  true`면 로그인 상태/총 사용량/오늘·이번 주/최장 세션 카드. `auth`/
                  `stats`는 서로 독립적으로 null 열화 가능(로그인 안 됨 표시와 통계
                  "확인 불가" 표시를 각각 따로 처리). 폴링 없음 — 마운트 시 1회 조회 +
                  수동 새로고침 버튼
    Placeholder/  미구현 섹션 공용 "구현 예정" 컴포넌트
    common/       StatusBadge, ErrorBanner, CopyButton 등 공용 UI
```

## 비고

- 인증 UI는 없음 — 리버스 프록시의 forward-auth에 의존한다 (다른 code-docker 서비스와 동일).
- 다크/라이트 테마 전환 로직은 없음. 단일 라이트 톤의 차분한 색상 스킴만 사용한다.
