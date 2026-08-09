# router 하드닝 — 자체 nginx + 소켓화 + Dev Proxy target 검증 + 인증 강제

작성일: 2026-08-07 — router 서브트리 보안 감사(별도 세션, `.claude/worktrees/`에
남은 `security-audit-2026-08-06.md`)에서 실코드 대조 검증까지 끝난 두 CRITICAL
이슈를 계기로 정리.

## 상태

**2026-08-07, 전체 구현 완료 + `.allow-test` 디스포저블 스택에서 실제 컨테이너로
검증 완료.** Phase 0~6 전부 적용됨. 실제 검증한 항목:

- `docker compose build code-docker-router code-docker` 성공.
- `docker exec code-docker-router supervisorctl status`에 `nginx`,
  `router-manager`, `caddy-adapter` 전부 RUNNING, `/run/router-manager.sock`,
  `/run/caddy-admin.sock`, `/run/caddy-adapter.sock` 세 소켓 전부 생성됨.
- `curl http://localhost:80/router/api/auth/status` — router-manager가 nginx
  뒤 유닉스 소켓을 통해 정상 응답(`{"required":false,"source":"unset",...}`).
- `curl http://router:8091/...`를 code-docker 컨테이너 안에서 시도 — 연결 자체가
  안 됨(TCP 리스너가 아예 없음, Finding 2 완전히 해소 확인).
- `/exports/`를 code-docker-internal 소스(컨테이너 안)에서 요청 → 403, 퍼블리시된
  호스트 포트에서 요청 → (매칭되는 expose 없어서) 404 — internal-source deny ACL
  정상 동작.
- Dev Proxy expose 생성 API로 `target: localhost:2019`, `target:
  192.168.1.1:80` 시도 → 둘 다 명확한 에러로 거부, `target: code-docker:3000`은
  정상 생성 — target 검증 계층 정상 동작.
- `/router/api/auth/setup` → 최초 설정 성공 → 인증 없이 쓰기 시도 401 →
  `/router/api/auth/unlock` 성공 후 쿠키로 쓰기 시도 200 → 틀린 현재 비밀번호로
  `/router/api/auth/change` 시도 시 거부 — 인앱 인증 플로우 전체 정상 동작.
- `/manager/`(webmanager)가 router → code-docker → code-docker 자신의 nginx
  체인을 그대로 통과해 200 — 기본 호환 경로(코드서버/webmanager) 회귀 없음 확인.

실측 중 발견해서 고친 두 가지 (최초 설계엔 없던 디테일):
- Caddyfile에서 유닉스 소켓을 comma-joined 주소나 `unix//path`를 site 헤더에
  직접 쓰는 방식 둘 다 실패함(Caddy가 `host="unix", path="/path"`로 오해석,
  `:443` 리스너가 불필요하게 열림) — `bind unix/<path>` 지시어를 블록 안에서
  쓰는 방식으로 교체, 실제 요청으로 검증 완료.
- Arch의 nginx 패키지는 `user` 지시어가 없으면 워커를 비-root로 띄워서
  root:root 0660인 유닉스 소켓에 `Permission denied`가 남 — router의
  nginx.default.conf에 `user root;` 추가(이 컨테이너의 다른 모든
  supervisord 프로그램과 동일한 신뢰 모델).

tinyauth 컨테이너가 이 스택에서 `TINYAUTH_APPURL` 미설정으로 크래시 루프
중이었으나, 이번 작업과 무관한 기존 테스트 환경 설정 갭(이 레포가 관리하는 게
아니라 사용자가 직접 값을 채워야 하는 항목)으로 확인 — 손대지 않음.

## 문제

보안 감사에서 실제 코드로 검증된 내용:

- **Dev Proxy `target` 필드가 문자셋 검사만 하고 목적지를 검증하지 않음**
  (`router/backend/internal/devproxy/devproxy.go`의 `ValidateTarget`,
  `^[a-zA-Z0-9_.:\[\]-]+$` 정규식뿐). RFC1918 LAN 주소는 물론, Caddy 자기 자신의
  admin API(`AdminAddr = "localhost:2019"`, 생성되는 Caddyfile에 `admin off`나
  바인드 제한이 전혀 없어 Caddy 기본값 그대로 뜸)로도 route를 만들 수 있어서,
  `target: localhost:2019`인 route 하나로 Caddy 프로세스 자신이 자기 admin API에
  `reverse_proxy`하게 만들 수 있음 — `POST /load`로 Caddy 설정 전체(임의 리스너/
  reverse_proxy/file_server)를 탈취 가능한 self-SSRF.
- **`router-manager`(router의 Go 백엔드, `router/backend/main.go`)가 `:8091`에
  모든 인터페이스로 바인드**되어 있고, `code-docker-internal`은 플랫 브리지라
  `code-docker`가 nginx를 거치지 않고 `router:8091`에 직접 도달 가능. 여러 코드
  코멘트(`main.go` 헤더, `config/nginx.default.conf`)가 "private-only by design,
  only reachable through this proxy"라고 적어뒀지만, 이건 "호스트 포트를 안
  열었다"만 의미하지 "nginx만 거친다"는 보장이 아님 — 실제로는 네트워크 레벨에서
  전혀 강제되지 않음.
- **`ROUTER_MANAGER_AUTH_PASSWORD_HASH`가 기본 빈 문자열**이라 `Gate.Configured()`가
  false → `RequirePassword`가 모든 요청을 그냥 통과시킴. 위 두 문제와 결합하면,
  기본 설정 그대로 오염된 code-docker가 인증 없이 router-manager의 모든 쓰기
  라우트(Dev Proxy expose CRUD, tailscale config/forwards/publish/login)를 쓸 수
  있음 — 첫 번째 문제(target 미검증)로 바로 이어지는 체인.

## 결정된 방향

사용자와의 논의(원 대화 요약, 상세 근거는 각 Phase 참고)를 거쳐 다음으로 수렴:

1. **router가 자기 몫의 nginx를 갖고 host:80 트래픽을 직접 종단**한다. 지금은
   `host:80 → router(DNAT) → code-docker:80(nginx) → 다시 router:8082/8091`로
   이중 홉인데, router는 이미 `code-docker-internal`+`code-docker-external`
   양쪽에 다리 걸친 유일한 컨테이너라 스스로 종단하는 게 더 정확한 아키텍처.
   기본값은 기존 동작과 호환(code-server/webmanager는 여전히 `code-docker:80`으로
   위임) — Dev Proxy(`/exports/`)와 router 자체 관리 UI만 router가 직접 처리.
2. **router-manager와 Caddy admin은 유닉스 소켓으로 전환** — TCP 리스너 자체를
   없애서 "nginx만 거친다"는 성질을 네트워크 레벨에서 구조적으로 보장(코멘트가
   아니라 코드로). `/run/supervisor.sock`(supervisord 자체가 이미 쓰는 방식)과
   같은 관례.
3. **Dev Proxy target은 기본 `code-docker-internal`로 제한**(compose 서비스명
   화이트리스트), env var로 opt-out 가능 — 단 router 자기 자신(localhost/
   127.0.0.1/자기 IP)은 opt-out으로도 못 푸는 무조건 거부.
4. **router-manager 비밀번호는 env var 전용에서 인앱 최초설정/변경 플로우로
   전환**. 핵심 통찰(사용자가 직접 짚음): webmanager의 "설정 파일에 저장하면
   재시작으로 우회 가능해서 일부러 env-var 전용"이라는 제약은 "신뢰 못 할 쪽이
   자기 프로세스를 재시작해 자기 설정을 바꾸는" 시나리오를 막기 위한 것인데,
   router-manager는 정반대 위치에 있음 — code-docker는 router의 파일시스템에도
   프로세스 재시작 권한에도 접근이 없는 별도 컨테이너이므로, router 자신의
   볼륨에 비밀번호를 저장하고 router 자신의 인증된 API로만 바꾸는 건 안전함.

## Phase별 구현 세부사항

세부 파일/함수 단위 계획은 `.claude/plans/cozy-conjuring-stardust.md`(플랜모드
산출물, 세션 로컬)에 있음 — 요약:

- **Phase 1**: `router/backend/main.go`가 `/run/router-manager.sock`으로 바인드
  (env var로 TCP escape hatch 유지). `POST /api/auth/setup`(최초 설정,
  아무 해시도 없을 때만) / `POST /api/auth/change`(기존 비밀번호 확인 후 교체)
  신설, 해시는 `/var/lib/code-docker-router/auth-hash.json`에 저장, env var가
  있으면 그게 항상 우선.
- **Phase 2**: `router/`에 nginx 신설(지금은 전혀 없음, Caddy만 있음) —
  `/exports/` → Caddy, `/router` → router-manager(둘 다 유닉스 소켓), 나머지 →
  `code-docker:80`. 설정은 override 패턴이라 런타임에 아무도 못 바꿈. `/exports/`
  위치는 `router_manager_unlock` 쿠키를 반드시 걸러내고, `code-docker-internal`
  소스는 기본 거부(env var opt-out).
- **Phase 3**: `docker-compose.yml` — `code-docker-internal` subnet 고정(ACL용),
  netgate의 `host_port: 80 → code-docker:80` forward 제거(router 자신이 80을
  물면 이 DNAT는 어차피 발동 안 하는 죽은 설정이 됨).
- **Phase 4**: Caddy admin을 유닉스 소켓으로(`ValidateTarget`이 `/`를 허용
  안 해서 route target으로 지정 자체가 불가능해짐 — 구조적 차단). 서빙 포트는
  소켓+기존 TCP 둘 다 유지(`docs/dev-proxy.md`의 "CADDY_ADAPTER_PORT 직접
  퍼블리시" 대안을 안 깨기 위해).
- **Phase 5**: `ValidateTarget` 위에 목적지 검증 레이어 — 기본
  `code-docker`/`dind`만 허용, env var로 전체 제한 해제 가능하지만 router
  자기 자신 거부는 예외 없이 항상 적용.
- **Phase 6**: `tailscale-notify.default.js`와 같은 패턴의 code-patch 배너 +
  webmanager 쪽 배너로, 비밀번호 미설정 상태를 사용자가 agent를 돌리기 전에
  보게 함.

## 범위 밖 (일부러 안 함, 이번 라운드)

- 문서 전면 개정 — 당시엔 `.claude/backlog/router-nginx-docs-todo.md`에
  체크리스트만 남기고 실제 개정은 나중으로 미뤘음(사용자 명시적 판단) — 이후
  전부 완료되어 `.claude/archive/router-nginx-docs-todo-done.md`로 옮겨짐
  (2026-08-10).
- `/router`를 바깥 도메인에 실제로 연결하는 작업 — 노출 여부는 운영자가 자기
  바깥 리버스 프록시에서 결정할 문제, 이 레포의 in-container nginx 체인에
  하드코딩하지 않음.
- rate limiting(감사 Finding 4)과 tailscale forward/publish 필드 검증 강화
  (Finding 6) — 둘 다 LOW, 별개 이슈.
