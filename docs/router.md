# router

`code-docker-router`는 code-docker의 네트워크 경계를 전담하는 별도 컨테이너입니다.
`code-docker-internal`(사설, code-docker/dind가 붙는 망)과 `code-docker-external`(진짜
인터넷으로 나가는 망) 양쪽에 다리를 걸친 유일한 컨테이너로, code-docker보다 신뢰
수준이 높습니다. 다섯 가지 기능을 담당합니다:

1. **아웃바운드 격리(netgate)** — RFC1918/사설망 차단, DNS 레벨(dnsmasq) 콘텐츠
   블록리스트, 인바운드 포트포워딩. outbound 규칙과 포트포워딩은 "Net 관리" 탭에서,
   DNS 블록리스트/리졸버는 "DNS" 탭에서 웹으로 관리합니다. 자세한 내용은
   [egress-netgate.md](egress-netgate.md).
2. **tailscale** — 데몬+로그인+포트 가져오기(forwards)+포트 내보내기(publish). 아래 참고.
3. **Dev Proxy** — 컨테이너 안 dev 서버를 도메인으로 노출. 자세한 내용은
   [dev-proxy.md](dev-proxy.md).
4. **App Routes** — Host 헤더와 무관한 경로 기반(`/app/<이름>/...`) 리버스
   프록시. 자세한 내용은 [app-routes.md](app-routes.md).
5. **tinyauth** — Dev Proxy/App Routes 개별 항목을 보호하는 가벼운 forward-auth.

이렇게 한데 모은 이유(신뢰 경계가 code-docker보다 명확한 지점에 네트워크 관련 정책을
집중시킨다는 설계)는
[`router/.claude/functional-router-plan.md`](../router/.claude/functional-router-plan.md)에
정리되어 있습니다.

tailscale/Dev Proxy/App Routes/DNS/Net 관리/tinyauth는 전부 webmanager의 해당
탭에서도 관리할 수 있고, `http://<host>/router/`를 직접 열면 webmanager 없이도
같은 화면(+ router-manager 자체 비밀번호 설정을 다루는 "설정" 탭)을 쓸 수
있습니다 — 자세한 내용은 아래 "router-manager" 절.

## tailscale

`docker-compose.yml`의 `TAILSCALE_ENABLED`(기본 `"true"`)로 켜고 끕니다 — `"false"`면
`tailscaled`/`tailscale-forward`/`tailscale-publish` 세 프로그램이 router 컨테이너
안에서 idle 상태로 떠 있습니다. router가 고유한 tailscale IP를 가지므로, tailnet 안
어디서든 code-docker에 접근하거나(호스트 포트 게시 없이) code-docker에서 다른 tailnet
기기의 포트를 가져올 수 있습니다.

### 최초 로그인

자동 로그인 시도는 router 컨테이너 생애주기 동안 딱 한 번만 일어납니다(상태 디렉토리
안 마커 파일로 추적, code-docker 쪽과 동일한 self-DDoS 방지 이유). 로그인 URL은
`docker compose logs -f code-docker-router`로 확인하거나, code-server 화면 우측 상단
배너(같은 code-patch 메커니즘, `tailscale-notify.js`)로도 뜹니다 — 이제 이 배너는
router 자신의 nginx가 host:80에서 직접 종단하는 읽기전용 상태 API
(`GET /router/api/tailscale/state`)를 폴링합니다.

로그인 상태는 `${ROUTER_VOLUME:-./data/router}/tailscale/state`(호스트 경로)에
영속됩니다. 자동 시도를 놓쳤거나 소진된 상태라면 webmanager의 Tailscale 탭에서
로그인을 다시 트리거할 수 있습니다(아래 "router-manager" 참고) — 웹 UI 대신 직접
실행하고 싶다면 `docker compose exec code-docker-router tailscale up`도 여전히
동작합니다.

### forwards / publish

webmanager의 Tailscale 탭(`@code-docker/router-frontend`가 렌더링, router-manager
API를 호출)에서 forwards/publish 추가·삭제·전역 설정(SOCKS 주소/재시도 간격) 변경과
로그인 시작/취소, 상태 조회까지 전부 UI로 할 수 있습니다 — 변경할 때마다
`tailscale-forward`/`tailscale-publish` supervisord 프로그램을 router-manager가
자동으로 재시작해 반영합니다.

설정은 `${ROUTER_VOLUME:-./data/router}/tailscale/config.yaml`(호스트 경로, 컨테이너
안에서는 `/var/lib/code-docker-router/tailscale/config.yaml`)에 그대로 저장되므로,
UI 대신 직접 편집하는 것도 여전히 가능합니다:

```yaml
forwards:
  - name: adb
    local_port: 5037
    remote_host: laptop          # tailscale hostname 또는 IP (MagicDNS 이름 아님)
    remote_port: 5037

publish:
  - name: dev-server
    tailscale_port: 80
    target_host: code-docker     # router에서 보이는 아무 호스트명/IP나 가능 (code-docker, dind, ...)
    local_port: 3000
    mode: tcp                    # tcp | tls-terminated-tcp
```

- **forwards** — 다른 tailnet 기기의 포트를 가져옵니다. code-docker 안에서는 `forward`
  hostname으로 접근하세요(예: [adb 연결](tips/adb.md)의 `ANDROID_ADB_SERVER_ADDRESS=forward`) —
  이 alias는 이제 router를 가리킵니다(예전엔 code-docker 자신).
- **publish** — `target_host`로 지정한 컨테이너의 로컬 포트를 tailscale IP에 게시합니다.
  `local_port`는 router 자신이 아니라 **`target_host`**의 포트를 가리킵니다(router의
  `tailscale-publish` 프로그램이 `tcp://<target_host>:<local_port>`로 타겟팅). `target_host`는
  router에서 `code-docker-internal` 네트워크로 접근 가능한 아무 컴포즈 서비스 호스트명/IP나
  될 수 있습니다 — `code-docker`뿐 아니라 `dind` 등 같은 네트워크의 다른 컨테이너도 게시
  대상으로 쓸 수 있습니다. 생략하면 이전 버전과의 호환을 위해 `code-docker`로 기본
  설정됩니다.

직접 편집한 뒤 UI를 거치지 않고 반영하려면:

```sh
docker compose exec code-docker-router supervisorctl restart tailscale-forward tailscale-publish
```

직접 편집 대신 webmanager의 Tailscale 탭(또는 router-manager
`/api/tailscale/forwards`·`/api/tailscale/publish` API)을 쓰면 저장과 동시에
자동으로 재시작까지 처리됩니다 — 위 수동 재시작 명령은 `config.yaml`을 손으로
편집했을 때만 필요합니다.

### 호스트네임 지정 / 자체 호스팅 로그인 서버

`TAILSCALE_HOSTNAME`/`TAILSCALE_LOGIN_SERVER`(`docker-compose.yml`, `.env`)로 설정합니다 —
이제 router 컨테이너에 적용됩니다(기본 hostname은 `code-docker-router`, `code-docker`가
아님). MagicDNS 이름은 forwards/publish의 `remote_host` 등에 쓰지 마세요 — 동적으로
바뀔 수 있어 tailscale hostname/IP만 신뢰합니다
([functional-router-plan.md](../router/.claude/functional-router-plan.md) 참고).

### 보안

router는 이제 code-docker보다 신뢰 수준이 높은 유일한 국경 컨테이너이므로, tailscaled의
자동 loopback 노출 문제(예전엔 code-docker 자신의 tailscaled가 `private` alias로
우회해야 했음)가 code-docker 쪽에서는 완전히 사라졌습니다 — code-docker 자신은
tailscaled를 아예 실행하지 않기 때문입니다. sshd(22)/code-server(80)는 여전히 tailnet
ACL로 보호하는 걸 권장합니다(router가 명시적으로 forward/publish하지 않는 한 애초에
tailnet에서 도달 불가능하지만, sshd는 호스트 포트 게시를 위해 여전히 `0.0.0.0`에
바인드되어야 하는 code-docker 자신의 이야기입니다).

## tinyauth

Dev Proxy 라우트/App Routes 앱별 "인증 요구"를 지원하는 forward-auth입니다. 별도 컨테이너가 아니라
router 자신의 supervisord 프로그램으로 돕니다 — `router/Dockerfile`이 공식 이미지
`ghcr.io/tinyauthapp/tinyauth`에서 이미 빌드된 바이너리만 멀티스테이지로 추출해
씁니다(소스 빌드는 안 함 — pnpm 프론트엔드 빌드가 필수라 이 레포의 다른 Go 바이너리
빌드 패턴과 안 맞지만, 바이너리 자체를 그대로 복사해오는 데는 문제가 없습니다).
`TINYAUTH_APPURL`이 비어 있으면(tinyauth 자신이 실제 URL 없이는 부팅을 거부하므로)
그냥 대기 상태로 유지되고 크래시 루프를 돌지 않습니다. `TINYAUTH_APPURL`은 실제
도메인 형식(`https://code-docker.example.com`)으로 `.env`에 설정해야 합니다.

사용자는 기본적으로 아무도 없는 상태로 시작합니다 — `/router/`(router-manager UI,
"tinyauth" 탭 — webmanager에도 같은 탭이 있습니다)에서 사용자를 추가/삭제/비밀번호
변경할 수 있고, 그때마다 자동으로
`tinyauth`가 재시작되어 바로 반영됩니다. 비밀번호 변경은 기존 비밀번호를 몰라도
새 비밀번호만 입력하면 되는 관리자용 재설정입니다(router-manager 자체 비밀번호로
이미 인증된 상태에서만 가능 - tinyauth 자신에게는 이런 재설정 API/CLI가 없어서,
매번 `AddUser`처럼 새 해시를 만들어 파일 전체를 다시 쓰는 방식으로 구현했습니다).
`TINYAUTH_AUTH_USERS` 환경변수를 직접
설정하면 그 값이 항상 우선하며(UI로 바꿀 수 없게 고정) UI에는 편집 폼 대신 그
사실이 표시됩니다 — 인프라 코드로 고정하고 싶을 때만 쓰세요:

```sh
docker run --rm ghcr.io/tinyauthapp/tinyauth:v5 user create \
  --username <name> --password <password> --docker
```

출력된 `TINYAUTH_AUTH_USERS=...` 줄을 `.env`에 붙여넣고 `docker compose up -d`로
재기동하세요. 자세한 사용법(라우트/앱에 인증 요구 걸기)은
[dev-proxy.md의 "인증"](dev-proxy.md#인증) 또는
[app-routes.md의 "인증"](app-routes.md#인증)을 확인하세요.

## router-manager

router는 `router-manager`라는 Go 백엔드를 갖고 있습니다(webmanager와 같은 패턴).
router 자신의 nginx가 host:80을 직접 종단해 `/router/` 위치 하나로 모든 API를
유닉스 소켓(`/run/router-manager.sock`) 경유로 프록시합니다 — router-manager
자신은 TCP 포트를 전혀 열지 않습니다(`ROUTER_MANAGER_ADDR`는 컨테이너 밖 로컬
개발용으로만 쓰는 opt-in 예외). 같은 소켓이 API와 함께 `router/frontend`로
빌드된 SPA도 서빙하므로(`router/backend/static.go`), `http://<host>/router/`를
직접 열면 webmanager 없이도 아래 기능을 전부 UI로 쓸 수 있습니다(Dev Proxy/App
Routes/Tailscale/DNS/Net 관리/tinyauth 탭은 webmanager가 가져다 쓰는 것과 정확히
같은 컴포넌트 — router-manager 자체 비밀번호를 다루는 "설정" 탭만 `/router/`
SPA에만 있습니다).
아래 API 경로는 router-manager 자신 기준이고, 실제로는 router의 nginx가 그대로
`/router/api/...`로 통과시킵니다(예: `/router/api/tailscale/state`). 제공하는 것:

- Tailscale 전체 CRUD — `GET`/`PUT /api/tailscale/config`(SOCKS 주소/재시도 간격),
  `GET`/`POST`/`DELETE /api/tailscale/forwards[/{name}]`, 같은 패턴의
  `/api/tailscale/publish[/{name}]`, `GET /api/tailscale/status`(self/peer 정보),
  `POST /api/tailscale/login/{start,cancel}`. webmanager의 Tailscale 탭과 `/router/`
  SPA의 Tailscale 탭이 여기로 요청을 보냅니다. 기존 `GET /api/tailscale/state`
  (backendState/authUrl만 노출하는 저위험 읽기전용 상태)도 그대로 남아 있고,
  code-server 화면의 로그인 배너가 여기서 읽습니다.
- Dev Proxy expose CRUD(`/api/dev-proxy/*`) — webmanager의
  [Dev Proxy 탭](webmanager.md#dev-proxy)과 `/router/` SPA의 Dev Proxy 탭이 여기로
  요청을 보냅니다.
- App Routes 앱 CRUD(`/api/app-routes/*`) — webmanager의
  [App Routes 탭](webmanager.md#app-routes)과 `/router/` SPA의 App Routes 탭이
  여기로 요청을 보냅니다.
- tinyauth 사용자 CRUD(`GET`/`POST /api/tinyauth/users`,
  `PUT /api/tinyauth/users/{name}/password`, `DELETE /api/tinyauth/users/{name}`) —
  webmanager의 tinyauth 탭과 `/router/` SPA의 "tinyauth" 탭(별도 탭이며, "설정" 탭과는
  다릅니다)이 여기로 요청을 보냅니다. 위 "tinyauth" 절 참고.
- DNS 블록리스트/추가 호스트/리졸버 CRUD(`GET /api/dns/blocklist-sources` +
  커스텀 소스용 `POST`/`PUT`/`DELETE /api/dns/blocklist-sources/{name}`,
  내장 소스용 `GET .../builtin/status` + `POST .../builtin/{pull,ignore}`,
  `GET`/`PUT /api/dns/custom-hosts`, `GET`/`PUT /api/dns/resolver`) —
  webmanager와 `/router/` SPA 둘 다의 "DNS" 탭이 여기로 요청을 보냅니다. 같은 탭에
  dig 스타일 조회 도구도 있습니다(`GET /api/dns/query?domain=...&type=...`, 이
  컨테이너 자신의 dnsmasq(`127.0.0.1`)에 직접 질의 — 디버깅 전용이라 다른 DNS
  엔드포인트와 달리 인증 게이트도 없습니다, 어차피 읽기 전용 조회입니다). 자세한
  내용은 [egress-netgate.md](egress-netgate.md)의 DNS 관련 절.
- netgate outbound/포트포워딩 CRUD(`GET`/`PUT /api/netgate/outbound`,
  `GET`/`POST`/`DELETE /api/netgate/forwards[/{hostPort}]`) — webmanager와 `/router/`
  SPA 둘 다의 "Net 관리" 탭이 여기로 요청을 보냅니다. 자세한 내용은
  [egress-netgate.md의 "설정 커스터마이징"](egress-netgate.md#설정-커스터마이징).
- 자체 admin-API 비밀번호 게이트(`GET /api/auth/status`, `POST /api/auth/unlock`) —
  아래 "router-manager 자체 인증" 참고.

### router-manager 자체 인증

router-manager 자신의 관리 API(tailscale config `PUT`, forwards/publish/login의
`POST`/`DELETE`, dev-proxy expose와 app-routes 앱의 `POST`/`PUT`/`DELETE`)는 비밀번호 게이트로
보호할 수 있습니다. 읽기 라우트(state/config/list/status)는 항상 열려 있습니다
— webmanager 자체 게이트와 같은 "읽기는 열어두고 쓰기만 잠근다" 관례입니다.
webmanager와는 별도의 프로세스/비밀(argon2id 해시 + HMAC 서명 쿠키)이라서
webmanager 자체 잠금과 독립적으로 켜고 끌 수 있고, 잠긴 쓰기 요청이 401을
반환하면 webmanager UI가 자동으로 비밀번호 입력 모달을 띄우고 재시도합니다
(`RouterUnlockModalHost`).

**권장: 앱 안에서 설정 (`/router/`)** — 아무것도 설정하지 않은 채 처음
띄우면 `GET /api/auth/status`의 `source`가 `"unset"`입니다. 컨테이너의
`http://<host>/router/`를 열면 router-manager가 직접 제공하는 SPA(webmanager
없이도 접근 가능 — Dev Proxy/App Routes/Tailscale/DNS/Net 관리/tinyauth 사용자
관리까지 전부 이 안에서 되고, "설정" 탭이 기본으로 열립니다)가 뜨고, 그 탭에서 새
비밀번호를 설정하면
`${ROUTER_VOLUME:-./data/router}/auth-hash.json`(컨테이너 안에서는
`/var/lib/code-docker-router/auth-hash.json` — `ROUTER_MANAGER_AUTH_STORE_PATH`로
경로 변경 가능)에 저장됩니다(`source: "file"`). 이후 같은 페이지에서
비밀번호를 바꾸려면 현재 비밀번호를 입력해야 하고(`POST
/router/api/auth/change`, 실패 시 거부), router-manager 자신의 API가 이미
게이트로 보호되어 있으므로 이 파일을 신뢰해도 안전합니다 — code-docker
컨테이너에는 router 컨테이너의 파일시스템/프로세스 재시작 접근 권한이 전혀
없습니다.

**비밀번호를 잊어버렸다면** 도커 호스트에서(컨테이너 밖에서)
`${ROUTER_VOLUME:-./data/router}/auth-hash.json`을 삭제하고
`docker compose restart code-docker-router`로 재시작하세요 — 다시 미설정
상태(`source: "unset"`)로 돌아가 `/router/`에서 새로 설정할 수 있습니다.

**env var로 고정 (`ROUTER_MANAGER_AUTH_PASSWORD_HASH`, `router/example-env.router` 참고)** —
인프라-as-code로 고정하고 싶을 때만 설정하세요(`router-manager
--hash-password`로 argon2id 해시 생성, webmanager의 동명 CLI와 같은 패턴).
설정되어 있으면 파일 저장소보다 항상 우선하고(`source: "env"`), `/router/`
페이지의 비밀번호 변경 폼도 "환경변수로 고정되어 있어 여기서 바꿀 수
없습니다" 메시지로 바뀌어 입력 폼 자체가 사라집니다 — `POST
/router/api/auth/change`를 직접 호출해도 409로 거부됩니다.

tinyauth(위 "tinyauth" 절)와는 완전히 별개입니다 — tinyauth는 Dev Proxy/App Routes로
노출한 개별 dev 서버·앱의 최종 사용자 인증이고, 이건 router-manager 자신의 admin API를
보호하는 것입니다.

#### 보안: 공유 origin과 전용 도메인(`ROUTER_MANAGER_HOSTS`)

router-manager의 잠금 해제 쿠키(`router_manager_unlock`)는 Domain 속성 없는
host-only 쿠키입니다. `/router/` 경로는 기본적으로 code-server/webmanager와
같은 공유 hostname 위에서 서비스되므로, 이 쿠키도 그 origin 전체에 자동으로
붙습니다 — HttpOnly라 JS의 `document.cookie` 읽기는 막지만, 같은 origin에서
실행되는 스크립트(예: webmanager/code-server의 XSS, 혹은 그 안에서 도는
에이전트가 오염된 경우)가 `fetch('/router/api/...')`를 직접 호출하는 건 막지
못합니다. router 자신의 nginx는 Dev Proxy(`/exports/`)와 App
Routes(`/app/`)로 프록시할 때는 이 쿠키를 헤더에서 잘라내지만(사용자가
등록한, 신뢰할 수 없는 대상이 헤더를 그대로 읽어가는 걸 막는 용도 —
`router/config/nginx/nginx.default.conf`의 `router_manager_cookie_stripped`
map), 이건 "프록시된 백엔드가 헤더를 읽는" 경로만 막을 뿐 위에서 말한
같은-origin 스크립트 경로는 막지 못합니다.

이걸 근본적으로 막으려면 router-manager를 아예 별도 origin으로 분리해야
합니다. `router/example-env.router`의 `ROUTER_MANAGER_HOSTS`(콤마로 여러 개
가능, 예: `router.code.yaeji.moe`)를 설정하면, 그 hostname으로 오는 요청은
router의 nginx가 `server_name` 기반으로 완전히 별도의 `server{}` 블록으로
router-manager에 직접 연결합니다(SPA + API 전부) — 그 도메인에서 로그인해
발급받은 쿠키는 그 도메인에만 스코프되므로, code-server/webmanager/노출된
앱 중 어디가 뚫려도 이 쿠키까지 같이 새지 않습니다. `ALLOWED_HOSTS`/
`ALLOWED_EXPORT_HOSTS`와 같은 이유로 env-only입니다(인프라 수준의 보안
경계라 앱 안에서 즉시 반영되는 값으로 만들지 않았습니다) — 값을 바꾸면
컨테이너 재시작이 필요합니다. `/router/` SPA의 "설정" 탭에서 현재 설정된
값과 지금 접근 중인 origin을 읽기 전용으로 확인할 수 있고, localhost로
접근 중이거나 전용 도메인이 있는데 공유 경로로 접근 중이면 배너로
안내합니다.

앞단 SSO(Authentik 등)로 code-server와 이 전용 도메인을 둘 다 보호하면서
로그인을 한 번만 하고 싶다면 —
[security-login.md의 "여러 서브도메인 한 번에 로그인
(SSO)"](security-login.md#여러-서브도메인-한-번에-로그인-sso--router_manager_hosts-등)
참고.

**webmanager에 내장된 Dev Proxy/App Routes/Tailscale/DNS/Net 관리/tinyauth 탭은 항상
`<iframe>`으로 router의 `/router/` 페이지를 그대로 embed합니다**
(`components/RouterEmbed/RouterFrame.tsx`, 2026-08-08부터 — 그 전에는
`ROUTER_MANAGER_HOSTS` 미설정 시 `@code-docker/router-frontend` 컴포넌트를
webmanager 쪽에서 같은 origin으로 직접 렌더링하는 `Direct` 폴백이 있었지만,
router와 webmanager를 완전히 독립적인 배포 단위로 만들기 위해
제거했습니다 — 자세한 배경은
[`.claude/backlog/router-frontend-decouple-plan.md`](../.claude/backlog/router-frontend-decouple-plan.md)와
[`router/.claude/net-auth-expansion-plan.md`](../router/.claude/net-auth-expansion-plan.md)의
6번 항목). `GET /router/api/auth/status`의 `trustedHosts`를 읽어 `ROUTER_MANAGER_HOSTS`가
설정되어 있으면 그 전용 도메인으로 향하는 cross-origin iframe을, 비어있으면(기본)
같은 origin의 `/router/`로 향하는 iframe을 씁니다 — 두 경우 다 iframe이라는
점만 같고, 실제로 이 탭들의 쿠키 문제를 닫는 건 여전히 `ROUTER_MANAGER_HOSTS`를
설정한 cross-origin 케이스뿐입니다(같은 origin iframe은 여전히 부모 페이지가
router-manager의 쿠키를 공유하는 origin 안에 있습니다 — 다만 최소한 웹매니저
자신의 JS 컨텍스트가 router-manager API를 직접 호출하지는 않으므로, XSS가
router-manager를 조용히 호출하려면 iframe 자체를 조작해야 합니다). iframe 쪽은
로드가 끝날 때까지(+약간의 지연, 최대 3초 안전장치) 스켈레톤을 덮어두고,
webmanager의 라이트/다크 테마 선택을 `postMessage`로 전달해 안팎 테마가
어긋나지 않게 맞춥니다.

이 변경으로 webmanager는 `@code-docker/router-frontend`(router/frontend)를
빌드 시점 의존성으로 전혀 갖지 않습니다 — router가 아예 없거나 꺼져 있어도
webmanager 자체 빌드/실행에는 영향이 없고, Dev Proxy/App Routes/Tailscale/DNS/Net
관리/tinyauth 탭만 빈 iframe으로 보입니다. 두 프로젝트가 별도 저장소로 분리될
가능성을 염두에 둔 결정입니다. `ErrorBanner`/`Sheet`/`Skeleton` 같은
router-frontend 전용이 아닌 범용 UI 컴포넌트는 webmanager 자체 코드
(`webmanager/frontend/src/components/common/`)로 손수 복제되어 있습니다 —
두 프로젝트가 각자 독립적으로 진화하면서 다시 벌어질 수 있다는 유지비용을
감수하고 완전한 분리를 택한 결정입니다.

### router 환경변수 마이그레이션

tailscale/Dev Proxy/App Routes 노출 정책/router-manager 자체 비밀번호/tinyauth
같은 router 전용 기능 설정은 저장소 루트가 아니라 `router/example-env.router`
(런타임 템플릿)에 정리되어 있습니다 — `router/.env.router`로 복사해서
필요한 값만 주석을 풀어 쓰세요. NETGATE_ENABLED, ROUTER_HOSTNAME,
CADDY_ADAPTER_*, ALLOWED_HOSTS류처럼 code-docker와 값을 공유하거나
docker-compose.yml 토폴로지에 관련된 값은 그대로 저장소 루트
`example-env`에 남아 있습니다.

webmanager의 `--env-migrate`와 완전히 같은 도구(공유 Go 모듈
`code-docker/envmigrate`)로 동작합니다 — 이미지를 업데이트한 뒤 기존
`.env.router`를 최신 키 구조로 재구성하려면:

```sh
cp router/.env.router router/.env.router.bak
cat router/.env.router | docker compose exec -T code-docker-router \
  router-manager --env-migrate > router/.env.router
```

활성화(주석 해제)해둔 값과 직접 남긴 코멘트는 그대로 보존되고, 더 이상 안
쓰이는 키는 지우지 않고 파일 맨 아래 "더 이상 쓰이지 않는 키" 섹션으로
옮겨집니다. `.env.router`가 낡은 버전이면(`ROUTER_ENV_VERSION` 불일치)
router-manager가 시작 시 로그에 경고를 남깁니다 — 시작을 막지는 않습니다.
