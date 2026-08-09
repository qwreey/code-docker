# Net 관리 / 탭 UX / tinyauth 확장 (2026-08-08)

사용자가 한 번에 던진 6개 요청을 정리한 문서. 1~4는 이번 세션에 구현 완료, 5~7은
설계만 하고 구현은 다음 세션으로 미룸 — 각각 별도의 멀티파일 Go+React 작업이라
한 번에 다 밀어붙이기엔 리스크가 크다고 판단(router는 code-docker보다 신뢰 수준이
높은 컨테이너라는 점도 고려).

## 1. Net 관리 탭 — 구현 완료

**요청**: 포트포워딩(인바운드 DNAT)과 outbound CIDR 제어가 웹 UI로 관리 안 됨.
둘이 엮인 기능이라 하나의 새 탭으로 묶고, "code-docker-internal에 직접 붙은
컨테이너끼리는 이 테이블로 제어 못 한다"는 경고를 탭 안에 명시해달라는 요청.

**구현**: `router/backend/internal/netgate`(신규) — DNS 관리가 도입한 것과 같은
"라이브 카피" 패턴을 netgate에도 적용(`EnsureSeeded`가 `config.override.yaml`/
`config.default.yaml`을 `/var/lib/code-docker-router/netgate/config.yaml`에 최초
1회만 복사, 이후 이 라이브 카피가 유일한 진실 소스). `firewall.default.sh`는 매
루프 반복마다(스크립트 시작 시 한 번이 아니라) 라이브 카피 존재 여부를 다시
확인하도록 바꿔서, netgate-firewall과 router-manager 두 supervisord 프로그램 사이
시작 순서 경합을 피함. Outbound는 순서가 곧 데이터라(iptables first-match-wins)
`GET`/`PUT /api/netgate/outbound`(전체 교체) 방식, forwards는 `host_port`를
유니크 키로 하는 일반 CRUD(`GET`/`POST`/`DELETE /api/netgate/forwards[/{hostPort}]`).
둘 다 supervisord 재시작이 필요 없음 — firewall 루프가 30초마다 알아서 다시 읽음.

프론트: `router/frontend/src/components/NetManagement/`(Outbound.tsx - 로컬에서
편집 후 저장 버튼으로 한 번에 PUT, Forwards.tsx - tailscale forwards와 같은 패턴,
NetManagement.tsx - 경고 배너 포함 wrapper). `@code-docker/router-frontend`에서
`NetManagement`로 export, router 자체 SPA와 webmanager 양쪽에 탭으로 연결.

**경고 배너 문구**: "code-docker-internal에 직접 붙어 있는 컨테이너끼리(code-docker
↔dind, code-docker↔router)의 트래픽은 이 테이블로 제어할 수 없습니다 - 같은
서브넷 안에서는 커넥티드 라우트를 그대로 타서 FORWARD 체인 자체를 거치지 않기
때문입니다."

## 2. 탭 상태 URL 경로 반영 — 구현 완료

router/frontend, webmanager 둘 다 `useState`로만 탭을 관리해 새로고침하면
기본 탭으로 리셋되던 문제. react-router 등 라이브러리 없이 `history.pushState`
+`popstate`로 구현(두 앱 다 단일 레벨 탭 구조라 라이브러리는 과함) - router의
`splitPath`/webmanager의 동일 이름 함수가 pathname의 마지막 세그먼트만 보고
탭을 판별하므로, router가 공유 origin의 `/router/` 경로 아래든 전용
`ROUTER_MANAGER_HOSTS` 도메인의 루트든 그대로 동작. `router-manager`의
`staticHandler`/webmanager `staticHandler` 둘 다 이미 "실제 파일이 아닌 GET
경로는 index.html로 폴백"하는 SPA fallback을 갖고 있어서 nginx 쪽 변경은
전혀 필요 없었음. router의 `?embed=1&tab=` iframe embed 모드는 예외로 그대로
쿼리스트링 방식 유지(webmanager의 `RouterFrame.tsx`와의 기존 계약을 깨지 않기
위해).

## 3. tinyauth 비밀번호 변경 — 구현 완료

**요청**: 유저 비밀번호 변경이 안 되는 게 이상해 보이니 고쳐달라 - 이전 비밀번호는
묻지 말고 router-manager 자체 비밀번호로 이미 인증된 상태에서 새 비밀번호만
입력하면 되게.

**구현**: `internal/tinyauthusers.SetPassword`(신규 - `AddUser`와 같은 "새 해시
생성 → 파일 전체 재작성" 패턴, tinyauth 자신에게는 이런 API/CLI가 아예 없음 -
아래 6번 리서치 결과 참고), `PUT /api/tinyauth/users/{name}/password`
(`gate.RequirePassword`로 이미 보호됨 - router-manager 자체 게이트가 곧
"관리자 인증"), `TinyauthUsers.tsx`에 사용자 행마다 "비밀번호 변경" 버튼 +
새 비밀번호 하나만 받는 인라인 폼 추가.

## 4. DNS 빌트인 블록리스트 opt-out + BUILTIN_TARGET 마운트 — 구현 완료

**요청**: 이미지 내장 StevenBlack 블록리스트를 끄는 env flag와, 유저가 마운트로
빌트인 소스 자체를 바꿀 수 있는 구조 - 런타임 변경은 막아도 됨.

**구현**: `DNS_BUILTIN_BLOCKLIST_ENABLED`(기본 `true`, `false`면 시딩 자체를
건너뛰고 기존에 시딩되어 있었다면 라이브 카피+매니페스트 항목까지 제거),
`DNS_BUILTIN_BLOCKLIST_SOURCE`(기본 이미지 내장 경로, 다른 경로로 바꾸면
그 경로에서 시딩 - 유저가 docker-compose.yml에서 그 경로로 자신의 hosts 파일을
바인드 마운트하는 용도). 둘 다 `dns.default.sh`가 매 프로그램 시작마다 읽고,
`internal/dns.ShippedDefaultPath()`(기존 `ShippedDefaultPath` 상수를 함수로
변경 - 같은 env var를 읽어서 `GetBuiltinStatus`의 해시 비교가 시딩 스크립트와
항상 같은 소스를 보도록 동기화)도 같은 env var를 따름. 컨테이너 재생성 시에만
반영, 런타임 웹 UI로는 바꿀 수 없음(의도적 - 배포 단계 설정).

## 5. 사이드바 제네릭화 + router↔webmanager 완전 분리 — 구현 완료 (2차 세션, 2026-08-08)

**요청 경위**: 처음엔 "router 탭이 계속 늘어나는데 webmanager 사이드바를
가져다 쓸 수 없나"라는 질문이었고(아래 원래 제안은 새 `@code-docker/ui`
워크스페이스 패키지를 만들어 양쪽이 공유하는 방향이었음), 이후 빌드 에러
수정 요청과 함께 방향이 바뀜: **"webmanager는 router 요소를 항상 iframe으로
가져오고, 그 자체로 opt-out 가능한 요소로 두자. 전에 분리가 복잡하다던
이유(router-frontend가 webmanager 전역 공용 컴포넌트 라이브러리 역할도
겸하고 있음)를 이번에 실제로 해결하자"**는 결정. 즉 공유 패키지를 새로
만드는 대신, **아예 안 나누는 쪽**(각자 완결된 코드베이스 + iframe 하나로만
연결)을 선택.

**구현**:
- **RouterFrame 상시 iframe화** (`webmanager/frontend/src/components/RouterEmbed/RouterFrame.tsx`) —
  `Direct` prop/폴백을 완전히 제거, `ROUTER_MANAGER_HOSTS` 미설정 시에도 항상
  같은 origin의 `/router/?embed=1&tab=...`으로 향하는 iframe을 씀(예전엔 이
  경우만 `@code-docker/router-frontend` 컴포넌트를 같은 origin에 직접
  렌더링했음). `useRouterTrustedHosts`가 돌려주는 `trustedHosts[0]`가 있으면
  cross-origin, 없으면 같은 origin 상대 경로 — 분기는 iframe의 `src` 호스트만
  다를 뿐, 렌더링 경로 자체는 이제 단 하나뿐.
- **webmanager의 router-frontend 의존 완전 제거** — `App.tsx`에서
  `DevProxy`/`AppRoutes`/`Tailscale`/`Dns`/`NetManagement`/
  `RouterUnlockModalHost`/`RouterAuthSetupBanner` import를 전부 삭제(전부
  `RouterFrame`을 통한 iframe으로만 노출). 이 두 배너/모달은 router-manager
  API를 webmanager 자신의 JS 컨텍스트에서 직접 호출하던 것들이었는데, 이제
  webmanager는 router-manager를 직접 호출하지 않으므로(iframe 내부 페이지가
  자기 자신의 unlock 모달을 이미 갖고 있음 - router/frontend App.tsx가
  `<RouterUnlockModalHost />`를 무조건 마운트) 그냥 삭제. **동작 변화**:
  webmanager 자체에는 더 이상 "router 비밀번호 미설정" 프로액티브 배너가 안
  뜸(code-server 쪽의 별도 배너는 그대로 유지) - `/router/`를 직접 열면
  거기서는 여전히 뜸.
- **범용 UI 프리미티브 3개를 webmanager 자체 코드로 복제** — `ErrorBanner`/
  `Sheet`/`Skeleton`이 `router/frontend/src/components/common/`에만 있고
  router 기능과 무관하게 webmanager 전역 45개 파일이 그걸 가져다 쓰던 구조를
  없앰. `webmanager/frontend/src/components/common/`에 세 컴포넌트+CSS를
  그대로 복사해 넣고(주석에 "hand-kept duplicate"임을 명시 - 두 프로젝트가
  분리 저장소가 될 걸 감안해 공유보다 중복을 택함), 45개 파일의 import
  경로를 전부 상대 경로로 교체. `ErrorBanner`의 CSS는 webmanager의 기존
  `components/common/common.css`에 합침(webmanager는 이미 `.btn`/`.card`
  등 대부분을 자체 보유하고 있었고 `.error-banner`류만 없었음), `Sheet`/
  `Skeleton`은 각자 자기 CSS 파일 그대로 복사.
- **`webmanager/frontend/package.json`에서 `@code-docker/router-frontend`
  의존성 제거**, 루트 `Dockerfile`의 `webmanager-frontend` 빌드 스테이지도
  `router/frontend/`를 더 이상 COPY하지 않도록 단순화(스테이지가 이제
  `webmanager/frontend/`만으로 완결됨 - `npm ci`가 workspaces에 없는
  디렉토리를 그냥 건너뛰는지 로컬에서 별도로 검증함).
- **Sidebar 제네릭화** (`webmanager/frontend/src/components/Layout/Sidebar.tsx`) —
  사용자가 요청한 정확한 형태로: `{items: SidebarItem[], order: string[],
  onReorder: (order) => void, active, onSelect, open, onClose}` props만 받는
  순수 프레젠테이션 컴포넌트로 리팩터(`SectionId`/`SECTIONS`/아이콘 매핑/
  `/ui/sidebar-order` API 호출을 전부 제거). 기존 webmanager 전용 배선은
  새 `SidebarContainer.tsx`로 옮김(SECTIONS→SidebarItem 매핑, 아이콘 테이블,
  order fetch/persist, `<Sidebar>`에 값 주입). `App.tsx`는 `SidebarContainer`만
  import. router/frontend 쪽에 같은 패턴의 사이드바를 실제로 붙이는 건 이번엔
  범위 밖(router는 여전히 플랫 탭바 - 탭 6개면 아직 사이드바가 꼭 필요한
  정도는 아니라고 판단, 필요해지면 이 컴포넌트를 같은 "hand-kept duplicate"
  방식으로 router/frontend에도 복사하면 됨).

  **후속 (2026-08-09)**: 탭이 7개(App Routes/Dev Proxy/Tailscale/DNS/Net
  관리/tinyauth/설정)로 늘고 사용자가 "router도 사이드바 못 씀?"이라고
  재요청하면서, 위에서 미룬 그대로 `Sidebar.tsx`/`Layout.css`를 router/frontend에
  hand-kept-duplicate로 실제 복사(`router/frontend/src/components/Layout/`) —
  `SidebarContainer.tsx`는 router 쪽만 order 영속화 없이 로컬 `useState`로
  단순화(탭 7개엔 아직 새 백엔드 엔드포인트까지는 과함). 요청에 포함된 "로그인
  상태/테마 버튼도 같이 가져올만하지 않냐"까지 반영 — `theme.ts`/`useTheme.ts`도
  hand-kept-duplicate로 복사(localStorage 키만 `router-theme`로 분리, standalone
  방문에서만 씀 - embed 모드는 여전히 `embedTheme.ts`의 parent-postMessage 방식,
  `main.tsx`가 `?embed=1` 여부로 둘 중 하나만 초기화), `SidebarFooter.tsx`도 복사해
  `GET /api/auth/status`(잠금 상태 - 이미 응답에 `unlocked`/`unlockedUntil`
  필드가 있었는데 프론트 로컬 타입만 그걸 안 쓰고 있었음) 기반 잠금 표시 + 클릭
  시 언락 모달을 추가. `api/client.ts`에 `requestUnlock`/`onAuthStatusChange`를
  webmanager 것과 같은 패턴으로 추가(기존 `unlockPrompter` 전역을 재사용).

**검증**: 양쪽 프론트엔드 `tsc --noEmit`/`vite build`/`oxlint` 통과, router
이미지 `docker compose build`(handlers_netgate.go Dockerfile 누락 수정 포함,
아래 참고) 통과. code-docker 메인 이미지의 `webmanager-frontend` 스테이지는
이 세션의 샌드박스에 컨테이너 네트워크 egress가 막혀 있어 직접 빌드
검증은 못 했음(호스트에서의 `npm ci` 시뮬레이션으로 workspace 멤버 누락이
문제 없음만 확인) - 실제 배포 환경에서 최초 1회 `docker compose build
code-docker` 확인 권장.

**빌드 에러 수정 (선행 세션의 회귀)**: 이 문서의 1번 작업(Net 관리 탭)에서
새로 만든 `router/backend/handlers_netgate.go`가 `router/Dockerfile`의
`router-manager-build` 스테이지에 개별 `COPY` 라인으로 추가되지 않아
`go build`가 `undefined: handleListNetgateOutbound` 등으로 실패하던 문제.
이 Dockerfile 스테이지는 `backend/*.go`를 와일드카드가 아니라 파일마다
개별 COPY하는 구조라(`internal/`만 디렉토리째 COPY) 새 최상위 핸들러
파일을 추가할 때마다 이 목록도 같이 갱신해야 한다는 게 이번에 드러난
함정 - 앞으로 `router/backend/handlers_*.go`를 추가할 때는 반드시
`router/Dockerfile`의 `COPY backend/handlers_*.go` 목록도 같이 갱신할 것.

## 6. tinyauth 탭 신설 + ACL(유저/그룹) + OIDC provider + well-known 노출 + email — 1번(탭 분리)만 구현 완료(2026-08-09), 나머지는 보류

**2026-08-09 결정**: ACL/OIDC provider/well-known/email/그룹은 로컬 유저만
쓰는 지금 배포엔 애초에 적용 불가(그룹은 LDAP/OIDC 없이 원천적으로 없는
개념)라는 아래 리서치 결과를 재확인하고, 실제 필요(Authentik 테스트 등)가
생기기 전까진 보류하기로 함 - "말 그대로 지금 못 함. ldap 같은거 필요해서
안하면 됨". 아래 "제안 순서"의 1번(tinyauth 전용 탭 신설)만 이번에 구현:
`router/frontend/src/App.tsx`의 '설정' 탭에 얹혀 있던 `<TinyauthUsers />`를
독립 탭(`tinyauth`)으로 분리(`RouterAuthPanel`/`RouterTrustedHostsPanel`만
'설정'에 남음), webmanager 쪽에서도 편집 가능해야 한다는 요청에 따라
`RouterFrame.tsx`의 `tab` 유니온에 `'tinyauth'` 추가 + webmanager
`sections.ts`/`SidebarContainer.tsx`/`App.tsx`에도 새 사이드바 항목으로
배선(`RouterFrame tab="tinyauth"`) - §5 후속에서 router 자신도 사이드바를
갖게 된 것과 같은 세션. email attribute 필드 추가는 이번엔 범위 밖(탭 분리만
요청받음).

**요청 원문 요약**: App Routes/Dev Proxy에 유저별/그룹별 접근 제어를 걸 수 있나,
그룹 멤버십 설정도 되나? tinyauth가 OIDC provider로도 동작해서 Authentik 같은
외부 클라이언트의 테스트용으로 쓸 수 있나? well-known을 `router/tinyauth/...`로
노출할 수 있나? tinyauth 전용 탭을 새로 만드는 게 낫지 않나? 유저에 email 필드도
있지 않나?

**리서치 결과** (tinyauth v5.1.0 기준, https://tinyauth.app/docs/):

- **유저/그룹 ACL**: 앱별 Docker 라벨/env(`TINYAUTH_APPS_[NAME]_USERS_ALLOW` 등)로
  `users.allow`/`users.block`(유저 comma-list 또는 정규식), `oauth.whitelist`,
  `oauth.groups`(OIDC 응답의 `groups` claim 기반 - **커스텀 OIDC 프로바이더에서만
  동작, Google/GitHub는 미지원**), `ldap.groups`(LDAP 그룹, 15분 캐시)를 지원.
  **중요**: tinyauth 자체엔 독립적인 "로컬 그룹" 개념이 없음 - 로컬 유저
  (`TINYAUTH_AUTH_USERS`)는 flat list일 뿐이고, 그룹은 항상 외부 OIDC/LDAP이
  응답에 실어주는 claim에 의존함. 즉 이 리포에 LDAP이나 OIDC 프로바이더가
  없으면 "그룹" 자체가 원천적으로 없는 개념 - 지금처럼 로컬 유저만 쓴다면 유저
  단위 allow/block까지만 가능하고 그룹 UI를 만들 수가 없음.
- **OIDC provider로 동작 가능한가 - 예, 양방향 다 지원**: v5.0.0에서 실험적
  "OIDC server" 도입, v5.1.0에서 OpenID Foundation의 Basic OP 프로파일 정식
  인증(Keycloak과 동일한 conformance suite 통과) 받음. `tinyauth oidc create
  <name>` CLI로 클라이언트 발급 → `TINYAUTH_OIDC_CLIENTS_[NAME]_CLIENTID/
  CLIENTSECRET/TRUSTEDREDIRECTURIS`. **HTTPS 필수(issuer URL)**, 상태 저장을
  위해 `/data`(`TINYAUTH_DATABASE_PATH`) 영속화 필요. 지원 grant:
  `authorization_code`, `refresh_token`; scope: `openid profile email phone
  address groups`.
- **well-known**: `/.well-known/openid-configuration`에서 서비스, 함께
  `/authorize`, `/api/oidc/token`, `/api/oidc/userinfo`도 노출. 외부 리버스
  프록시 노출에 특별한 제약 없음(HTTPS 전제).
- **email 필드**: 있음 - `TINYAUTH_AUTH_USERATTRIBUTES_[name]_EMAIL`로 유저별
  설정(로컬 `username:hash[:totp]` 자체엔 없고 별도 attribute 블록).
- **비밀번호 재설정 API**: 3번에서 이미 구현 완료(SetPassword). tinyauth 자체엔
  전용 API/CLI가 없다는 사실도 이미 반영됨.

**제안 순서** (난이도/의존성 순):
1. **tinyauth 전용 탭 신설** - 지금 "설정" 탭에 얹혀 있는 `TinyauthUsers`를
   독립 탭으로 분리하고, email attribute 필드를 폼에 추가 (`TINYAUTH_AUTH_
   USERATTRIBUTES_*` 렌더링 - `RenderEnvFile`을 email도 같이 쓰도록 확장).
   가장 작고 독립적인 작업.
2. **well-known 노출** - `router/config/nginx/nginx.default.conf`에
   `/tinyauth/.well-known/`류 location 하나 추가해서 tinyauth의 OIDC 엔드포인트를
   외부에 리버스 프록시. tinyauth가 이미 `127.0.0.1:3000`에 떠 있으니 순수
   nginx 설정 작업.
3. **유저 단위 allow/block (그룹 아님)** - Dev Proxy/App Routes 각 항목에
   `requireAuth: boolean` 대신(또는 추가로) `allowedUsers: string[]` 필드를 두고
   Caddy 라벨/env로 `users.allow`를 렌더링. `internal/devproxy`/
   `internal/approutes` 확장 필요.
4. **OIDC provider 활성화 + 테스트 클라이언트 발급 UI** - `TINYAUTH_APPURL`이
   이미 HTTPS를 요구하므로 별도 조건 없이 바로 시도 가능하지만, `/data` 영속화
   경로 확인 및 서명 키쌍 관리(볼륨 마운트 필요)가 선행되어야 함. `tinyauth
   oidc create` CLI를 감싸는 router-manager API + UI.
5. **그룹 기반 ACL** - LDAP/커스텀 OIDC 프로바이더가 실제로 구성되어 있을 때만
   의미가 생기므로, 4번이 끝나고 실제 사용 시나리오가 생긴 뒤 재검토. 지금
   로컬 유저만 쓰는 배포에는 애초에 적용할 수 없는 기능이라는 점을 UI에도
   명시해야 함(예: "그룹은 OIDC/LDAP 로그인에서만 동작합니다" 안내).

## 7. DNS dig형 조회 도구 — 구현 완료 (2026-08-09)

**요청**: nameserver 관리자에서 dig처럼 도메인 조회를 해볼 수 있으면 디버깅에
유용할 듯 - 캐시 상태 보는 것도 유용. 캐시 지우기는 호스트사이드와 밀접해서
어려우니 생각 안 해도 됨(요청자 본인이 스코프 아웃).

**리서치 결과**: `router/backend/internal/dns/`는 순수 CRUD만 존재, query/lookup/
debug 엔드포인트 전무. dnsmasq에 훅킹할 방법으로 두 가지가 현실적:
(a) 컨테이너 내부에서 `dig @127.0.0.1 <도메인>`을 직접 실행해 결과를 프록시하는
방법(실시간, 구현 간단), (b) dnsmasq `SIGUSR1`→syslog로 캐시 덤프 후 로그
파싱(실시간성 낮고 vector 파이프라인과 얽힘). 이미 배선된 stats/DBus 연동은
없음.

**구현**: 제안했던 두 선택지 중 `bind` 패키지 추가 쪽 채택(`getent hosts` 폴백은
TTL/레코드 타입 조회가 안 돼 dig 대체로는 부족하다고 판단, 요청자도 "bind 패키지
추가해도 될듯"으로 확정) - `router/Dockerfile`의 `pacman -Suy` 목록에 `bind` 추가
(Arch에서 `bind-tools`/`dig`를 흡수한 패키지, `pacman -Si bind`로 `Provides:
bind-tools dnsutils`, `Replaces: bind-tools dnsutils host` 확인). `router/backend/
internal/dns/query.go`(신규) - `Query(ctx, domain, recordType)`가 레코드 타입을
고정 allowlist(A/AAAA/CNAME/MX/TXT/NS/SOA/PTR/SRV/ANY)로 검증한 뒤
`dig +noall +answer +comments +stats @127.0.0.1 <domain> <type>` 실행, 소요 시간과
dig의 원본 텍스트 출력을 그대로 반환(요청자가 "실행 결과 그냥 띄워줘도 될듯"이라고
스코프를 명시했으므로 answer section을 구조화 파싱하지 않음 - 레코드/TTL/값과 dig
자체의 Query time 푸터가 원문에 이미 다 들어있음). `GET /api/dns/query?domain=&type=`
(다른 GET `/api/dns/*`와 같이 읽기 전용이라 `gate.RequirePassword` 밖 - 도메인/타입은
`exec.Command`에 개별 인자로 전달되므로 셸 인젝션 여지 없음, 5초 타임아웃으로 응답
없는 업스트림에 요청이 무한정 블록되지 않도록 함). 프론트: DNS 탭에 새
"조회" 서브탭(`Query.tsx`) - 도메인/타입 입력 + `<pre>`로 dig 원본 출력 표시.
캐시 상태/지우기는 요청자가 처음부터 스코프 아웃했으므로 미구현.

**후속 (같은 날)**: "dig에서 A AAAA처럼 여러 레코드를 한번에 조회 못 하나,
ALL/\* 선택지는?"라는 재요청 - 확인해보니 `dig domain A AAAA MX`처럼 타입을
여러 개 나열하면 dig가 마지막 타입만 남기고 나머진 "extra type option"
경고와 함께 버림(로컬 `dig` 바이너리로 직접 재현 확인). 대신
`dig domain A domain AAAA domain MX ...`처럼 "도메인 타입" 쌍을 반복하면
한 번의 dig 프로세스 안에서 쌍마다 독립된 조회를 순서대로 실행한다는 걸
확인 - 이 방식으로 `recordType == "ALL"`을 특수 케이스로 추가(`allTypes =
[A, AAAA, CNAME, MX, TXT, NS, SOA, SRV]`, PTR은 역방향 이름이 필요해 제외,
ANY는 그대로 별개 선택지로 유지 - RFC 8482 때문에 리졸버가 ANY에 축소된
응답만 주는 경우가 많아 ALL의 대체가 안 됨). 프론트 드롭다운에 "ALL
(A/AAAA/CNAME/MX/TXT/NS/SOA/SRV)" 옵션 추가.

## 남은 작업

5(router 자신도 사이드바), 6-1(tinyauth 탭 분리), 7(DNS dig 도구 + ALL 옵션)
모두 2026-08-09 기준 구현 완료. 남은 건 6의 나머지(ACL, OIDC provider, 그룹,
well-known, email 필드)뿐 - 실제 필요가 생기는 시점(예: Authentik 테스트를
실제로 시작할 때)에 다시 우선순위를 매기기로 보류 결정(사용자 확인:
"ldap 같은거 필요해서 안하면 됨").
