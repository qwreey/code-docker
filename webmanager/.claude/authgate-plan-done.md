# 공용 비밀번호 게이트(`internal/authgate`) — 완료

여러 기능 문서가 "비밀번호 게이트 적용됨"이라고만 짧게 언급하고 여기로 링크함 —
이 문서가 그 메커니즘의 단일 소스.

## 기능

- `WEBMANAGER_AUTH_PASSWORD_HASH` 환경변수에 argon2id 해시를 설정하면 활성화,
  **미설정 시 기본적으로 완전히 열림(fail-open)** — 이 게이트가 존재한다는 사실
  자체가 기존 동작을 절대 깨지 않음.
- 해시는 오직 ENV로만 주입(설정 파일 저장 금지 — 컨테이너 안에서 파일을 고쳐서
  우회하는 걸 막기 위함), 시작 시점에 `/etc/environment`에도 같은 변수가 있으면
  조작 가능성으로 보고 무시(fail-open, 서버 자체는 안 죽음).
- 해제하면 세션 쿠키(`webmanager_unlock`, HttpOnly + SameSite=Strict) 발급,
  **TTL 10분**(2026-08-02 두 번째 라운드에 24시간에서 단축 — "계속 요구하면
  쓰기 힘드니 짧은 유예 윈도우가 낫다"는 사용자 판단). 인메모리 세션 저장소,
  컨테이너 재시작하면 전부 날아감(의도된 동작, redis 등 불필요 — 사실상 단일
  사용자 도구라 오버엔지니어링 방지).
- 원래 설계는 `webmanager/.claude/terminal-plan.md`의 "인증" 절 — 거기서
  터미널 전용으로 처음 설계됐다가, 파일 매니저가 두 번째로 같은 급의 게이트를
  요구하면서 재사용 가능한 미들웨어(`Gate.RequirePassword`)로 일반화됨.

## 원칙: 읽기는 열림, 쓰기만 게이트 (예외: 터미널/파일 매니저/Logs는 통째로 게이트)

2026-08-02 두 번째 라운드에 실사용 피드백으로 대폭 확장됨. 원칙:
- **읽기(GET)는 원래 신뢰 모델(리버스 프록시 forward-auth) 그대로 유지.**
- **쓰기(POST/PUT/DELETE)는 게이트.**
- **예외 — 통째로 게이트(읽기 포함)**: 터미널(`GET /api/terminal`), 파일 매니저
  (`/api/files/*` 전부), Logs(`/api/logs/*` 전부 — 로그 내용에 시크릿이 노출될
  수 있다는 판단), Supervisor의 프로그램별 로그 조회(`GET /api/supervisor/
  processes/{name}/log` — 같은 이유).

게이트 대상 라우트 전체 목록:
- Supervisor: `POST .../start|stop|restart`, `GET .../log`
- SSH Keys: `POST /api/ssh/keys`, `DELETE /api/ssh/keys/{id}`
- Git Config: `PUT /api/git/config`, ssh-hosts/credentials의 POST·DELETE,
  `POST /api/git/lfs/install`, `PUT /api/git/config/raw`, `PUT /api/git/signing`,
  `POST /api/git/signing/ssh-key`, gpg-keys의 POST·DELETE, known-hosts의
  POST·DELETE
- Tailscale: config의 PUT, forwards/publish의 POST·DELETE
- Logs: 전체(읽기 포함)
- Terminal: 전체(`GET /api/terminal`, `GET/PUT /api/terminal/settings`)
- 파일 매니저: 전체

게이트 안 함(명시적으로 열어둠): 위 목록에 없는 모든 GET(프로세스 목록, ssh
키 목록, git/tailscale 설정 조회, projects, claude, extensions/mise 조회 등).
**extensions/mise의 설치·삭제(쓰기)는 이번 라운드 범위 밖으로 판단해서 게이트
안 함** — 사용자가 명시적으로 언급 안 한 부분, 나중에 필요해지면 같은 패턴으로
저비용 추가 가능.

## 프론트: 전역 401 인터셉터

개별 탭마다 잠금 UI를 만들지 않고 `src/api/client.ts`의 `request()`에 전역
인터셉터를 심음 — 어떤 `api.get/post/put/del` 호출이든 401을 받으면 자동으로
전역 잠금 모달(`src/components/common/UnlockModal.tsx`)을 띄우고, 성공하면
원래 요청을 자동 재시도. Git/Tailscale/SSH처럼 "읽기 열림, 쓰기만 잠김"인
화면은 이 인터셉터에 전적으로 의존(폼은 항상 보이고, 저장 버튼을 눌렀을 때만
잠금 모달이 뜸). Logs/Terminal/파일 매니저처럼 통째로 게이트된 화면은 기존
`src/components/common/RequiresUnlock.tsx`(탭 진입 시점에 바로 안내)를 사용.

## 아직 안 된 것

- **해시 계산 CLI 헬퍼 없음** — 지금은 `internal/authgate.HashPassword`를
  직접 호출하는 Go 스니펫으로 해시를 만들어야 함. `question.md` 참고.
- **터미널 자체가 `RequiresUnlock`으로 안 감싸져 있음** — WebSocket 특성상
  REST와 다른 처리 필요, 지금은 설정 API(`/api/terminal/settings`)는 전역
  인터셉터 혜택을 받지만 WS 업그레이드 자체가 401이면 조용히 실패함(에러 UI
  없음). `question.md` 참고.
