# dev 서버 노출 (Dev Proxy)

컨테이너 안에서 뜬 dev 서버(`npm run dev` 등)를 바깥 도메인으로 노출하는 기능입니다.
내부 Caddy 인스턴스(`caddy-adapter` 프로그램)가 **router** 컨테이너에서 떠서
항목(expose)별로 code-docker 안 로컬 포트로 리버스 프록시하고(자세한 배경은
[router.md](router.md) 참고 — code-docker보다 신뢰 수준이 높은 국경 컨테이너에 네트워크
관련 기능을 모으는 설계입니다), [webmanager의 Dev Proxy 탭](webmanager.md)에서
관리합니다(실제로는 router가 제공하는 페이지 컴포넌트를 webmanager가 그대로 가져와
보여주는 것 — 탭 자체는 그대로입니다). 공유 base 도메인 같은 건 없습니다 — expose마다
완전히 독립적인 전체 호스트네임을 직접 지정합니다 (`dev.example.com`,
`code.other-domain.org`처럼 서로 다른 도메인도 한 인스턴스에서 동시에 처리 가능). 실제로
무엇이 이 컨테이너까지 도달하는지는 전적으로 바깥 리버스 프록시가 무엇을 이 포트로
넘기는지에 달려있습니다.

## 켜고 끄기 / 기본 설정

`docker-compose.yml`의 두 환경변수로 제어하며, 둘 다 router 컨테이너에만 전달됩니다
(code-docker 쪽은 몰라도 됩니다 — router 자신의 nginx가 유닉스 소켓으로 caddy-adapter와
통신하므로, code-docker의 nginx는 애초에 Caddy를 직접 알 필요가 없습니다):

- `CADDY_ADAPTER_ENABLED` (기본 `"true"`) — `"false"`면 router의 `caddy-adapter`
  프로그램이 아무것도 안 하고 idle 상태로 떠 있습니다.
- `CADDY_ADAPTER_PORT` (기본값 없음 — 설정 필요) — 비워두면(기본값) caddy-adapter는
  유닉스 소켓(`caddy-adapter.sock`)에만 바인드되고 TCP 포트는 전혀 열지 않습니다.
  값을 채우면 그 번호로 TCP 포트도 함께 바인드합니다 — 아래 ["대안:
  `CADDY_ADAPTER_PORT`를 직접
  퍼블리시"](#대안-caddy_adapter_port를-직접-퍼블리시)에서만 필요합니다. 기본(`/exports/`
  경유) 경로만 쓸 거라면 그냥 비워두면 됩니다. 도메인은 여기서 설정하지 않고,
  expose마다 개별적으로 지정합니다(아래 "expose 추가하기").

## expose 추가하기

[webmanager의 Dev Proxy 탭](webmanager.md)에서 먼저 이름(내부 식별자)과 host(외부에 노출할 전체 도메인, 예: `dev.example.com` — 라벨 하나만 와일드카드로 두고 싶으면 `*.staging.example.com`처럼 Caddy의 `host` matcher 와일드카드 문법을 그대로 쓸 수 있습니다)로 expose를 하나 만들고, 그 아래에 라우트를 원하는 만큼 추가하는 두 단계 구조입니다. "이름"은 파일명(`managed/<이름>.caddy`)과 Caddyfile `@이름` matcher 토큰으로만 쓰이는 내부 식별자라 점(`.`)을 포함할 수 없습니다 — 실제 노출 도메인은 항상 host 필드에 입력하세요. 이름과 host 둘 다 expose를 펼친 화면에서 나중에 바꿀 수 있습니다(각자 인라인 편집) — 이름을 바꾸면 파일도 새 이름으로 다시 쓰고 검증까지 통과한 뒤에만 옛 파일을 지우므로 중간에 실패해도 expose가 사라지지 않고, 이미 쓰이는 이름으로 바꾸려 하면 거부됩니다. 라우트 하나는:

- **라우팅 대상 path** — 예: `/api/*`. 비우면 전체 요청에 매치됩니다.
- **target** (`host:port`) — 리버스 프록시 대상. router 컨테이너 기준으로 reachable해야 합니다 — `127.0.0.1`/`localhost`는 router 자기 자신을 가리켜 code-docker 안 dev 서버에 닿지 않습니다. `code-docker:포트`처럼 compose 서비스 호스트네임을 쓰세요. 기본적으로 `code-docker`/`dind` 두 compose 서비스 호스트네임만 허용되고 그 외 대상은 거부됩니다(Caddy 자신의 admin API 등을 겨냥한 self-SSRF 방지) — `DEVPROXY_ALLOW_EXTERNAL_TARGETS="true"`로 제한을 통째로 풀거나, `ROUTER_EXTRA_ALLOWED_TARGET_HOSTS`(`.env.router`)로 특정 호스트만(예: `EXTRA_INCLUDE`로 붙는 sibling 프로젝트의 alias) 허용 목록에 추가할 수 있습니다 — router 자기 자신(`127.0.0.1`/`localhost`/자기 IP/`router`)과 tailscale forwards의 `forward` 별칭([tailscale 절](router.md#tailscale) 참고 — 이것도 router 자신을 가리키는 alias)은 어느 쪽 옵트아웃으로도 절대 허용되지 않습니다.
- **strip prefix** (선택) — 요청 경로에서 이 리터럴 문자열을 잘라내고(`uri strip_prefix`) 전달합니다.
- **리버스프록시 path** (선택) — strip 이후 남은 경로 앞에 이 문자열을 붙입니다(`rewrite * <값>{uri}`). 예를 들어 대상 path `/api/*`, strip `/api`, 리버스프록시 path `/v1/api`면 `/api/foo` 요청이 target에는 `/v1/api/foo`로 전달됩니다.
- **매칭 방식** — `route`(매치되면 무조건 실행, 다른 라우트와 독립적으로 겹쳐 실행 가능) 또는 `handle`(같은 서브도메인 안의 다른 라우트와 배타적, 먼저 매치되는 라우트 하나만 실행) 중 선택. Caddy 자체의 `route`/`handle` 디렉티브 의미 그대로입니다.
- **인증 요구** — 라우트별로 개별 설정. 서브도메인 목록에는 이 값들을 모아 전체 라우트가 인증을 요구하면 "요구", 일부만이면 "부분", 하나도 없으면 "없음"으로 표시됩니다.

같은 서브도메인 안의 라우트는 등록한 순서대로 평가되므로, 좁은 path(`/api/*`)를 넓은 path(전체 매치)보다 먼저 두어야 합니다. 저장하면 router 컨테이너 안 `/var/lib/code-docker-router/caddy-adapter/managed/<이름>.caddy` 파일 하나가 갱신되고, `caddy adapt`로 문법 검증 후 `caddy reload`로 무중단 반영됩니다 (검증 실패 시 반영 자체가 안 되고 에러가 그대로 표시됩니다).

폼이 다루지 못하는 특이 케이스(추가 헤더, 커스텀 matcher 등)는 같은 탭의 "원본 편집"으로 `.caddy` 파일 자체를 직접 고칠 수 있습니다.

`preserve_host`(업스트림에 원래 `Host` 헤더를 그대로 넘기는 옵션)는 기본적으로 켜지 않습니다 — 대부분의 dev 서버는 이거 없이도 잘 동작하고, Vite처럼 `Host` 헤더를 검사하는 도구를 쓰다가 막히면 그때 해당 dev 서버 설정에서 `allowedHosts`를 여는 쪽으로 대응하세요.

## 바깥 리버스 프록시 연결하기

### 기본: router 자신의 nginx `/exports/`를 경유 (권장)

`code-docker-router`가 80번 포트를 직접 리스닝합니다(`code-docker`는 더 이상
이 포트를 퍼블리시하지 않습니다 — router 자신의 nginx가 host:80을 직접
종단합니다, 자세한 경위는
[router-nginx-hardening-plan.md](../router/.claude/router-nginx-hardening-plan.md)
참고). `/exports/`(Dev Proxy), `/router/`(router-manager), `/app/`([App
Routes](app-routes.md))는 router의 nginx가 직접 처리하고, 나머지(catch-all)
요청은 router 내부 Caddy(`caddy-adapter`)의 네 번째 site block을 거쳐
`DEFAULT_UPSTREAM`(기본값 `code-docker:80`, `example-env`에서 변경 가능)으로
넘어갑니다 — 예전에는 nginx가 이 대상을 직접 하드코딩했지만, 지금은 router
자신이 뒤에 뭐가 있는지 몰라도 되도록 이 하나도 Caddy를 거칩니다. Dev
Proxy도 별도 포트를 새로 열기보다 이 80번을 그대로 재사용하는
게 기본 권장 경로입니다 — 바깥에 노출해야 하는 포트가 80 하나로 끝나고, 바깥
방화벽/보안그룹/tailnet ACL도 그 하나만 신경 쓰면 됩니다.

방법은 간단합니다 — 바깥 프록시가 dev-proxy로 보낼 요청의 **path 앞에만
`/exports`를 붙이고, Host는 그대로 둔 채** router의 80번 포트로 보내면, router
자신의 nginx가 `/exports`를 벗겨내고 내부 Caddy(`caddy-adapter`, 유닉스 소켓)로
넘깁니다. Host가 그대로 전달되므로 `caddy-adapter`의 expose별 Host 매칭은
전혀 손댈 필요가 없고, dev 서버도 `/exports`를 보지 않으므로(nginx가 이미 벗긴
뒤) base path를 따로 맞출 필요도 없습니다:

```
브라우저 → Host: dev.example.com, path: /api
바깥 Caddy → rewrite로 path 앞에 /exports 추가 (Host는 그대로) → router:80
router 자신의 nginx → /exports 벗김 (Host는 그대로) → caddy-adapter(유닉스 소켓)
caddy-adapter → 기존과 동일하게 Host로 expose를 찾아 dev 서버로 전달
```

Caddy 예시 (도메인 하나, `containerip:80`은 이제 **router** 컨테이너의
IP·포트입니다 — code-server/webmanager 요청도 router의 nginx를 거쳐
(내부적으로 caddy-adapter를 경유해) `DEFAULT_UPSTREAM`(기본
`code-docker:80`)으로 위임되므로 같은 진입점을 그대로 쓰면 됩니다):

```caddyfile
dev.example.com {
	rewrite / /exports{uri}
	reverse_proxy http://containerip:80
}
```

와일드카드 서브도메인 전체를 넘기고 싶다면(각 expose의 host를
`이름.dev.example.com` 식으로 등록):

```caddyfile
*.dev.example.com {
	rewrite / /exports{uri}
	reverse_proxy http://containerip:80
}
```

nginx를 바깥 프록시로 쓴다면:

```nginx
server {
	server_name dev.example.com;
	location / {
		rewrite ^ /exports$request_uri break;
		proxy_pass http://containerip:80;
		proxy_set_header Host $host;
	}
}
```

`/exports`는 바깥 프록시와 router 자신의 nginx 사이에서만 쓰이는 내부
표시일 뿐이라 브라우저 URL이나 dev 서버가 받는 경로에는 전혀 나타나지
않습니다 — expose의 host 필드나 라우트 path/target 설정은 지금까지와
완전히 동일하게 적으면 됩니다.

`ALLOWED_EXPORT_HOSTS`(`router/example-env.router`, 기본 빈 값)로 `/exports/`가 받아들일
Host를 code-server/webmanager용 `ALLOWED_HOSTS`와 별도로 제한할 수 있습니다
— dev-proxy 도메인은 code-server 도메인보다 훨씬 자주 바뀌는 편이라 따로
관리합니다. 또한 `/exports/`는 기본적으로 `code-docker-internal` 네트워크
안에서 시작된 요청을 거부합니다(`ROUTER_NGINX_DENY_INTERNAL_EXPORTS`,
`router/example-env.router`, 기본 `"true"`) — 진짜 외부 Dev Proxy 트래픽이
그 네트워크 내부에서 시작될 이유가 없기 때문입니다. code-docker 컨테이너
자신에서 `curl`로 `/exports/`를 직접 테스트하려면 이 값을 `"false"`로
꺼야 합니다.

### 대안: `CADDY_ADAPTER_PORT`를 직접 퍼블리시

포트 80 하나만 바깥에 열어두고 싶다면 위 기본(`/exports/` 경유) 방식을 그대로 쓰면
됩니다 — 이 대안은 router가 포트를 하나 더 열어도 상관없고, 그 대신 바깥 프록시
설정에서 rewrite 한 줄을 아예 안 쓰고 싶은 경우를 위한 것입니다.

`CADDY_ADAPTER_PORT`(기본값 없음)에 원하는 포트 번호(예: `8082`)를 설정하고
`docker-compose.yml`의 `code-docker-router` 서비스에 `ports: - 8082:8082`를 추가하면,
`/exports` 리라이트 없이 예전처럼 caddy-adapter를 바깥에서 바로 볼 수 있습니다.
caddy-adapter 자신은 Host 값을 가리지 않으므로, expose에 등록해둔 host와 실제로
여기까지 들어오는 요청의 Host 헤더가 일치하기만 하면 됩니다. `CADDY_ADAPTER_PORT`를
비워두면(기본값) 이 TCP 포트 자체가 열리지 않습니다 — `ports:`를 추가해도 바인드할
포트가 없으므로 반드시 값을 먼저 설정해야 합니다.

```caddyfile
dev.example.com {
	reverse_proxy http://<router-container-ip>:8082
}
```

호스트 포트 퍼블리시 대신 같은 도커 네트워크에 바깥 프록시를 조인시켜
컨테이너 이름으로 바로 붙는 배치도 가능합니다.

> 호스트 포트 퍼블리시를 택했다면, [tailscale을 쓰는 경우 자동 노출에 주의하세요](router.md#보안) — `0.0.0.0`에 바인드된 포트는 tailscaled가 조건 없이 tailnet에도 재노출합니다. `CADDY_ADAPTER_PORT`도 sshd/code-server와 같은 카테고리이니 tailnet ACL grant에 포함시켜야 합니다. 반대로 기본(`/exports` 경유) 방식은 caddy-adapter가 호스트에 전혀 퍼블리시되지 않으므로 이 문제 자체가 없습니다.

## 인증

라우트마다 "인증 요구"를 켜면 그 라우트에 [router의 tinyauth](router.md#tinyauth)가
적용됩니다 — Caddy의 `forward_auth`를 tinyauth에 연결하는 방식입니다(예전엔 webmanager의
비밀번호 게이트를 재사용했지만, Dev Proxy가 router로 옮겨가면서 router 전용의 더 가벼운
인증 도구로 교체됐습니다). 사용하려면 tinyauth에 최소 한 명의 사용자가 등록되어 있어야
합니다 — [router.md#tinyauth](router.md#tinyauth)의 `TINYAUTH_AUTH_USERS` 생성 방법을
확인하세요. 사용자가 하나도 없으면 인증 요구 expose가 계속 tinyauth의 로그인 페이지로
리다이렉트만 반복합니다(로그인할 계정 자체가 없으므로).

인증이 없는 상태로 두려면 그냥 해당 라우트의 "인증 요구"를 끄면 됩니다 — 그 경우 바깥 리버스 프록시 쪽에서 별도로 auth를 걸지 않는 한 완전히 공개됩니다.

## 보안: router-manager 쿠키는 자동으로 잘려서 넘어갑니다

기본적으로 `/exports/`는 code-server/webmanager/router-manager와 같은
hostname을 씁니다 - 그래서 브라우저는 요청마다 router-manager의 잠금 해제
쿠키(`router_manager_unlock`)도 같이 붙입니다. router 자신의 nginx가 이
쿠키를 프록시 직전에 헤더에서 잘라내므로(별도 설정 필요 없음, 자동),
여기로 노출한(신뢰할 수 없을 수 있는) dev 서버가 그 헤더를 읽어서
router-manager API를 대신 호출하는 일은 없습니다. 다만 이건 "노출된 서버가
헤더를 읽는" 경로만 막는 것으로, 완전한 origin 격리는 아닙니다 -
[router.md의 관련 절](router.md#보안-공유-origin과-전용-도메인routermanagerhosts)을
참고하세요.
