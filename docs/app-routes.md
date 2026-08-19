# 경로 기반 앱 라우팅 (App Routes)

router 안에 앱/서비스가 여러 개 있어도 호스트에는 80번 포트 하나만 열어두고
싶을 때를 위한 기능입니다. 서비스마다 호스트 포트를 따로 여는 대신, **바깥
리버스 프록시(Caddy/nginx 등)가 원하는 요청 경로 앞에 `/app/<이름>`을 붙여서
(rewrite) router의 80번 포트로 그대로 넘기는 것**이 이 기능이 상정하는
기본 사용 방식입니다 — router 내부 Caddy가 그 접두사를 보고 알맞은 대상으로
다시 리버스 프록시하며, `/app/<이름>` 접두사는 대상에 전달되기 전에 자동으로
제거됩니다. Host 헤더는 전혀 보지 않고 경로만으로 판단하기 때문에([Dev
Proxy](dev-proxy.md)가 도메인/Host로 분배하는 것과 정반대), 바깥 프록시가
도메인마다 다른 Host 매칭 규칙을 새로 만들 필요 없이 그냥 경로 접두사만
바꿔서 여러 도메인/여러 내부 앱을 같은 방식으로 다룰 수 있습니다 — router가
자신보다 신뢰 수준이 낮은 code-docker의 실제 내부 앱 구조를 미리 알 필요가
없는 범용 국경 컨테이너([router.md](router.md) 참고)라는 설계와도 맞습니다.

다만 실제로는 그냥 일반적인 리버스 프록시 target 지정 방식이라, 바깥
프록시의 rewrite 없이 router에 직접 `/app/<이름>/...`로 접근해도 똑같이
동작합니다 — 원래 요구사항은 아니었지만, 로컬 테스트나 바깥 프록시 설정
없이 바로 쓰고 싶을 때 유용한 보너스입니다(아래 "바깥 리버스 프록시 연결하기"
참고).

내부 Caddy 인스턴스(Dev Proxy와 같은 `caddy-adapter` 프로그램, router
컨테이너 안에서 실행)가 이 라우팅을 전담하고, router 자신의 nginx는
`/app/`로 시작하는 요청을 그대로(경로를 건드리지 않고) 이 Caddy로 넘기는
고정된 location 블록 하나만 가지고 있습니다 — 앱을 몇 개를 추가/삭제/변경하든
이 nginx 설정은 다시 바뀔 필요가 없습니다(nginx가 깨지면 router-manager
관리 UI 접근 자체가 막히므로, 앱마다 바뀌는 로직은 전부 Caddy 쪽으로
넘기고 nginx는 최대한 고정해 둔 설계입니다). [webmanager의 App Routes
탭](webmanager.md)에서 관리합니다(router가 제공하는 페이지 컴포넌트를
webmanager가 그대로 가져와 보여주는 것 — Dev Proxy 탭과 같은 방식).

## 켜고 끄기

별도의 켜고 끄기 스위치가 없습니다 — Dev Proxy와 같은 Caddy 프로세스
안에서 함께 동작하므로 `CADDY_ADAPTER_ENABLED`(기본 `"true"`)로 이미
제어됩니다. `"false"`면 Dev Proxy와 App Routes 둘 다 idle 상태가 됩니다.

## 기본 앱 (code)

최초 부팅 시 딱 한 번 `code → code-docker:80` 앱이 자동으로 생성됩니다 —
그래서 아무 설정 없이도 `/app/code/`로 code-server, `/app/code/manager`로
webmanager에 닿습니다(code-docker 자신의 내부 nginx가 `/` vs `/manager`를
그대로 나눠줍니다). 이후 이 앱을 지우거나 이름/대상을 바꾸면 **다시
자동으로 생기지 않습니다** — router 컨테이너 안 버전 파일
(`/var/lib/code-docker-router/caddy-adapter/.migration-version`, `config/user-init/user-init.default.sh`와
같은 방식의 1회성 마이그레이션 카운터)로 "한 번도 존재한 적 없음"과
"유저가 일부러 지움"을 구분하기 때문입니다. 다시 필요해지면 버전 파일을
건드릴 필요 없이 그냥 App Routes 탭에서 `code` → `code-docker:80`을
수동으로 다시 추가하면 됩니다.

## 앱 추가하기

[webmanager의 App Routes 탭](webmanager.md)에서 이름과 target 두 값만
입력하면 됩니다:

- **이름** — `/app/<이름>/` 의 경로 세그먼트이자 내부 식별자입니다(파일명
  `apps/<이름>.caddy`로도 쓰입니다) — 소문자/숫자/하이픈만 허용되고 점(`.`)은
  포함할 수 없습니다. Dev Proxy의 "이름"과 동일한 제약이지만, App Routes에는
  별도의 host 필드가 없습니다 — 애초에 Host와 무관하게 동작하는 게 이
  기능의 핵심이기 때문입니다.
- **target** (`host:port`) — 리버스 프록시 대상. router 컨테이너 기준으로
  reachable해야 합니다 — `127.0.0.1`/`localhost`는 router 자기 자신을
  가리켜 code-docker 안 앱에 닿지 않습니다. `code-docker:포트`처럼 compose
  서비스 호스트네임을 쓰세요. 기본적으로 `code-docker`/`dind` 두 호스트네임만
  허용되고 그 외 대상은 거부됩니다(Caddy 자신의 admin API 등을 겨냥한
  self-SSRF 방지) — `APPROUTES_ALLOW_EXTERNAL_TARGETS="true"`로 제한을
  통째로 풀거나, `ROUTER_EXTRA_ALLOWED_TARGET_HOSTS`(`.env.router`)로
  특정 호스트만(예: `EXTRA_INCLUDE`로 붙는 sibling 프로젝트의 alias)
  허용 목록에 추가할 수 있습니다 — router 자기 자신(`localhost`/`127.0.0.1`/`router`)과
  tailscale forwards의 `forward` 별칭([tailscale 절](router.md#tailscale)
  참고 — 이것도 router 자신을 가리키는 alias)은 이 옵트아웃으로도 절대
  허용되지 않습니다. Dev Proxy의 `DEVPROXY_ALLOW_EXTERNAL_TARGETS`와는 완전히
  독립된 별도 값입니다 — 두 기능이 각자 따로 대상 제약을 풀 수 있습니다.
- **인증 요구** (선택) — 켜면 이 앱에 [router의 tinyauth](router.md#tinyauth)가
  적용됩니다.

Dev Proxy의 라우트와 달리 path/strip prefix/리버스프록시 path/매칭 방식
필드가 없습니다 — 앱 하나당 경로 모양이 `/app/<이름>/*` 하나로 고정이고,
Caddy의 `handle_path`가 매치된 접두사를 자동으로 잘라내므로 수동으로 지정할
게 없기 때문입니다.

폼이 다루지 못하는 특이 케이스는 같은 탭의 "원본 편집"으로 `.caddy` 파일
자체를 직접 고칠 수 있습니다(Dev Proxy와 동일).

## 바깥 리버스 프록시 연결하기

Dev Proxy의 `/exports/`와 달리 별도의 접두사-벗기기 트릭이 필요 없습니다 —
router 자신의 nginx가 `/app/`로 들어오는 요청을 경로를 건드리지 않고 그대로
Caddy에 넘기기 때문에, **바깥 프록시가 직접 원하는 경로 앞에 `/app/<이름>`을
붙여서** router의 80번 포트로 보내기만 하면 됩니다:

```caddyfile
code.yaeji.moe {
	rewrite / /app/code{uri}
	reverse_proxy http://routerip:80
}
```

이 예시는 `code.yaeji.moe`로 들어오는 모든 요청 앞에 `/app/code`를 붙여
router로 넘깁니다 — router의 Caddy가 `/app/code`를 벗기고 `code-docker:80`
으로 전달하므로, 결과적으로 [security-login.md](security-login.md)의
기본 예시와 동일하게 동작합니다. App Routes가 진가를 발휘하는 경우는
router가 내부 구조를 모르는 채로 여러 설정에 재사용될 때입니다 — 바깥
프록시가 Host별로 다른 매칭 규칙을 새로 만들 필요 없이, 그냥 앱 이름만
바꿔서 경로 앞에 붙이면 서로 다른 여러 내부 앱을 같은 방식으로 노출할 수
있습니다:

```caddyfile
app-a.example.com {
	rewrite / /app/app-a{uri}
	reverse_proxy http://routerip:80
}

app-b.example.com {
	rewrite / /app/app-b{uri}
	reverse_proxy http://routerip:80
}
```

nginx를 바깥 프록시로 쓴다면:

```nginx
server {
	server_name code.yaeji.moe;
	location / {
		rewrite ^ /app/code$request_uri break;
		proxy_pass http://routerip:80;
		proxy_set_header Host $host;
	}
}
```

`CADDY_ADAPTER_PORT`(Dev Proxy의 "대안" 경로)처럼 App Routes를 직접
퍼블리시하는 방법은 없습니다 — router 80번 포트의 `/app/` 위치를
통해서만 접근 가능하도록 의도적으로 고정했습니다. 애초에 이 기능의
목적 자체가 "포트를 여러 개 열지 않고 바깥 리버스 프록시의 rewrite
하나로 여러 앱을 노출한다"는 것이므로, `/app/<이름>` 접두사 없이
대상에 곧바로 도달할 수 있어야 한다는 요구사항 자체가 없습니다.

> 참고: 그렇다고 `/app/<이름>/...`로 직접 접근하는 게 막혀있는 건
> 아닙니다 — 위 예시들처럼 그냥 일반적인 리버스 프록시 target일 뿐이라,
> 바깥 프록시 없이 브라우저에서 router에 곧바로
> `http://<router>/app/code/manager` 식으로 들어가도 똑같이 동작합니다
> (기본 `code` 앱을 지우지 않았다면 `localhost/app/code/manager`도
> 그대로 됩니다). 원래 의도된 사용 경로는 아니지만, 로컬 테스트나
> 바깥 프록시 없이 바로 쓰고 싶을 때 유용한 보너스입니다.

## 알려진 한계 — 절대경로 응답은 제한적으로만 다뤄집니다

`/app/<이름>` 접두사가 제거된 채로 대상에 전달되기 때문에, 대상이 되돌려주는
응답 안의 경로 표현에 따라 두 가지 서로 다른 상황이 생깁니다:

- **HTTP 리다이렉트(`Location` 헤더)** — 자동으로 보정됩니다. 예를 들어
  code-server 내부 nginx는 `/manager`(슬래시 없이) 요청에 `Location:
  http://호스트/manager/`로 절대경로 리다이렉트를 보내는데, 그대로 두면
  `/app/code` 접두사가 사라져서 앱 라우팅을 벗어납니다. 그래서 각 앱의
  Caddy fragment는 `reverse_proxy` 안에 `header_down Location`으로 이
  헤더를 다시 `/app/<이름>/` 아래로 감싸는 규칙을 자동으로 포함합니다 —
  별도 설정 없이 항상 적용됩니다.
- **HTML/JS/CSS 안에 박힌 절대경로** — 이건 보정되지 않습니다. 예를 들어
  webmanager 프론트엔드는 빌드 시점에 `/manager/assets/...`처럼 루트 기준
  절대경로로 에셋을 참조하도록 굳어 있는데, 이런 응답 본문 안의 경로는
  App Routes(또는 리버스 프록시 일반)가 건드리지 않으므로 `/app/code`
  접두사 없이 그대로 브라우저에 남습니다. 이 리포 안 테스트 환경에서는
  router의 기본 catch-all(`location /`, 이 문서 밖의 "나머지 전부"
  라우트)이 여전히 같은 경로를 커버해서 우연히 동작하지만, App Routes만
  단독으로 노출되는 배치에서는 깨질 수 있습니다. 이건 응답 본문을 다시
  써야 하는 문제라(Dev Proxy의 `preserve_host`처럼) 이 기능의 범위 밖으로
  남겨둡니다 — 대상 앱 자체가 base path를 인식하도록 설정할 수 있다면
  그쪽이 근본적인 해결책입니다.

## 인증

앱마다 "인증 요구"를 켜면 그 앱에 [router의 tinyauth](router.md#tinyauth)가
적용됩니다 — Dev Proxy의 라우트별 인증과 동일한 메커니즘(Caddy의
`forward_auth`를 tinyauth에 연결)입니다. 사용하려면 tinyauth에 최소 한
명의 사용자가 등록되어 있어야 합니다 — [router.md#tinyauth](router.md#tinyauth)의
`TINYAUTH_AUTH_USERS` 생성 방법을 확인하세요.

인증이 없는 상태로 두려면 그냥 "인증 요구"를 끄면 됩니다 — 그 경우 바깥
리버스 프록시 쪽에서 별도로 auth를 걸지 않는 한 완전히 공개됩니다.

## 보안: router-manager 쿠키는 자동으로 잘려서 넘어갑니다

Dev Proxy(`/exports/`)와 마찬가지로 `/app/`도 기본적으로 code-server/
webmanager/router-manager와 같은 hostname을 씁니다 - router 자신의 nginx가
router-manager의 잠금 해제 쿠키(`router_manager_unlock`)를 프록시 직전에
헤더에서 잘라내므로(별도 설정 필요 없음, 자동), App Routes로 등록한 앱이 그
헤더를 읽어서 router-manager API를 대신 호출하는 일은 없습니다. 다만 이건
"등록된 앱이 헤더를 읽는" 경로만 막는 것으로, 완전한 origin 격리는 아닙니다
- [router.md의 관련 절](router.md#보안-공유-origin과-전용-도메인routermanagerhosts)을
참고하세요.
