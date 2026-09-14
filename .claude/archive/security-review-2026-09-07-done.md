# code-docker 보안 검토 보고서 (2026-09-07)

> **2026-09-14 수정 상태** — 아래 항목은 모두 워킹 트리에 수정되어 있으며 **아직 커밋하지 않았다** (루트, `router/`, `code-dind/` 세 저장소). `.allow-test` 스택에 새 이미지로 올려 라이브 검증까지 마쳤다.
>
> | # | 상태 | 검증 |
> |---|---|---|
> | C1 | 완료 | `docker swarm init` / `plugin ls` / `service ls` → `authorization denied by plugin dind-authz`, 일반 `docker run` 정상. 단위 테스트 30개 |
> | C2 | 완료 | code-docker·sibling(roblox) 네트워크에서 `/router/api/*`, `/exports/` 모두 403, 외부에서 200. 게이트 fail-closed(503), ootb/migrate에 비밀번호 프롬프트(기본 y) |
> | C3 | 완료 | `/code/Projects/x/evil -> /` 경유 PUT/mkdir/delete 전부 400, 루트 안 쓰기 정상. 리포트에 없던 구멍 2개(대상 leaf가 탈출 링크, 재귀 copy) 추가로 막음 |
> | H1 | 완료 | WebDAV GET/HEAD/POST `Content-Disposition: attachment` + `nosniff`, nginx 전역 `nosniff`, `/manager/` `X-Frame-Options: SAMEORIGIN` 라이브 확인 |
> | H2 | 완료 | unix socket이면 `X-Real-IP`, TCP면 `RemoteAddr`로 잠금 키 |
> | H3 | 완료 | v6 주소가 있을 때만 `ip6tables`로 ULA/link-local/loopback 차단 + config의 v6 항목 미러, 실패 시 30초마다 경고. 라이브 재현은 불가(테스트 스택에 v6 없음) |
> | H4 | 완료 | qwreey-fish `706b314` + sha256 핀, 불일치 시 경고 후 건너뜀. code-server 릴리스는 체크섬 파일이 없어 그대로 |
> | Medium | 완료 | clone URL 스킴 제한 + `GIT_ALLOW_PROTOCOL`, `tailscale/status` 게이트(양쪽 사이드바 훅은 `/state`로), CIDR 검증, 조건부 `Secure` 쿠키 |
>
> **검증 중 새로 발견해 고친 것**: router의 `detect_internal_subnet`이 "기본 경로가 아닌 첫 번째" 링크 서브넷만 골라서, sibling 프로젝트 네트워크가 붙은 스택에서는 기존 `/exports/` deny부터 엉뚱한 서브넷(roblox 네트워크)을 막고 있었다. 경고 없이 "감지 성공"으로 보였기 때문에 라이브 테스트가 아니었으면 못 잡았을 것. 이제 기본 경로 인터페이스를 제외한 **모든** 네트워크를 deny하고 시작 로그에 목록을 찍는다(`ROUTER_INTERNAL_SUBNET`은 쉼표 구분 다중값).
>
> **운영자가 할 일**: 이 테스트 스택의 `.env.router`에는 `ROUTER_MANAGER_AUTH_PASSWORD_HASH`가 없어 router 관리 API가 의도대로 503이다. `/router/` 설정 탭에서 비밀번호를 정하면 풀린다. `ROUTER_ENV_VERSION`이 9→10으로 올라 기존 배포는 envmigrate 배너가 뜬다. 프로덕션에는 `migrate.sh` + `--no-cache` 재빌드 필요(router-docker-client는 안 건드렸으므로 캐시 이슈는 없음).

읽기 전용 정적 검토. 파일은 하나도 수정하지 않았고, 실행 중인 컨테이너에 요청을 보내거나 규칙을 덤프하지도 않았다. 모든 항목은 디스크의 소스를 직접 읽어 확인한 것이고, 코드로 확정하지 못한 것은 "미확인"으로 따로 뺐다. 커밋 기준: `main` @ `0da2f3c`.

검토 범위: `webmanager/backend`, `webmanager/frontend`, `router/` (backend, nginx, netgate, tinyauth, tailscale), `code-dind/` (dind-authz 플러그인, dind-entrypoint), 루트 `docker-compose.yml`, `Dockerfile`, `config/**`, `script/*`, `bin/*`, `ootb*.sh`, `migrate*.sh`, `code-server-autoinstall/`.

## 요약

이 프로젝트의 보안 모델은 세 겹의 경계로 이루어진다.

1. 바깥 리버스 프록시의 forward-auth (code-server `auth: none`, webmanager 게이트 기본 off)
2. `code-docker-internal`에 갇힌 워크로드가 바깥으로 못 나가게 하는 netgate (router)
3. code-docker → dind 방향의 호스트 탈출을 막는 dind-authz 플러그인

이 중 2번과 3번이 각각 한 방에 뚫린다. 컨테이너 안에서 도는 에이전트(또는 npm postinstall 같은 임의 코드)가 자기 격리를 스스로 해제할 수 있다는 뜻이고, 이 두 경계가 존재하는 이유 자체가 "그 안의 코드를 못 믿는다"이므로 치명적이다. 1번 경계는 코드상 견고했다(웹소켓 Origin, CSRF, argon2, 레이트리밋 모두 정상).

| # | 심각도 | 요지 | 위치 |
|---|---|---|---|
| C1 | Critical | dind-authz가 `containers/create`, `volumes/create` 외에는 전부 allow. swarm service / plugin 경로로 특권 dind 데몬 → 호스트 root | `code-dind/dind-authz/main.go:66-71` |
| C2 | Critical | router-manager 관리 API가 `code-docker-internal`에서 인증 없이 닿음(비밀번호 미설정이 기본). 워크로드가 netgate 허용목록을 직접 고치거나 관리자 비밀번호를 선점 | `router/config/nginx/nginx.default.conf:277`, `router/backend/internal/authgate/gate.go:405` |
| C3 | Critical | 파일 매니저/WebDAV의 심볼릭 링크 탈출. 삭제·이동은 링크를 아예 해석 안 하고, 새 파일/디렉터리 생성은 검증 실패 시 미해석 경로로 fallback. WebDAV 전용(저신뢰) 비밀번호 보유자가 컨테이너 전체 FS를 root로 읽기/쓰기/삭제 | `webmanager/backend/internal/files/path.go:57,87-97` |
| H1 | High | WebDAV GET이 `Content-Disposition`/`nosniff` 없이 같은 origin에서 inline 렌더 → stored XSS로 code-server/webmanager 동일 origin 장악 | `webmanager/backend/internal/webdavshare/service.go:392`, `config/nginx/nginx.default.conf:196` |
| H2 | High | router-manager 레이트리밋 키가 `RemoteAddr`인데 unix socket이라 모든 호출자가 같은 버킷. C2와 합쳐지면 내부 워크로드가 관리자 전체를 영구 잠금 | `router/backend/handlers_auth.go:22` |
| H3 | High (잠재) | netgate가 IPv4 전용. `ENABLE_IPV6=true`면 egress 필터 0개, 경고도 없음 | `router/config/netgate/firewall.default.sh` |
| H4 | High (공급망) | 첫 부팅 시 root로 floating `main` 스크립트를 `curl \| source` | `config/user-init/user-init.default.sh:32` |

Medium 이하는 아래 별도 절.

## 신뢰 모델 전제 (판정 기준)

- webmanager는 "게이트를 통과한 사람 = root"가 설계다. 따라서 게이트 통과자가 할 수 있는 일을 다른 경로로도 할 수 있다는 것은 그 자체로는 결함이 아니다. 아래에서 그런 항목은 "방어 심층"으로 분류했다.
- 반면 (a) WebDAV 비밀번호(파일 공유 전용, 낮은 신뢰), (b) `code-docker-internal` 안의 워크로드, (c) dind 클라이언트 — 이 셋은 명시적으로 **더 낮은** 신뢰 등급이고, 이들이 위로 올라가는 것은 경계 붕괴다. Critical은 전부 이 경우다.

---

## Critical

### C1. dind-authz가 기본 allow — swarm service, plugin 경로로 우회

**위치**: `code-dind/dind-authz/main.go:66-71`

```go
case isContainersCreate(req.RequestMethod, req.RequestURI):
    allow, reason = evaluate(req.RequestBody, cfg)
case isVolumesCreate(req.RequestMethod, req.RequestURI):
    allow, reason = evaluateVolumeCreate(req.RequestBody, cfg)
default:
    allow, reason = true, ""
```

플러그인은 두 엔드포인트만 검사하고 나머지는 전부 통과시킨다. `dind-entrypoint.sh`는 swarm을 비활성화하지 않는다(그런 dockerd 플래그 자체가 없다). `code-docker-dind`는 `privileged: true`이므로 dind 데몬을 특권으로 조작할 수 있으면 곧 호스트 커널 접근이다.

**우회 경로 1 — swarm service (코드로 확인, 실행은 안 함)**:
```sh
docker swarm init                       # POST /swarm/init → default allow
docker service create --cap-add ALL \
  --mount type=bind,source=/,target=/host alpine sleep infinity
```
`POST /services/create`도 default allow이고, swarm task 컨테이너는 데몬 내부(swarmkit executor)에서 생성되어 HTTP authz 미들웨어를 아예 거치지 않는다. `--cap-add`는 API 1.41부터 서비스에서 지원된다. dind 컨테이너의 `/`(특권 컨테이너이므로 `/dev`에 호스트 블록 장치 포함)를 SYS_ADMIN으로 마운트하면 끝.

**우회 경로 2 — v2 plugin**: `POST /plugins/create`(로컬 rootfs tar + config.json) → `POST /plugins/{name}/enable`. 플러그인 config.json은 `linux.capabilities`, `linux.allowAllDevices`, `mounts`(호스트 경로 bind), `network.type: host`, `pidhost`를 선언할 수 있고, 플러그인은 그 권한으로 runc 컨테이너로 실행된다. 레지스트리 접근도 필요 없다.

**추가 — 파싱 실패 시 allow** (`policy.go:111`, `policy.go:195`):
```go
if err := json.Unmarshal(body, &req); err != nil {
    return true, ""   // fail-open
}
```
플러그인의 좁은 struct로 못 풀면 통과시킨다. 데몬 쪽 디코더와 관대함이 거의 같아서 실제 우회 페이로드는 만들지 못했지만, 나머지가 전부 fail-closed인 플러그인에서 이 한 곳만 방향이 반대다.

**`POST /build`**는 검토 결과 괜찮다. `RUN --mount=type=bind`는 빌드 컨텍스트/스테이지만 바인드하고, `--security=insecure`는 데몬의 `builder.entitlements.security-insecure`(기본 false)가 있어야 한다. 단 daemon.json에서 이걸 켜지 않았는지는 후행에서 한 번 확인.

**수정 방안**:
1. `main.go` 디스패치에 명시적 deny 목록 추가. 메서드 무관하게 URI가 `/swarm/`, `/services`, `/tasks`, `/nodes`, `/secrets`, `/configs`, `/plugins` 를 포함하면 deny (버전 접두사 `/v1.xx/` 제거 후 매칭, `isContainersCreate`와 같은 방식). `docker plugin`, swarm은 이 환경에서 쓸 이유가 없으니 전체 차단이 맞다.
2. `evaluate`/`evaluateVolumeCreate`의 `json.Unmarshal` 실패를 `return false, "malformed body"`로.
3. `policy_test.go`에 위 세 경로(swarm init, services create, plugins create/enable)와 malformed body 케이스 추가.
4. 선택: 기본 정책을 "알려진 읽기/일상 엔드포인트 allow, 그 외 deny"로 뒤집는 것도 고려. 다만 `docker compose`가 쓰는 엔드포인트가 많아 회귀 위험이 있으니 1번 deny 목록이 현실적.

### C2. router-manager 관리 API가 `code-docker-internal`에서 인증 없이 닿음

**위치**: `router/config/nginx/nginx.default.conf:277` (`location /router/`), `router/backend/internal/authgate/gate.go:403-408`

`/exports/`에는 `nginx-service.default.sh`가 생성하는 `deny <internal-subnet>; allow all;`이 붙지만(`:238-239`), `/router/`에는 소스 제한이 전혀 없다. 주석은 "webmanager 탭이 code-docker nginx를 통해 호출하니까"라고 하는데, 확인 결과 **webmanager 백엔드는 `/router/`를 서버 측에서 호출하지 않는다**. 호출자는 브라우저(`RouterEmbed/*`, `RouterAuthSetupBanner.tsx`)뿐이고, 브라우저 요청은 바깥 프록시 → router:80으로 들어오므로 내부 서브넷 소스가 아니다. 즉 이 예외는 근거가 없다.

그리고 게이트는 fail-open이다:
```go
func (g *Gate) RequirePassword(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if !g.Configured() {
            next.ServeHTTP(w, r)   // 비밀번호 미설정 → 전부 통과
            return
        }
```
`ootb.sh:96`에서 router-manager 비밀번호는 기본 답 `n`인 선택 사항이고, `ootb-config.sh`(재설정 경로)에는 아예 질문이 없다. `example-env.router:141`도 주석 처리된 빈 값이 기본이다. 즉 **기본 설치 상태에서 게이트는 꺼져 있다.**

**공격 시나리오** (code-docker 또는 dind 안의 임의 프로세스, 자격증명 0개):
```sh
# egress 차단 목록을 빈 배열로 교체 → RFC1918/호스트 LAN까지 열림
curl -X PUT http://router/router/api/netgate/outbound -d '[]'
# 인바운드 포워드 개설, DNS 리졸버 교체, tailscale publish, tinyauth 사용자 추가 등
curl -X POST http://router/router/api/netgate/forwards ...
# 관리자 비밀번호를 먼저 선점해 운영자를 잠가버림
curl -X POST http://router/router/api/auth/setup -d '{"password":"x"}'
```
`PUT /api/netgate/outbound`는 `netgate.ReplaceOutbound(LiveConfigPath, ...)`로 즉시 적용된다(`handlers_netgate.go:32`). netgate가 존재하는 이유가 "안의 에이전트를 못 믿는다"이므로, 그 에이전트가 자기 울타리를 고칠 수 있다는 것은 기능 전체의 무효화다.

**수정 방안** (둘 다 할 것):
1. `nginx.default.conf`의 `location /router/`에 `/exports/`와 같은 `${NGINX_DENY_INTERNAL_EXPORTS_DIRECTIVE}`(또는 전용 변수)를 넣는다. webmanager 탭은 브라우저에서 오므로 깨지지 않는다. 깨지는 것이 있다면 그것이 바로 이 취약점을 쓰는 경로다.
2. `RequirePassword`를 fail-closed로: `!Configured()`면 `503 "router-manager password not configured"`로 거부하고 `/api/auth/setup`만 열어둔다. 그리고 setup 엔드포인트도 1번 deny 뒤에 둔다. 읽기 GET(`/api/auth/status`, `/api/tailscale/state` 등 배너용)은 열어둬도 된다.
3. `ootb.sh`/`ootb-config.sh`에서 router-manager 비밀번호를 필수로(최소한 기본 답 `y`, 그리고 `RECONFIGURE` 경로에도 추가). 미설정 시 router-manager 시작 로그 한 줄이 아니라 webmanager 배너처럼 지속 경고(배너는 이미 있음, 게이트 동작 자체를 바꾸는 2번이 본질).

### C3. 파일 매니저/WebDAV 심볼릭 링크 탈출

**위치**: `webmanager/backend/internal/files/path.go`

```go
// :57 ResolveNonRoot — delete / rename / move-source 에서 사용
func ResolveNonRoot(root, userPath string) (string, error) {
    resolved, err := ResolvePath(root, userPath)   // 문자열 검사만, 링크 해석 없음
    ...
    return resolved, nil
}

// :87 ResolveForAccess — mkdir / content PUT / list / download / move-dest 에서 사용
func ResolveForAccess(root, userPath string) (string, error) {
    resolved, err := ResolvePath(root, userPath)
    real, err := filepath.EvalSymlinks(resolved)
    if err != nil {
        return resolved, nil        // :94 — 리프가 없으면 미해석 경로를 "안전"으로 반환
    }
```

`filepath.EvalSymlinks`는 경로 구성 요소 중 하나라도 없으면 에러다. 새 파일/디렉터리 생성은 항상 리프가 없으므로 이 fallback을 타고, 조상 디렉터리에 바깥을 가리키는 링크가 있어도 OS가 그대로 따라간다. `ResolveNonRoot`는 링크를 아예 안 본다.

이 두 함수는 WebDAV도 그대로 쓴다(`internal/webdavshare/fs.go:55,66`). 패키지 주석은 "symlink hole을 닫는다"고 하지만 새 리소스에는 닫히지 않는다.

**호출 경로 (전부 확인)**:
- `handleFilesDelete` → `files.Delete` (`mutate.go:53`) → `ResolveNonRoot` → `os.RemoveAll`
- `handleFilesRename`/`Move` 소스 → `mutate.go:37,105` → `ResolveNonRoot`
- `handleFilesContentPut` → `content.go:84` → `ResolveForAccess` → `os.CreateTemp(dir)` + `os.Rename`
- `handleFilesMkdir` → `mutate.go:23` → `ResolveForAccess` → `os.MkdirAll`
- WebDAV `MKCOL`/`PUT`/`DELETE` → `fs.go` `check`/`checkNonRoot` → 같은 함수

**전제 조건**: `/code` 아래에 바깥을 가리키는 링크가 하나 있어야 한다. `git clone`은 링크를 보존하므로 `evil -> /`를 담은 저장소 하나를 (Projects 탭 clone이든 터미널에서든) 받는 순간 성립한다. 현재 `data/code` 상위 4단계에서는 그런 링크를 찾지 못했다(일부 디렉터리는 권한상 못 봄).

**공격 시나리오**: WebDAV 비밀번호만 가진 사용자(설계상 "파일 공유만" 되는 저신뢰 등급)가
```
PUT  /webdav/Projects/repo/evil/etc/cron.d/x     → 실제로는 /etc/cron.d/x 에 root로 기록
DELETE /webdav/Projects/repo/evil/etc/passwd     → 실제 /etc/passwd 삭제
```
webmanager 게이트가 켜져 있어도 WebDAV는 별도 비밀번호라 무관하다. 게이트가 꺼진 상태에서는 파일 매니저 API로 같은 일이 되지만, 그 경우는 이미 터미널이 있으므로 경계 붕괴는 아니다. 핵심은 WebDAV 경계.

**수정 방안**:
1. `ResolveForAccess`: `EvalSymlinks` 실패가 `os.IsNotExist`면 fallback 대신 **존재하는 가장 긴 조상**을 `EvalSymlinks`로 해석하고, 남은 접미사를 붙인 뒤 다시 `ResolvePath(root, ...)`로 검증. 그 외 에러는 거부.
2. `ResolveNonRoot`: 마지막 구성 요소만 남기고 부모 디렉터리를 1번과 같은 방식으로 해석·검증. (마지막 요소는 링크 자체를 지우는 게 맞으므로 해석하지 않음.)
3. 직접 짜는 대신 `github.com/cyphar/filepath-securejoin`(`SecureJoin`)을 쓰는 것이 안전하다. TOCTOU까지 막으려면 `openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS)` 기반의 `securejoin.OpenInRoot`가 있고, Linux 전용이니 이 이미지에서는 문제없다.
4. `path.go`에 테스트 추가: 조상 링크 + 새 리프, 조상 링크 + 삭제, 리프 자체가 링크인 삭제(허용되어야 함).
5. `internal/files/upload.go`는 대상 **디렉터리**를 먼저 해석하므로 이 버그에 걸리지 않는다. 그 패턴을 기준으로 삼으면 된다.

---

## High

### H1. WebDAV stored XSS → 공유 origin 장악

`webdavshare/service.go:392`가 GET을 `x/net/webdav` 핸들러에 그대로 넘기고, 이 핸들러는 `http.ServeContent`로 확장자 기반 MIME(`text/html`, `image/svg+xml`)을 inline으로 응답한다. `Content-Disposition`도 `X-Content-Type-Options: nosniff`도 스택 어디에도 없다(nginx, webmanager, router 전부 grep 0건). `config/nginx/nginx.default.conf:196`은 이걸 code-server/webmanager와 **같은 origin**의 `/webdav/`에 노출한다.

시나리오: WebDAV 자격 보유자가 `evil.html`을 PUT → 운영자에게 `https://user:pass@host/webdav/evil.html` 링크(Chrome은 최상위 탐색의 userinfo를 허용) → 같은 origin에서 스크립트 실행 → `fetch('/manager/api/terminal', ...)`, code-server(auth none). 전용 호스트네임(`code-docker:82` vhost)으로만 노출했다면 origin이 분리되어 영향이 그 호스트에 갇힌다. 포트 80의 경로 기반 변형이 문제.

수정:
- WebDAV GET 응답에 `Content-Disposition: attachment` 강제 (webdav 핸들러 앞에서 `w.Header().Set`, 또는 `ResponseWriter` 래퍼로 `WriteHeader` 직전에 주입).
- nginx `http{}`에 `add_header X-Content-Type-Options nosniff always;` 전역 추가. `/webdav/`, `/app/`, `/exports/`에는 추가로 `Content-Security-Policy: sandbox` 고려.
- 문서(`docs/tips/webdav.md`)에 "경로 기반 변형은 origin을 공유하므로 전용 호스트네임 권장"을 명시.

### H2. router-manager 레이트리밋 버킷이 하나뿐 → 전역 잠금 DoS

`router/backend/handlers_auth.go:22` `clientKey`는 `r.RemoteAddr`를 쓰는데 router-manager는 unix socket을 듣는다(`main.go` `listen()`). 모든 호출자의 `RemoteAddr`가 동일하므로 잠금 버킷이 하나다. C2로 내부 워크로드가 `/api/auth/unlock`을 계속 틀리게 치면 관리자 전원이 무기한 잠긴다. webmanager 쪽 `clientKey`는 TCP `RemoteAddr`라 이 문제가 없다.

수정: nginx가 `/router/`에서 `X-Real-IP`를 무조건 덮어쓰므로(`nginx.default.conf:297`) 그 값을 키로 쓴다. `ROUTER_MANAGER_ADDR`가 TCP로 바뀌는 경우를 대비해 "unix socket일 때만 헤더 신뢰" 조건을 둔다. C2 수정(내부 deny)이 근본 대책.

### H3. netgate IPv6 미적용 (잠재)

`router/config/netgate/firewall.default.sh`는 `iptables`/`ip -4`만 쓴다. `ip6tables`, `disable_ipv6` 참조가 netgate 설정과 두 compose 파일 전체에서 0건. `example-env`는 `ENABLE_IPV6`를 정식 옵션으로 문서화한다. 지금 기본값은 `false`라 살아있는 구멍은 아니지만, 켜는 순간 IPv6로는 필터 0개이고 아무 경고도 없다.

수정: 최소한 `ENABLE_IPV6=true`면 netgate 시작 시 fail-loud(거부 또는 지속 경고). 제대로 하려면 `ip6tables`에 `fc00::/7`, `fe80::/10`, `::1/128` 및 동일한 forward 정책을 미러링하거나, 컨테이너 sysctl로 `net.ipv6.conf.all.disable_ipv6=1`을 강제.

### H4. 첫 부팅 시 root로 floating 스크립트 `curl | source`

`config/user-init/user-init.default.sh:32`:
```sh
fish -c "curl -sL 'https://raw.githubusercontent.com/qwreey/qwreey-fish/refs/heads/main/functions/qs_setup.fish' | source && qs_setup"
```
supervisord 이전, root, 볼륨당 1회. 체크섬/핀 없음. 본인 저장소라 신뢰 등급은 이미지와 같지만, GitHub 계정/토큰 탈취 한 번이 새 볼륨마다 root RCE가 된다. 같은 부류로 `code-server-autoinstall/install.sh:39`의 code-server tarball도 릴리스의 SHA256SUMS 검증 없이 `curl | tar`.

수정: 커밋 SHA로 핀하고 `sha256sum -c`로 검증한 뒤 source. code-server는 릴리스 자산의 체크섬 파일과 대조. 이 memory의 "설치 스크립트에 조용한 건너뛰기 금지" 원칙대로 실패 시 로그 남기고 skip.

---

## Medium / 방어 심층

- **`ext::`/`file://` clone URL** (`webmanager/backend/handlers_projects.go:198`): 스킴 제한이 없어 `{"url":"ext::sh -c 'id'"}`가 git의 `protocol.ext.allow=user` 기본값으로 실행된다. 인자 주입은 `--`로 잘 막았다. 다만 이 라우트는 게이트 뒤에 있고, 게이트 통과자는 이미 터미널이 있으므로 경계 붕괴는 아니다. 수정: `cmd.Env`에 `GIT_ALLOW_PROTOCOL=http:https:git:ssh` 추가, 또는 `-c protocol.ext.allow=never -c protocol.file.allow=never`. 5줄이면 끝나니 하는 게 맞다.
- **targetguard 루프백 문자열 목록** (`router/backend/internal/targetguard/targetguard.go` `SelfHosts`): `localhost`, `127.0.0.1`, `::1`, `router`, `forward` 문자열만 막는다. 기본 allowlist가 켜져 있어 지금은 무해하지만 `*_ALLOW_EXTERNAL_TARGETS=true` 디버그 플래그를 켜면 `127.1`, `2130706433`, `0:0:0:0:0:0:0:1` 같은 표기로 Caddy admin API/tinyauth(127.0.0.1:3000)에 도달 가능. 수정: 호스트를 해석한 뒤 `net.ParseIP`로 `127.0.0.0/8`, `::1`, 그리고 router 자신의 인터페이스 IP를 거부.
- **DNS 53번 미제한**: netgate는 목적지 CIDR 차단 목록만 있고 포트 제한이 없어 `8.8.8.8:53`로 직접 질의하면 dnsmasq 차단목록을 우회하고 DNS 터널링도 가능. CLAUDE.md가 이미 "best-effort"로 명시한 설계 결정이지만, 하드 보장을 원한다면 UDP/TCP 53을 router 자신으로만 허용하는 규칙을 config 목록 앞에 추가.
- **`GET /api/tailscale/status` 무인증**: tailnet 전체 피어 목록(호스트명, IP, 태그, 온라인 여부)이 노출. C2 수정 전까지는 내부 워크로드도 읽을 수 있다. 배너용으로는 `state.go`의 `AuthURL/BackendState`만으로 충분하니 status는 게이트 뒤로.
- **`netgate.ReplaceOutbound` CIDR 미검증** (`router/backend/internal/netgate/config.go`): 빈 문자열만 거부. argv 단일 요소로 iptables에 전달되어 주입은 아니지만 `net.ParseCIDR`로 검증해야 잘못된 규칙이 조용히 적용되지 않는다.
- **보안 헤더 전무**: `X-Content-Type-Options`, `X-Frame-Options`/`frame-ancestors`, CSP가 nginx/webmanager/router 어디에도 없다. router-manager 로그인 폼은 임의 origin에서 프레임 가능(클릭재킹). 수정: nginx `http{}`에 `nosniff` 전역, `/router/`와 `/manager/`에 `X-Frame-Options: SAMEORIGIN`(webmanager가 router를 iframe하므로 router 쪽은 `frame-ancestors 'self' <webmanager origin>`).
- **router-manager 쿠키가 공유 origin에 기본 배치**: `ROUTER_MANAGER_HOSTS` 미설정이 기본이라 `/router/`의 unlock 쿠키가 code-server/App Routes와 같은 origin. H1 같은 XSS 하나가 router-manager까지 이어진다. 이미 문서화된 트레이드오프이나 `ootb-config.sh`에서 권장 기본으로 유도할 것.
- **auth 쿠키 `Secure` 미설정** (webmanager `gate.go:291`, router `gate.go:392`): TLS 종료 프록시 뒤라 실효 위험은 낮다. `X-Forwarded-Proto: https`일 때 `Secure: true` 조건부 설정이 무난.
- **`/etc/sudoers.d/makepkg` NOPASSWD:ALL 이 최종 이미지에 남음** (`script/install-yay.sh:7`): 컨테이너 안이 이미 전부 root라 실질 영향은 없다. yay 사용 시 필요하므로 삭제보다는 "알고 있음"으로 기록.

---

## 확인했고 문제 없던 것

후행 에이전트가 다시 파지 않아도 되도록 적는다. 전부 코드를 직접 읽어 확인.

- **터미널/VNC WebSocket Origin**: `coder/websocket` `Accept(w, r, nil)` 기본값이 `Origin == Host`를 강제. `OriginPatterns`/`InsecureSkipVerify` 사용 없음. 크로스사이트 WS 하이재킹 불가.
- **CSRF**: 두 authgate 모두 `HttpOnly + SameSite=Strict`, HMAC-SHA256 토큰 + `hmac.Equal`, argon2id(RFC 9106 파라미터), idle 10분/절대 12시간. webmanager 레이트리밋은 TCP `RemoteAddr` 기준이라 XFF 스푸핑 무효. CORS 헤더 설정 없음.
- **webmanager 게이트 커버리지**: `main.go` 라우트 ~170개 확인. 코드 실행·설정 변경·비밀 읽기 라우트는 전부 `RequirePassword`. 무게이트 GET은 `git/credentials`가 `{host,username}`만 반환하는 등 비밀 누출 없음. `.env`, SSH/GPG 개인키, `~/.claude/.credentials.json`을 반환하는 엔드포인트 없음.
- **exec 인자 주입**: webmanager/router의 모든 `exec.Command`가 argv 슬라이스 + `--` + 선행 `-` 거부 정규식. 2026-08-09 감사 이후 회귀 없음. `dig` 도메인, `tc` 값, vhost 호스트명 모두 charset 검증.
- **`/goto/<id>` 리다이렉트**: 목적지가 env 전용, 쿼리 파라미터 없음. 오픈 리다이렉트 아님.
- **App Routes/Dev Proxy/VNC 대상**: 기본 `targetguard` allowlist(`code-docker`, `dind` + 명시 추가)로 SSRF 불가.
- **frontend**: `dangerouslySetInnerHTML`/`innerHTML`/`eval` 0건. `postMessage` 수신 3곳(RouterFrame, embedTheme, webmanager-launcher 패치) 모두 origin 검사. code-server 패치 JS는 CSP 완화·토큰 노출 없음.
- **파일 다운로드/폰트**: `Content-Disposition: attachment`, 확장자 화이트리스트(`.svg` 제외). 업로드 파일명은 basename만 사용. 사용자 zip 해제 경로 없음(zip-slip 해당 없음).
- **dind-authz가 실제로 검사하는 것**: Privileged, CapAdd, SecurityOpt(seccomp/apparmor/label), Pid/Network/Ipc/Cgroupns host, Devices, DeviceCgroupRules, Binds/Mounts, 볼륨 드라이버 `device` 옵션, `path.Clean` 기반 경로, API 버전 접두사 무관 매칭 — 두 엔드포인트 범위 안에서는 견고. `dind-authz`가 compose 기본 target이고, 플러그인 소켓이 안 뜨면 dockerd를 시작하지 않는 fail-closed.
- **dind 소켓 노출**: `code-docker-internal` IP + unix socket만 바인드. `DIND_AUTHZ_VOLUME`은 dind에만 마운트(code-docker가 자기 정책을 못 고침).
- **nested-dind ↔ host 에이전트**: `netinit-docker`는 호스트 데몬만 본다. dind 안에서 만든 컨테이너는 라벨로 route를 받거나 오인 대상이 될 수 없음(별도 데몬, 별도 스토어).
- **code-docker 권한**: `cap_add`는 `SYS_PTRACE`, `IPC_LOCK`뿐. privileged/docker.sock/host mount/`pid: host` 없음. external 네트워크 미부착, 기본 published port 없음.
- **router 권한**: `cap_add: [NET_ADMIN]`만. privileged/docker.sock 없음.
- **sshd**: 호스트 키는 배포 시 생성(이미지에 미포함), root 비밀번호 설정 명령 없음, 기본 미노출.
- **netgate 규칙 순서**: ESTABLISHED 먼저, forward 대상 ACCEPT, 그다음 CIDR 차단. `ip_forward`는 compose `sysctls`로 선언. tailscale `funnel` 호출 0건, authkey 취급 코드 없음.
- **TRUSTED_PROXIES**: 기본 빈 값 → realip 신뢰 피어 없음. router `realClientIP`의 `X-Real-IP` 신뢰는 nginx가 무조건 덮어쓰므로 안전.
- **git hooks (`ai-trailer.sh`)**: git config 값은 `awk -v`로 argv 전달, 셸 보간 없음. `hook-dispatch` 재귀 없음.
- **비밀 커밋 여부**: `git ls-files`에 실제 `.env*` 없음, example-env의 해시/비밀번호 기본값 전부 빈 값.
- **터미널 입력 디버그 로그**(commit 7999f60/0da2f3c): 클라이언트 `localStorage` 토글, 기본 off, "leave the device"는 수동 클립보드 복사 버튼. 서버/vector로는 안 감. vector는 supervisord 프로그램 6개의 stdout/stderr만 수집, PTY 입력은 기록되지 않음.
- **`ootb-lib.sh` manifest `source`**: 임의 셸 실행이 맞지만 운영자가 직접 입력한 URL의 저장소이고 어차피 그 Dockerfile을 빌드할 것이므로 새 경계 아님.
- **router `static.go`**: `filepath.Join(dir, filepath.Clean("/"+path))` — traversal 없음.

## 미확인 (후행에서 짚을 것)

- swarm task 컨테이너 생성이 authz 미들웨어를 건너뛴다는 것은 moby 아키텍처 지식에 근거한 판단이며, 이번에 라이브로 실행해 보지는 않았다. `.allow-test` 환경에서 `docker swarm init && docker service create --cap-add ALL --mount type=bind,source=/,target=/host ...`로 재현 확인 권장(재현 후 `docker swarm leave --force`).
- dind `daemon.json`에 `builder.entitlements.security-insecure`가 켜져 있지 않은지.
- `/etc/default/ssh`로 복사되는 Arch 기본 `sshd_config`의 `PermitRootLogin`/`PasswordAuthentication` 값(빌드해서 바이트 단위로 보지는 않음).
- C1의 파싱 fail-open의 실제 우회 페이로드 존재 여부(설계 결함은 확정, 익스플로잇은 미구성).
- `/manager/api/fonts/css`가 폰트 이름을 CSS 문맥에서 이스케이프하는지.
- tinyauth 자체(vendored 바이너리)의 로그인 리다이렉트 호스트 검증 — 이 저장소 밖.
- `router/backend/internal/supervisor`, `tinyauthusers/store.go`의 exec 지점 — 한 에이전트 결과가 제때 안 와서 교차 확인 못 함.
- `ROUTER_VHOST_*`/`ALLOWED_HOSTS` 값이 도달하는 모든 nginx 지시어 문맥의 완전 추적.

## 권장 작업 순서 (후행 에이전트용)

1. **C2** — nginx `/router/` deny + `RequirePassword` fail-closed. 가장 작고(수십 줄) 가장 큰 구멍. 테스트: `.allow-test` 스택에서 `docker compose exec code-docker curl -si http://router/router/api/netgate/outbound -X PUT -d '[]'`가 403이어야 하고, 브라우저의 webmanager Dev Proxy/Tailscale 탭은 계속 동작해야 한다.
2. **C1** — dind-authz deny 목록 + fail-closed 파싱 + 테스트. `code-dind`는 서브모듈(`qwreey/dind-authz-docker`)이라 그쪽 저장소에 커밋 후 여기서 bump. 테스트는 위 미확인 첫 항목.
3. **C3** — `securejoin` 도입 또는 조상 해석. `path.go`가 두 소비자(files, webdavshare)의 유일한 경계이므로 여기만 고치면 둘 다 닫힌다. 단위 테스트 필수.
4. **H1** — WebDAV attachment 강제 + nginx `nosniff` 전역. 두 줄짜리.
5. **H2** — `X-Real-IP` 키. C2 이후에는 긴급도 낮음.
6. **H3/H4/Medium** — 여유 될 때. H3는 fail-loud만 먼저.

각 항목은 CLAUDE.md의 "README/문서와 동기화" 규칙에 걸리는 부분이 있다: C2는 `router/docs/router.md`의 `/router/` 접근 설명, H1은 `docs/tips/webdav.md`, C1은 `docs/tips/dind.md`와 `code-dind/CLAUDE.md`.
