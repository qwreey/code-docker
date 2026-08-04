# dev 서버 노출 (Dev Proxy)

컨테이너 안에서 뜬 dev 서버(`npm run dev` 등)를 와일드카드 서브도메인(예: `*.dev.example.com`)으로 바깥에 노출하는 기능입니다. 컨테이너 안에 별도의 내부 Caddy 인스턴스(`caddy-adapter` 프로그램)가 떠서 서브도메인별로 로컬 포트로 리버스 프록시하고, [webmanager의 Dev Proxy 탭](webmanager.md)에서 항목(expose)을 관리합니다.

## 켜고 끄기 / 기본 설정

`docker-compose.yml`의 세 환경변수로 제어합니다:

- `CADDY_ADAPTER_ENABLED` (기본 `"true"`) — `"false"`면 `caddy-adapter` 프로그램이 아무것도 안 하고 idle 상태로 떠 있습니다.
- `CADDY_ADAPTER_DOMAIN` (기본 비어있음) — 와일드카드 도메인, 예: `*.dev.example.com`. 비어있으면 caddy는 뜨지만 아무 서브도메인도 노출하지 않습니다.
- `CADDY_ADAPTER_PORT` (기본 `8082`) — 컨테이너 안에서 이 와일드카드 사이트가 리스닝하는 내부 포트.

## expose 추가하기

[webmanager의 Dev Proxy 탭](webmanager.md)에서 이름(서브도메인), target(`host:port`), 필요하면 `/api/*`만 다른 target으로 분리, 인증 요구 여부를 입력하면 됩니다. 저장하면 `/code/.caddy-adapter/managed/<이름>.caddy` 파일 하나가 생성되고, `caddy adapt`로 문법 검증 후 `caddy reload`로 무중단 반영됩니다 (검증 실패 시 반영 자체가 안 되고 에러가 그대로 표시됩니다).

폼이 다루지 못하는 특이 케이스(추가 헤더, 커스텀 matcher 등)는 같은 탭의 "원본 편집"으로 `.caddy` 파일 자체를 직접 고칠 수 있습니다.

`preserve_host`(업스트림에 원래 `Host` 헤더를 그대로 넘기는 옵션)는 기본적으로 켜지 않습니다 — 대부분의 dev 서버는 이거 없이도 잘 동작하고, Vite처럼 `Host` 헤더를 검사하는 도구를 쓰다가 막히면 그때 해당 dev 서버 설정에서 `allowedHosts`를 여는 쪽으로 대응하세요.

## 바깥 리버스 프록시 연결하기

code-docker 자체는 `CADDY_ADAPTER_PORT`(기본 8082)를 컨테이너 밖에 직접 열어주지 않습니다 (`docker-compose.yml`의 `8082:8082`는 기본 주석 처리) — 80번 포트와 마찬가지로, 바깥 리버스 프록시가 이 포트를 향해 와일드카드 서브도메인을 통째로 넘겨주는 구성을 권장합니다.

Caddy 예시:

```caddyfile
*.dev.example.com {
	reverse_proxy http://<container-ip>:8082
}
```

nginx 예시:

```nginx
server {
	server_name ~^(?<sub>.+)\.dev\.example\.com$;
	location / {
		proxy_pass http://<container-ip>:8082;
		proxy_set_header Host $host;
	}
}
```

호스트 포트 퍼블리시(`8082:8082` 주석 해제) 대신 같은 도커 네트워크에 바깥 프록시를 조인시켜 컨테이너 이름으로 바로 붙는 배치도 가능합니다 — 어느 쪽이든 code-docker가 강제하지 않는, 여러분의 인프라 배치에 달린 선택입니다.

> 호스트 포트 퍼블리시를 택했다면, [tailscale을 쓰는 경우 자동 노출에 주의하세요](tailscale.md#보안-tailnet-acl-설정) — `0.0.0.0`에 바인드된 포트는 tailscaled가 조건 없이 tailnet에도 재노출합니다. `CADDY_ADAPTER_PORT`도 sshd/code-server와 같은 카테고리이니 tailnet ACL grant에 포함시켜야 합니다.

## 인증

expose마다 "인증 요구"를 켜면 해당 서브도메인에 [webmanager의 비밀번호 게이트](webmanager.md)가 적용됩니다 — 새 인증 프로바이더를 따로 붙이는 대신, 이미 있는 게이트를 Caddy의 `forward_auth`에 연결하는 방식입니다. 두 환경변수가 반드시 설정되어 있어야 동작합니다:

- **`WEBMANAGER_CODE_SERVER_URL`** (`.env.webmanager`) — 인증이 안 된 요청을 리다이렉트할 로그인 페이지의 절대 URL을 서버가 조립하는 데 씁니다. 비어있으면 인증 요구 expose가 그냥 401만 반환하고 로그인 페이지로 넘어가지 않습니다.
- **`WEBMANAGER_AUTH_COOKIE_DOMAIN`** (`.env.webmanager`) — webmanager와 dev-proxy 서브도메인이 공유하는 상위 도메인(예: `.example.com`). 비어있으면 webmanager에서 잠금 해제해도 그 쿠키가 dev-proxy 서브도메인으로 전달되지 않아서 계속 로그인 페이지가 뜹니다.

두 값 모두 설정하면, webmanager에서 한 번 비밀번호를 풀면 그 잠금이 dev-proxy 열람에도 적용됩니다 — 다만 TTL이 다릅니다: webmanager 자체의 쓰기 작업(설정 변경 등) 재확인은 10분, dev-proxy 열람은 24시간입니다 (같은 토큰을 서로 다른 기준으로 검사하는 구조 — 웹매니저에서 설정을 자주 건드리는 세션과, 그냥 dev 페이지를 오래 띄워두고 보는 세션의 재로그인 빈도가 다르게 튜닝되어 있습니다).

인증이 없는 상태로 두려면 그냥 "인증 요구"를 끄면 됩니다 — 그 경우 바깥 리버스 프록시 쪽에서 별도로 auth를 걸지 않는 한 완전히 공개됩니다.
