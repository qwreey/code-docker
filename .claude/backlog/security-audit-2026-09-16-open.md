# 2026-09-16 감사 3건 트리아지 - 열린 항목

2026-09-16에 작성된 감사 보고서 3건(security-audit-ignoreme.md / Claude Opus 5 /
Antigravity, 아카이브: `.claude/archive/security-audit-2026-09-16.md`,
`audit-claude-opus5-2026-09-16.md`, `audit-antigravity-2026-09-16.md`)을 코드
기준으로 재검증한 결과 아직 열려 있는 항목만 모았다. FIXED/WONTFIX 처리된 항목과
근거는 `.claude/archive/security-audits-2026-09-16-triage-done.md`의 표를 참고.

모두 2026-09-28 기준 실제 코드(`dev/router-docker`, `dev/dind-authz-docker`,
`dev/router-docker-client`, `dev/code-server-autoinstall`, code-docker 본체)를
직접 읽어 확인했다. 악용 절차가 아니라 문제의 종류와 위치만 적는다.

## 2026-09-28에 처리한 항목 (이 목록에서 뺐음)

- F02 dind-authz 심볼릭 링크 우회 — 재현 후 수정: dind-authz-docker `v0.1.1`
  (bind source를 EvalSymlinks로 풀어 재검증, 검사↔마운트 사이 레이스는 잔존 — 코드 주석)
- F15 `UsernsMode=host` — dind-authz-docker `v0.1.2`
- F11 webmanager 잠금 전역 버킷 — code-docker `d1f747e` (loopback 바인드 + nginx
  `X-Real-IP` + `authgate.ClientKey`)
- F04 webmanager CSRF — code-docker `21df74b` (`http.CrossOriginProtection`)
- F12/F13/F14 autoinstall — code-server-autoinstall `v0.1.1` (스테이징 후 교체,
  오프라인 기동, `CODE_SERVER_VERSION` 핀), code-docker `602a1ab`
- F19 폰트 CSS 이스케이프, F24 온볼륨 유닛 이름 — code-docker `35b0391`
- F10 — 문서의 clone 명령에 `-b main` (`a5b488a`). **GitHub 기본 브랜치 설정은
  아직 master** — 저장소 설정 변경이 필요(gh 미인증이라 에이전트가 못 함).
- (관련) router 앞문이 형제 격리망에서 열려 있던 문제 — router-docker `v0.1.1`.
  F34는 이것과 범위가 다르다(외부망 최초 구동 레이스).

---

## F07 [Medium] router-docker - netgate 방화벽 30초 주기 재적용이 원자적이지 않음

- **저장소/위치**: `router-docker`, `config/netgate/firewall.default.sh`의 `apply_rules()`/
  `ensure_chain()` — 여전히 `iptables -F`로 체인을 비운 뒤 규칙을 하나씩 다시 삽입.
- **문제**: 체인이 비어 있는 짧은 시간 동안 FORWARD의 기본 ACCEPT 정책이 적용되어
  RFC1918/메타데이터 IP로 나가는 패킷이 새는 레이스 윈도우가 30초마다 반복된다.
- **방향**: 임시 체인을 만들어 규칙을 채운 뒤 점프 타깃을 원자적으로 교체하거나
  `iptables-restore --noflush` 사용.

## F20 [Medium] router-docker - `ReplaceOutbound`에 IPv4 최소 차단선이 없음

- **저장소/위치**: `router-docker`, `backend/internal/netgate/config.go`의
  `ReplaceOutbound()`(228행 부근) — CIDR/액션 형식만 검사하고 전체 교체를 그대로 저장.
- **문제**: `PUT /api/netgate/outbound []`로 RFC1918/loopback 차단 전체를 지울 수 있다.
  v6는 `firewall.default.sh`의 `apply_rules_v6`가 고정 차단 세트를 config와 무관하게
  항상 적용하지만 v4엔 이 backstop이 없다.
- **방향**: v6처럼 v4용 고정 차단 세트를 코드에 박거나, RFC1918 블록을 없애거나 허용
  규칙보다 아래로 내리는 교체 요청을 거부.

## F17 [Medium] router-docker - netgate forwards / tailscale publish가 targetguard 허용목록을 안 거침

- **저장소/위치**: `router-docker`, `backend/internal/netgate/config.go`의 `validateHost()`
  (문자셋 정규식뿐), `backend/internal/tailscale/config.go:73`(`SelfHosts`만 검사, 전체
  allowlist는 미적용). `devproxy`/`approutes`만 `targetguard.Validate()`를 통과함.
- **문제**: `POST /api/netgate/forwards {"targetHost":"router","targetPort":81}`로
  router 자신의 관리 포트에 self-SSRF성 DNAT을 꽂을 수 있고, tailscale publish를
  `target_host: dind`로 만들면 인증·TLS 없는 dind 도커 소켓이 tailnet 전체에 노출된다.
  09-07 리뷰 이후 두 API 모두 비밀번호 게이트 뒤에 있어 원격 공격은 아니지만,
  "운영자가 한 번 실수하면 호스트 루트"로 이어지는 안전장치 누락.
- **방향**: 두 경로 모두 `targetguard.Validate`/`WithExtraHosts`를 통과시킨다.

## F35 [Low-Medium] router-docker - `targetguard.SelfHosts`가 루프백 대역을 문자열로만 비교

- **저장소/위치**: `router-docker`, `backend/internal/targetguard/targetguard.go`의
  `SelfHosts` 맵(`localhost`/`127.0.0.1`/`::1`/`router`/`forward`만 정확히 일치).
- **문제**: `127.0.0.2`, `0.0.0.0`, 10진수/IPv4-mapped 표기 등은 걸러지지 않는다. 다만
  이 경로가 실제로 쓰이려면 `*_ALLOW_EXTERNAL_TARGETS=true`(명시적으로 "디버그 전용"
  이라고 문서화된 옵션)가 켜져 있어야 하므로 기본 배포에서는 도달 불가.
- **방향**: `net.ParseIP` 기반으로 `IsLoopback()`/`IsUnspecified()` 등을 검사하도록 교체.

## F18 [Medium] router-docker - 인증 없는 GET들이 내부 토폴로지/접속자 PII를 노출

- **저장소/위치**: `router-docker`, `backend/main.go` — `GET /api/dev-proxy/exposes`,
  `GET /api/app-routes/apps`, `GET /api/vnc/targets/{name}/clients`,
  `GET /api/dns/blocklist-sources`, `GET /api/dns/custom-hosts`, `GET /api/dns/resolver`,
  `GET /api/netgate/outbound`, `GET /api/netgate/forwards`, `GET /api/netgate/bandwidth` —
  전부 `gate.RequirePassword` 없이 등록되어 있음. `GET /api/tailscale/status`만 09-07
  리뷰에서 게이트 뒤로 옮겨졌다.
- **문제**: 특히 `/api/vnc/targets/{name}/clients`는 인프라 정보가 아니라 현재 보고 있는
  사람의 실제 IP+User-Agent(PII)다.
- **방향**: `tailscale/status`를 막은 기준("운영자의 사설 네트워크/이용자 정보를
  서술한다")을 다른 GET에도 적용해 재검토, VNC 접속자 목록은 반드시 게이트 뒤로.

## F21 [Medium, 일부 UNCLEAR] router-docker - tinyauth 세션 쿠키가 vhost/exports/app 대상에 그대로 전달

- **저장소/위치**: `router-docker`, `config/nginx/nginx.default.conf`의 3단 쿠키 제거
  맵(120-156행) — `router_manager_unlock` 하나만 벗긴다. tinyauth 쿠키를 벗기는 코드는
  파일 전체에 0건.
- **문제**: tinyauth가 업스트림 기본값(`auth.subdomainsenabled`)대로 부모 도메인 전체에
  쿠키를 스코프한다면, `ROUTER_VHOST_*`로 붙인 저신뢰 백엔드가 살아있는 tinyauth 세션
  쿠키를 원본 그대로 받는다.
- **UNCLEAR**: 실제 vendored tinyauth 바이너리가 내려주는 `Set-Cookie`의 `Domain` 값을
  확인해야 결론난다(호스트 단위 스코프면 무해). 실행 중인 인스턴스에서 응답 헤더 한 줄만
  보면 됨.
- **방향**: 스코프가 부모 도메인이면 `/exports/`·`/app/`·모든 vhost 블록에서 tinyauth
  쿠키도 동일하게 벗긴다.

## F22 [Low] router-docker - 일부 환경변수가 nginx 지시어에 검증 없이 삽입됨

- **저장소/위치**: `router-docker`, `config/nginx/nginx-service.default.sh` —
  `ROUTER_MANAGER_HOSTS`(185-196행)/`TINYAUTH_HOSTS`(276-285행)는 `xargs`로 트림만
  하고 문자셋 검사가 없다. `ROUTER_VHOST_*`는 이미 `^[A-Za-z0-9_.*-]+$`로 검증하는
  것과 대비됨. `ALLOWED_HOSTS`/`TRUSTED_PROXIES`/`ROUTER_INTERNAL_SUBNET`도 동일.
- **문제**: 전부 운영자만 쓰는 `.env` 값이라 실질 긴급도는 낮지만, `;`나 `}`가 들어가면
  nginx 지시어/블록 밖으로 나갈 수 있다.
- **방향**: 공용 `validate_nginx_token()` 함수 하나로 통일해 vhost 쪽 검증을 재사용.

## F34 [High, 창 좁음] router-docker - `/api/auth/setup`을 외부에서 먼저 호출해 관리자 비밀번호를 선점할 수 있음

- **저장소/위치**: `router-docker`, `backend/handlers_auth.go`의 `handleAuthSetup()` —
  설계상 `gate.RequirePassword`에 걸리지 않는다(비밀번호가 없을 때만 열려야 부트스트랩이
  되므로).
- **문제**: 2026-09-14 수정(C2/H2, 커밋 `354cd6d`)은 **`code-docker-internal` 등 내부
  네트워크에서** 이 API에 닿는 경로를 막았고, `/api/auth/setup` 자체는 fail-closed 게이트
  범위 밖에 의도적으로 남아 있다. 2026-09-28의 816b5ac(front-door guard)도 "router가
  게이트웨이/VNC 중계로 붙은 다른 망"만 막을 뿐, 정상적인 외부 이용자와 똑같은 인터페이스
  (`code-docker-external`, 즉 `ROUTER_HTTP_BIND:-0.0.0.0`로 열린 host:80)를 통한 접근은
  막지 않는다. 즉 **인터넷에 호스트 80번이 열려 있고 관리자 비밀번호를 아직 설정하지
  않은 최초 구동 시점에는, 정당한 소유자보다 먼저 외부 공격자가 `/router/api/auth/setup`을
  호출해 비밀번호를 선점할 수 있는 창이 남아 있다.** `ootb.sh`가 빌드 직후 이 질문을
  기본값 `y`로 물어보게 바뀌어 창이 좁아지긴 했지만(`ootb-lib.sh`의
  `prompt_router_manager_password`), 사용자가 건너뛰거나 `docker compose up`을 먼저
  실행하면 여전히 열려 있다.
- **09-07 리뷰와의 관계**: 그 리뷰의 C2는 "내부 워크로드의 자기 탈출"을 다뤘고 이미
  고쳐졌다. 이건 "외부 인터넷 이용자의 최초 구동 레이스"로 범위가 다르며 그 수정으로
  닫히지 않았다.
- **방향**: 콘솔/로그에 1회용 setup 토큰을 찍어 그 값을 알아야만 `/api/auth/setup`이
  통과하게 하거나, 비밀번호 미설정 상태에서는 `/router/`를 외부망에서 아예 503으로
  막고 로컬/loopback에서만 설정 가능하게 한다.

## F23 [Medium, 기능 버그] webmanager - 위젯 팝아웃의 세션 해제 경합

- **저장소/위치**: `config/code/code-patch/webmanager-launcher.default.js:207-223`.
- **문제**: `frame.addEventListener("load", go)`를 먼저 달고 그 다음에
  `frame.contentWindow.location.replace(released)`를 호출하는데, `go()`는 "방금 시킨
  이동의 완료"가 아니라 **아무 `load` 이벤트**에나 반응한다. 클릭 시점에 iframe이 이미
  다른 내비게이션 중이면 무관한 `load`가 `go()`를 조기 발사해, 세션을 아직 놓지 않은
  상태로 새 탭이 열려 커밋 `d191619`가 고치려던 "두 클라이언트가 PTY 크기를 두고 싸우는"
  버그가 재현된다.
- **방향**: `load` 핸들러에서 `frame.contentWindow.location.href === released`인지
  확인하거나, 해제된 페이지가 `postMessage`로 준비 완료를 알리게 한다.

## F03 [Medium] webmanager/router - 빈 `ALLOWED_HOSTS` + WebSocket Origin==Host 검사만으로는 DNS Rebinding을 못 막음

- **저장소/위치**: `config/nginx/nginx-service.default.sh`(`ALLOWED_HOSTS` 기본 빈 값 →
  임의 Host 헤더 수락), `webmanager/backend/handlers_terminal.go:89,388`과
  `router-docker/backend/handlers_vnc.go:403`의 `websocket.Accept(w, r, nil)`(Origin이
  Host와 일치하는지만 검사).
- **문제**: 짧은 TTL DNS로 Origin/Host를 동시에 공격자 도메인으로 맞추는 리바인딩
  공격이 이론적으로 가능하다. 다만 authgate/router-manager 게이트가 설정돼 있으면
  세션 쿠키가 없어 여전히 막힌다 — 실제 영향은 F01/F34(인증 미설정 배포)과 결합할 때
  커진다.
- **방향**: `ALLOWED_HOSTS`를 배포 시 필수로 채우도록 유도하거나 기본값에
  localhost/인스턴스 IP를 포함, WebSocket 핸드셰이크에 Host 화이트리스트 검사 추가.

## F16 [Medium] code-docker - `.env*` 파일이 644 + migrate 백업이 무한정 append

- **저장소/위치**: code-docker 루트 `.env`/`.env.router`/`.env.webmanager`(전부 644
  확인됨), `migrate-continue.sh:165`(`cat ... >> ... .bak`).
- **문제**: `WEBMANAGER_AUTH_PASSWORD_HASH`/`ROUTER_MANAGER_AUTH_PASSWORD_HASH`/
  `WEBMANAGER_WEBDAV_PASSWORD_HASH`(argon2id) 파일이 world-readable. `migrate.sh`를
  돌릴 때마다 같은 `.bak`에 그 시점 해시를 포함한 전체 사본이 계속 쌓인다(자르거나
  로테이트 안 됨).
- **방향**: `set_env_var`가 파일을 만든 직후 `chmod 600`(`.bak` 포함), 백업은 `>` 또는
  타임스탬프 이름으로.

## F27 [High] code-docker - CI가 전혀 없음

- **저장소/위치**: 루트 및 `dev/router-docker`, `dev/dind-authz-docker`,
  `dev/code-server-autoinstall`, webmanager 어디에도 `.github/workflows` 없음(재확인).
- **문제**: Go 테스트가 37개 이상 있고 지금 돌리면 전부 통과하는데 아무도 자동으로
  돌리지 않는다. 두 번째 메인테이너는 테스트 스위트가 존재한다는 사실 자체를 발견할
  방법이 없다(`README.md`/`CLAUDE.md`의 Commands 절 어디에도 `go test`가 없음).
- **방향**: `go test` 3개 모듈 + `gofmt -l` + `docker compose config` + `bash -n
  script/*.sh config/**/*.sh`를 도는 GitHub Actions 워크플로 하나.

## F28 [High] code-docker - 본체(code-docker/router)에 healthcheck가 없음

- **저장소/위치**: 루트 `docker-compose.yml` — `healthcheck:`가 `code-docker-dind`
  서비스 한 곳에만 있음(재확인, 340행). `code-docker`/`code-docker-router`/
  `code-docker-netinit-docker`는 없음.
- **문제**: code-server, webmanager, nginx, sshd, dns-local이 supervisord 안에서
  전부 죽어도 `docker compose ps`는 `Up`으로 보인다.
- **방향**: `code-docker`에 `supervisorctl status`가 전 프로그램 RUNNING인지 보는
  healthcheck 추가. dind가 이미 가진 패턴을 참고.

## F31 [Medium] code-docker - 볼륨 기본 경로에 `PREFIX`가 없어 다중 인스턴스가 데이터를 공유함

- **저장소/위치**: 루트 `docker-compose.yml`의 `HOME_VOLUME`/`SSHD_VOLUME`/
  `DIND_VOLUME`/`DIND_AUTHZ_VOLUME`/`ROUTER_VOLUME` 기본값(`./data/code` 등, 재확인,
  `PREFIX` 미포함).
- **문제**: 컨테이너 이름/네트워크는 `PREFIX`로 분리되는데 이 경로들은 아니다. 문서를
  따라 한 디렉터리에서 `PREFIX`만 바꿔 두 인스턴스를 띄우면 `/code`, SSH 호스트키,
  dind 저장소, dind-authz 정책, router 상태를 조용히 공유하며 서로 망가뜨린다.
- **방향**: 기본값을 `./data/${PREFIX}code` 식으로 바꾸거나 최소한 문서에
  "인스턴스마다 별도 디렉터리 필요"를 명시.

## F25 [Low] code-docker - qwreey-fish SHA 핀 이후에도 fisher/mise.run이 여전히 unpinned root curl\|sh

- **저장소/위치**: `config/user-init/user-init.default.sh` 12-23행 주석이 스스로 인정 —
  SHA+sha256으로 핀된 `qs_setup.fish`가 다시 fisher 설치 스크립트를 `curl | source`하고
  floating 브랜치 플러그인을 `fisher install`, `curl https://mise.run | sh`를 실행.
- **문제**: 전부 미핀, 전부 root, 새 `/code` 볼륨마다 반복. "curl-pipe 문제는 고쳤다"로
  기억이 굳을 위험(qwreey-fish 핀만 보이고 이건 안 보임).
- **방향**: 최소한 이 backlog 항목으로 존재를 남긴다(요청받은 조치). 실제 고정은
  qwreey-fish 핀과 같은 방식(SHA+체크섬)을 fisher/mise.run에도 적용하거나, mise는
  자체 버전 핀 메커니즘이 있으니 그걸 쓰도록 전환.

## F26 [Low 모음] 기타 소소한 코드 결함 (전부 재확인됨)

- `router-docker` `backend/handlers_vnc.go`의 `handleVncSocket`에 동시 브리지 수 제한
  없음(인증된 호출자가 fd/고루틴 무제한 소모 가능).
- `router-docker` `internal/vhostpwa/vhostpwa.go:165`의 원격 manifest fetch가
  `MaxBytesReader` 없이 `json.NewDecoder(resp.Body).Decode()`.
- `router-docker` `internal/dns/customhosts.go`/`blocklist.go`의 중복 제거가 대소문자
  구분 - `Example.com`과 `example.com`이 별개로 저장되어 차단이 조용히 무력화될 수 있음.
- `router-docker` `frontend/src/embedTheme.ts:55`의 `message` 리스너에 `event.origin`
  검사 없음(영향은 테마 토글뿐, 코드 자체가 이미 인지하고 있음).
- `webmanager/backend/handlers_files.go:233`의 `var results []files.UploadResult`가
  빈 업로드에서 `{"results": null}`을 반환 - 이 프로젝트의 "Go nil slice → JSON null"
  재발 버그 부류(메모리에 이미 있는 일반 원칙인데 이 자리는 놓침).
- code-docker `Dockerfile`의 makepkg 사용자 + `/etc/sudoers.d/makepkg`
  (`NOPASSWD:ALL`)가 최종 이미지에 영구히 남는데, CLAUDE.md의 "의도적 트레이드오프"
  목록에 없음(문서 누락, yay가 root로 못 도는 구조상 의도적일 가능성 높음).
- code-docker `.dockerignore`가 `.env*`/`*.bak`를 제외하지 않음(지금은 COPY 안 되니
  실질 위험은 없지만 백스톱이 없음).

각 항목 모두 저비용 수정이라 한 번에 묶어 처리해도 되고, 개별로 나눠도 된다.
