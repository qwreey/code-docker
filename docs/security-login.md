# 보안 (로그인)

authentik 등의 SSO 프로바이더를 사용하는 것을 추천합니다. code-server(`/`)와
webmanager(`/manager`)는 code-docker 컨테이너 안 nginx가 한 origin으로
합쳐주고, 여기에 router 컨테이너 자신의 nginx가 `/exports/`(Dev Proxy),
`/app/`(App Routes), `/router/`(router-manager)까지 얹어 host:80 하나로
종단합니다 — code-docker는 더 이상 `code-docker-external`에 붙지 않아
외부에서 직접 닿지 않고, host에 퍼블리시된 포트도 router의 80번 하나뿐입니다
(자세한 경위는
[dev-proxy.md의 "바깥 리버스 프록시 연결하기"](../router/docs/dev-proxy.md#바깥-리버스-프록시-연결하기)
참고). 그래서 앞단 리버스 프록시는 **router 컨테이너 하나(`routerip:80`)**만
바라보면 됩니다.

이 문서는 code-server 자체를 앞단(바깥) 리버스 프록시로 어떻게 보호할지만
다룹니다 - 이것과 별개로, webmanager 자체 비밀번호 게이트
([webmanager-config.md의 비밀번호 게이트](webmanager-config.md#비밀번호-게이트),
`WEBMANAGER_AUTH_PASSWORD_HASH`), router-manager 자체 관리 API 비밀번호
([router.md의 router-manager 자체 인증](../router/docs/router.md#router-manager-자체-인증),
`ROUTER_MANAGER_AUTH_PASSWORD_HASH`), Dev Proxy/App Routes 라우트별
인증([router.md의 tinyauth](../router/docs/router.md#tinyauth), `TINYAUTH_AUTH_USERS`)이
서로 독립된 별도의 인증 계층으로 따로 존재합니다 - 이 문서에서 다루는 앞단
SSO를 켜둔다고 해서 저 세 가지가 자동으로 켜지거나 대체되지 않으며, 반대로
저것들을 켜둔다고 code-server 자체가 보호되지도 않습니다.

## PWA 설치가 안 되는 이유 (왜 일부 경로를 공개해야 하는지)

안드로이드 Chrome에서 "홈 화면에 추가"를 하면, Chrome은 로컬(사용자의 인증된 세션)에서 끝내지 않고 매니페스트에 적힌 아이콘 URL들을 구글의 WebAPK 빌드 서버로 넘겨서 그 서버가 직접 아이콘을 받아와 APK에 박아넣습니다(Chromium 소스에 실제로 "Send all of the icon URLs listed in Web Manifest to WebAPK Server"라는 커밋으로 남아있는 동작입니다 - [codereview.chromium.org/2453423002](https://codereview.chromium.org/2453423002)). 이 서버는 브라우저 쿠키가 전혀 없는 완전히 별도의 서버이기 때문에, forward_auth 뒤에 아이콘이 숨어있으면 이 서버는 로그인 페이지(또는 401)만 받고 실패합니다 - 실제로 사내망/포워드오스 인증 뒤에서 정확히 이 문제로 WebAPK 설치가 실패한다는 보고가 있습니다. 즉 **사용자 본인이 로그인돼 있는지는 전혀 상관없고, 아이콘이 "누구나(구글 서버 포함) 접근 가능"해야만 설치가 됩니다** - 예전에 인증을 통째로 지워야 설치가 됐던 게 이 때문입니다. `manifest.json`과 서비스워커(`serviceWorker.js`)도 같은 이유로 공개해두는 게 안전합니다(브라우저 자체는 이미 인증된 세션으로 문제없이 읽지만, 원격 서버가 추가로 다시 확인하는 경로일 수 있어 막아둘 이유가 없습니다). 반면 코드 패치 스크립트(`_static/lib/vscode/out/vs/patch/*` 안의 `.js`/`.css`)는 WebAPK 서버가 가져간다는 근거를 찾지 못했습니다 - 공개해도 무방하다는 판단 하에 같이 열어두는 것뿐, 설치 자체에 필요하다고 확인된 건 아닙니다.

## Caddy 예시

```Caddy
code.yaeji.moe {
  # PWA 설치(매니페스트/아이콘/서비스워커)에 필요한 경로는 인증 없이
  # 공개합니다 - 안드로이드 크롬 등 설치 가능한 apk를 생성하는 브라우저는
  # 실제 apk를 브라우저 자사 서버(구글/삼성 등)에서 빌드/사이닝하므로, 그
  # 서버가 인증 세션 없이 이 경로들에 접근 가능해야 PWA 설치가 동작합니다.
  @not_pwa_public {
    not path /manifest.json /_static/out/browser/serviceWorker.js /_static/src/browser/media/pwa-icon-*.png /_static/lib/vscode/out/vs/patch/*
  }

  # Authentik 프록시 프로바이더로 인증합니다.
  forward_auth @not_pwa_public http://authentik:9000 {
    uri /outpost.goauthentik.io/auth/caddy
    trusted_proxies private_ranges
  }
  reverse_proxy /outpost.goauthentik.io/* http://authentik:9000

  reverse_proxy http://routerip:80   # code-server(/) + webmanager(/manager) + Dev Proxy(/exports/) + App Routes(/app/) + router-manager(/router/) 전부 이 한 줄로 커버됩니다 - router 컨테이너 안 nginx가 라우팅합니다, IP는 여기 한 번만 적으면 됩니다
}
```

## nginx를 리버스 프록시로 쓰는 경우

컨테이너 안 nginx와는 별개로, 바깥 리버스 프록시로 nginx를 쓰는 경우에도 같은
원리로 예외 경로를 먼저 매칭시키면 됩니다. Authentik의 forward-auth(`auth_request`)
세부 설정은 [Authentik 공식 nginx 문서](https://docs.goauthentik.io/add-secure-apps/providers/proxy/server_nginx/)를
참고하시고, 아래는 예외 경로 처리 부분만 보여드립니다.

<details>
<summary>nginx 설정 예시 (예외 경로 처리 부분만)</summary>

```nginx
server {
    listen 443 ssl;
    server_name code.yaeji.moe;

    # PWA 설치용 예외 경로 - auth_request 없이 바로 프록시
    location = /manifest.json { proxy_pass http://routerip:80; }
    location = /_static/out/browser/serviceWorker.js { proxy_pass http://routerip:80; }
    location ~ ^/_static/src/browser/media/pwa-icon-.*\.png$ { proxy_pass http://routerip:80; }
    location /_static/lib/vscode/out/vs/patch/ { proxy_pass http://routerip:80; }

    # 나머지는 Authentik forward-auth 적용 (auth_request 등 - 공식 문서 참고)
    location / {
        auth_request /outpost.goauthentik.io/auth/nginx;
        proxy_pass http://routerip:80;
    }
    location /outpost.goauthentik.io/ {
        proxy_pass http://authentik:9000;
    }
}
```

</details>

## 여러 서브도메인 한 번에 로그인 (SSO) — `ROUTER_MANAGER_HOSTS` 등

[router.md의 "공유 origin과 전용
도메인"](../router/docs/router.md#보안-공유-origin과-전용-도메인routermanagerhosts)에서 설명하는
`ROUTER_MANAGER_HOSTS`(예: `router.code.yaeji.moe`)처럼, code-docker 관련
서비스를 완전히 별도 서브도메인으로 분리해서 노출하는 경우가 있습니다. 위
Caddy/nginx 예시는 `code.yaeji.moe` 한 도메인만 다루므로, 이런 서브도메인을
추가할 때마다 forward-auth 설정을 새로 붙여야 합니다 — 그리고 기본
forward-auth 방식(위 예시가 쓰는 "단일 애플리케이션" 모드)으로 그냥 도메인만
늘리면, 각 서브도메인이 서로 다른 세션 쿠키를 발급받아서 `code.yaeji.moe`에
로그인해도 `router.code.yaeji.moe`에서 다시 로그인해야 하는 상황이 됩니다.

한 번 로그인으로 여러 서브도메인을 동시에 통과하고 싶다면(예: `code.yaeji.moe`와
그 아래 `router.code.yaeji.moe`), Authentik의 프록시 프로바이더를 "단일
애플리케이션(single application)" 모드가 아니라 **"도메인 레벨(domain
level)" 모드**로 만들어야 합니다 — 각 서브도메인마다 애플리케이션/프로바이더를
따로 만들 필요 없이 프로바이더 하나로 같은 부모 도메인 아래 전부를
보호하고, "Cookie domain"을 두 서브도메인이 공유하는 부모 도메인(예:
`code.yaeji.moe` — `router.code.yaeji.moe`가 그 아래에 있으므로)으로 지정하면,
그 도메인으로 발급되는 세션 쿠키가 양쪽 서브도메인에 모두 전달되어 한 번만
로그인하면 됩니다. Caddy 쪽 `forward_auth` 지시문 자체는 도메인별로 거의
동일하게 반복하되(각 서브도메인의 site block에 하나씩), Authentik 쪽 provider
설정만 도메인 레벨 모드로 바꾸면 됩니다. 정확한 필드 이름/화면은 버전마다
바뀔 수 있으니 [Authentik 공식 문서의 Forward
auth](https://docs.goauthentik.io/add-secure-apps/providers/proxy/forward_auth/)에서
"domain level" 모드 절을 참고하세요 - Caddyfile의 `forward_auth` 지시문 문법
자체는 단일 애플리케이션/도메인 레벨 두 모드가 동일하고(Authentik 공식
Caddy 문서도 같은 지시문을 그대로 씁니다), SSO 여부를 가르는 건 오직
Authentik provider의 Cookie domain/모드 설정입니다.

위 [Caddy 예시](#caddy-예시)에 `router.code.yaeji.moe` 사이트 블록을 그대로
하나 더 추가하면 됩니다 - target은 여전히 `routerip:80` 하나입니다(router
자신의 nginx가 `ROUTER_MANAGER_HOSTS`로 지정된 Host를 보고 이 도메인 전용
`server{}` 블록으로 갈라태우므로, 바깥 Caddy는 도메인 하나가 늘었다는 것
말고는 신경 쓸 게 없습니다):

```Caddy
code.yaeji.moe {
  @not_pwa_public {
    not path /manifest.json /_static/out/browser/serviceWorker.js /_static/src/browser/media/pwa-icon-*.png /_static/lib/vscode/out/vs/patch/*
  }
  forward_auth @not_pwa_public http://authentik:9000 {
    uri /outpost.goauthentik.io/auth/caddy
    trusted_proxies private_ranges
  }
  reverse_proxy /outpost.goauthentik.io/* http://authentik:9000
  reverse_proxy http://routerip:80
}

router.code.yaeji.moe {
  # router-manager 자신은 PWA 설치 경로가 없으므로 예외 경로 없이 전체를
  # forward-auth로 덮습니다 - 같은 Authentik provider(도메인 레벨 모드, Cookie
  # domain=code.yaeji.moe)를 가리키므로 code.yaeji.moe에서 이미 로그인했다면
  # 여기서 다시 로그인 화면을 보지 않습니다.
  forward_auth http://authentik:9000 {
    uri /outpost.goauthentik.io/auth/caddy
    trusted_proxies private_ranges
  }
  reverse_proxy /outpost.goauthentik.io/* http://authentik:9000
  reverse_proxy http://routerip:80   # 같은 routerip:80 - Host 헤더로 router 자신의 nginx가 ROUTER_MANAGER_HOSTS 전용 server{} 블록으로 갈라줍니다
}
```

`ROUTER_MANAGER_HOSTS`로 분리한 도메인을 이 SSO 뒤에 두는 것도 이 문서
서두의 원칙과 동일합니다 - 앞단 SSO를 켠다고 router-manager 자체 비밀번호
게이트(`ROUTER_MANAGER_AUTH_PASSWORD_HASH`)가 자동으로 켜지거나 대체되지
않으므로, 둘 다 각자 필요에 따라 따로 설정하세요. 다만 router-manager는
자기 자신을 향한 PWA 설치 경로가 없으므로(위 "PWA 설치가 안 되는 이유"는
code-server 전용), 이 도메인은 예외 경로 없이 forward-auth로 전체를 덮어도
됩니다.

## 주의사항

**주의**: `/_static/lib/vscode/out/vs/patch/*` 는 `config/code/code-patch/`로 주입되는 파일 전체(코드 패치 스크립트, 커스텀 PWA 아이콘 등)를 통째로 인증 없이 공개합니다. 이 폴더에는 애초에 비밀번호/토큰 같은 민감한 값을 절대 넣지 않는 것을 전제로 하므로 위험하지 않지만, 직접 만든 override 스크립트에 실수로 민감한 값을 하드코딩하지 마세요 - **이 경로 아래 파일은 전부 누구나 볼 수 있습니다.**

이 방식이 번거롭거나 위 경로 목록이 자신의 code-server 버전과 안 맞는다면(내부적으로 code-server 자체 라우트를 참조한 것이라 업스트림 업데이트로 바뀔 수 있음), 기존 방식대로 아주 잠시동안 인증을 통째로 제거하고 설치 후 다시 인증을 설정하는 것도 괜찮습니다. 가능한 경우 인증을 제거할 때 `/api`, `/manager/api` 등은 차단하여도 좋습니다.
