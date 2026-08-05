# dev 서버 노출 (Dev Proxy)

컨테이너 안에서 뜬 dev 서버(`npm run dev` 등)를 바깥 도메인으로 노출하는 기능입니다. 컨테이너 안에 별도의 내부 Caddy 인스턴스(`caddy-adapter` 프로그램)가 떠서 항목(expose)별로 로컬 포트로 리버스 프록시하고, [webmanager의 Dev Proxy 탭](webmanager.md)에서 관리합니다. 공유 base 도메인 같은 건 없습니다 — expose마다 완전히 독립적인 전체 호스트네임을 직접 지정합니다 (`dev.example.com`, `code.other-domain.org`처럼 서로 다른 도메인도 한 인스턴스에서 동시에 처리 가능). 실제로 무엇이 이 컨테이너까지 도달하는지는 전적으로 바깥 리버스 프록시가 무엇을 이 포트로 넘기는지에 달려있습니다.

## 켜고 끄기 / 기본 설정

`docker-compose.yml`의 두 환경변수로 제어합니다:

- `CADDY_ADAPTER_ENABLED` (기본 `"true"`) — `"false"`면 `caddy-adapter` 프로그램이 아무것도 안 하고 idle 상태로 떠 있습니다.
- `CADDY_ADAPTER_PORT` (기본 `8082`) — 컨테이너 안에서 caddy-adapter가 리스닝하는 내부 포트. 도메인은 여기서 설정하지 않고, expose마다 개별적으로 지정합니다 (아래 "expose 추가하기").

## expose 추가하기

[webmanager의 Dev Proxy 탭](webmanager.md)에서 먼저 이름(내부 식별자)과 host(외부에 노출할 전체 도메인, 예: `dev.example.com` — 라벨 하나만 와일드카드로 두고 싶으면 `*.staging.example.com`처럼 Caddy의 `host` matcher 와일드카드 문법을 그대로 쓸 수 있습니다)로 expose를 하나 만들고, 그 아래에 라우트를 원하는 만큼 추가하는 두 단계 구조입니다. "이름"은 파일명(`managed/<이름>.caddy`)과 Caddyfile `@이름` matcher 토큰으로만 쓰이는 내부 식별자라 점(`.`)을 포함할 수 없습니다 — 실제 노출 도메인은 항상 host 필드에 입력하세요. 이름과 host 둘 다 expose를 펼친 화면에서 나중에 바꿀 수 있습니다(각자 인라인 편집) — 이름을 바꾸면 파일도 새 이름으로 다시 쓰고 검증까지 통과한 뒤에만 옛 파일을 지우므로 중간에 실패해도 expose가 사라지지 않고, 이미 쓰이는 이름으로 바꾸려 하면 거부됩니다. 라우트 하나는:

- **라우팅 대상 path** — 예: `/api/*`. 비우면 전체 요청에 매치됩니다.
- **target** (`host:port`) — 리버스 프록시 대상. `127.0.0.1`/`0.0.0.0`이 아니라 `private:포트` 사용을 권장합니다 (아래 "tailscale과의 상호작용" 참고).
- **strip prefix** (선택) — 요청 경로에서 이 리터럴 문자열을 잘라내고(`uri strip_prefix`) 전달합니다.
- **리버스프록시 path** (선택) — strip 이후 남은 경로 앞에 이 문자열을 붙입니다(`rewrite * <값>{uri}`). 예를 들어 대상 path `/api/*`, strip `/api`, 리버스프록시 path `/v1/api`면 `/api/foo` 요청이 target에는 `/v1/api/foo`로 전달됩니다.
- **매칭 방식** — `route`(매치되면 무조건 실행, 다른 라우트와 독립적으로 겹쳐 실행 가능) 또는 `handle`(같은 서브도메인 안의 다른 라우트와 배타적, 먼저 매치되는 라우트 하나만 실행) 중 선택. Caddy 자체의 `route`/`handle` 디렉티브 의미 그대로입니다.
- **인증 요구** — 라우트별로 개별 설정. 서브도메인 목록에는 이 값들을 모아 전체 라우트가 인증을 요구하면 "요구", 일부만이면 "부분", 하나도 없으면 "없음"으로 표시됩니다.

같은 서브도메인 안의 라우트는 등록한 순서대로 평가되므로, 좁은 path(`/api/*`)를 넓은 path(전체 매치)보다 먼저 두어야 합니다. 저장하면 `/code/.local/share/code-docker/caddy-adapter/managed/<이름>.caddy` 파일 하나가 갱신되고, `caddy adapt`로 문법 검증 후 `caddy reload`로 무중단 반영됩니다 (검증 실패 시 반영 자체가 안 되고 에러가 그대로 표시됩니다).

폼이 다루지 못하는 특이 케이스(추가 헤더, 커스텀 matcher 등)는 같은 탭의 "원본 편집"으로 `.caddy` 파일 자체를 직접 고칠 수 있습니다.

`preserve_host`(업스트림에 원래 `Host` 헤더를 그대로 넘기는 옵션)는 기본적으로 켜지 않습니다 — 대부분의 dev 서버는 이거 없이도 잘 동작하고, Vite처럼 `Host` 헤더를 검사하는 도구를 쓰다가 막히면 그때 해당 dev 서버 설정에서 `allowedHosts`를 여는 쪽으로 대응하세요.

## 바깥 리버스 프록시 연결하기

### 기본: nginx의 `/exports/`를 경유 (권장)

code-docker는 이미 80번 포트에서 in-container nginx가 code-server(`/`)와
webmanager(`/manager`)를 합쳐서 서빙합니다 — Dev Proxy도 별도 포트를 새로
열기보다 이 80번을 그대로 재사용하는 게 기본 권장 경로입니다. 이렇게 하면
code-docker 컨테이너 하나가 바깥에 노출해야 하는 포트가 80 하나로 끝나고,
바깥 방화벽/보안그룹/tailnet ACL도 그 하나만 신경 쓰면 됩니다.

방법은 간단합니다 — 바깥 프록시가 dev-proxy로 보낼 요청의 **path 앞에만
`/exports`를 붙이고, Host는 그대로 둔 채** 80번 포트로 보내면, 컨테이너 안
nginx가 `/exports`를 벗겨내고 내부 Caddy(`caddy-adapter`)로 넘깁니다. Host가
그대로 전달되므로 `caddy-adapter`의 expose별 Host 매칭은 전혀 손댈 필요가
없고, dev 서버도 `/exports`를 보지 않으므로(nginx가 이미 벗긴 뒤) base
path를 따로 맞출 필요도 없습니다:

```
브라우저 → Host: dev.example.com, path: /api
바깥 Caddy → rewrite로 path 앞에 /exports 추가 (Host는 그대로) → ctip:80
in-container nginx → /exports 벗김 (Host는 그대로) → caddy-adapter
caddy-adapter → 기존과 동일하게 Host로 expose를 찾아 dev 서버로 전달
```

Caddy 예시 (도메인 하나, `containerip:80`은 code-server/webmanager와 동일한
그 IP·포트입니다):

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

`/exports`는 바깥 프록시와 code-docker의 nginx 사이에서만 쓰이는 내부
표시일 뿐이라 브라우저 URL이나 dev 서버가 받는 경로에는 전혀 나타나지
않습니다 — expose의 host 필드나 라우트 path/target 설정은 지금까지와
완전히 동일하게 적으면 됩니다.

`ALLOWED_EXPORT_HOSTS`(`example-env`, 기본 빈 값)로 `/exports/`가 받아들일
Host를 code-server/webmanager용 `ALLOWED_HOSTS`와 별도로 제한할 수 있습니다
— dev-proxy 도메인은 code-server 도메인보다 훨씬 자주 바뀌는 편이라 따로
관리합니다.

### 대안: `CADDY_ADAPTER_PORT`(기본 8082)를 직접 퍼블리시

`docker-compose.yml`의 `8082:8082`(기본 주석 처리)를 열면, `/exports` 리라이트
없이 예전처럼 caddy-adapter를 바깥에서 바로 볼 수 있습니다 — 컨테이너가
export하는 포트가 하나 더 늘어나는 대신, 바깥 프록시 설정에 rewrite 한 줄을
추가할 필요가 없습니다. caddy-adapter 자신은 Host 값을 가리지 않으므로,
expose에 등록해둔 host와 실제로 여기까지 들어오는 요청의 Host 헤더가
일치하기만 하면 됩니다.

```caddyfile
dev.example.com {
	reverse_proxy http://<container-ip>:8082
}
```

호스트 포트 퍼블리시 대신 같은 도커 네트워크에 바깥 프록시를 조인시켜
컨테이너 이름으로 바로 붙는 배치도 가능합니다.

> 호스트 포트 퍼블리시를 택했다면, [tailscale을 쓰는 경우 자동 노출에 주의하세요](tailscale.md#보안-tailnet-acl-설정) — `0.0.0.0`에 바인드된 포트는 tailscaled가 조건 없이 tailnet에도 재노출합니다. `CADDY_ADAPTER_PORT`도 sshd/code-server와 같은 카테고리이니 tailnet ACL grant에 포함시켜야 합니다. 반대로 기본(`/exports` 경유) 방식은 caddy-adapter가 호스트에 전혀 퍼블리시되지 않으므로 이 문제 자체가 없습니다.

## 인증

라우트마다 "인증 요구"를 켜면 그 라우트에 [webmanager의 비밀번호 게이트](webmanager-config.md#비밀번호-게이트)가 적용됩니다 — 새 인증 프로바이더를 따로 붙이는 대신, 이미 있는 게이트를 Caddy의 `forward_auth`에 연결하는 방식입니다. 두 환경변수가 반드시 설정되어 있어야 동작합니다:

- **`WEBMANAGER_CODE_SERVER_URL`** (`.env.webmanager`) — 인증이 안 된 요청을 리다이렉트할 로그인 페이지의 절대 URL을 서버가 조립하는 데 씁니다. 비어있으면 인증 요구 expose가 그냥 401만 반환하고 로그인 페이지로 넘어가지 않습니다.
- **`WEBMANAGER_AUTH_COOKIE_DOMAIN`** (`.env.webmanager`) — webmanager와 dev-proxy 서브도메인이 공유하는 상위 도메인(예: `.example.com`). 비어있으면 webmanager에서 잠금 해제해도 그 쿠키가 dev-proxy 서브도메인으로 전달되지 않아서 계속 로그인 페이지가 뜹니다.

두 값 모두 설정하면, webmanager에서 한 번 비밀번호를 풀면 그 잠금이 dev-proxy 열람에도 적용됩니다 — 다만 TTL이 다릅니다: webmanager 자체의 쓰기 작업(설정 변경 등) 재확인은 10분, dev-proxy 열람은 24시간입니다 (같은 토큰을 서로 다른 기준으로 검사하는 구조 — 웹매니저에서 설정을 자주 건드리는 세션과, 그냥 dev 페이지를 오래 띄워두고 보는 세션의 재로그인 빈도가 다르게 튜닝되어 있습니다).

인증이 없는 상태로 두려면 그냥 해당 라우트의 "인증 요구"를 끄면 됩니다 — 그 경우 바깥 리버스 프록시 쪽에서 별도로 auth를 걸지 않는 한 완전히 공개됩니다.
