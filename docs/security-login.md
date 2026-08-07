# 보안 (로그인)

authentik 등의 SSO 프로바이더를 사용하는 것을 추천합니다. code-server(`/`)와
webmanager(`/manager`)는 컨테이너 안 nginx가 한 origin으로 합쳐주므로, 앞단
리버스 프록시는 이 컨테이너 하나(`containerip:80`)만 바라보면 됩니다.

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

  reverse_proxy http://containerip:80   # code-server(/) + webmanager(/manager) 전부 이 한 줄로 커버됩니다 - 컨테이너 안 nginx가 라우팅합니다, IP는 여기 한 번만 적으면 됩니다
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
    location = /manifest.json { proxy_pass http://containerip:80; }
    location = /_static/out/browser/serviceWorker.js { proxy_pass http://containerip:80; }
    location ~ ^/_static/src/browser/media/pwa-icon-.*\.png$ { proxy_pass http://containerip:80; }
    location /_static/lib/vscode/out/vs/patch/ { proxy_pass http://containerip:80; }

    # 나머지는 Authentik forward-auth 적용 (auth_request 등 - 공식 문서 참고)
    location / {
        auth_request /outpost.goauthentik.io/auth/nginx;
        proxy_pass http://containerip:80;
    }
    location /outpost.goauthentik.io/ {
        proxy_pass http://authentik:9000;
    }
}
```

</details>

## 주의사항

**주의**: `/_static/lib/vscode/out/vs/patch/*` 는 `config/code/code-patch/`로 주입되는 파일 전체(코드 패치 스크립트, 커스텀 PWA 아이콘 등)를 통째로 인증 없이 공개합니다. 이 폴더에는 애초에 비밀번호/토큰 같은 민감한 값을 절대 넣지 않는 것을 전제로 하므로 위험하지 않지만, 직접 만든 override 스크립트에 실수로 민감한 값을 하드코딩하지 마세요 - **이 경로 아래 파일은 전부 누구나 볼 수 있습니다.**

이 방식이 번거롭거나 위 경로 목록이 자신의 code-server 버전과 안 맞는다면(내부적으로 code-server 자체 라우트를 참조한 것이라 업스트림 업데이트로 바뀔 수 있음), 기존 방식대로 아주 잠시동안 인증을 통째로 제거하고 설치 후 다시 인증을 설정하는 것도 괜찮습니다. 가능한 경우 인증을 제거할 때 `/api`, `/manager/api` 등은 차단하여도 좋습니다.
