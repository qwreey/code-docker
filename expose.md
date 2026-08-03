# code-server + webmanager를 한 origin으로 합치기 (리서치, 구현 전)

`code-server`(포트 80)와 `webmanager`(포트 81)를 지금처럼 서로 다른 도메인/포트로
따로 노출하는 대신, 하나의 origin 아래 경로로 합칠 수 있는지에 대한 조사 결과.
**결론부터: 가능하고, 생각보다 쉽다.** code-server를 건드릴 필요 없이 webmanager만
`/manager` 경로로 옮기면 된다 — 아래 "추천 아키텍처" 참고. 아직 아무 코드도
바꾸지 않았음, 검토용 문서.

## 배경 (지금 상태)

- `docker-compose.yml`: code-server `80:80`, webmanager `81:81` — 둘 다 컨테이너
  안에서 별개 supervisord program, 별개 포트.
- `README.md`("보안 (로그인)" 절): 각 서비스를 **서로 다른 서브도메인**으로
  외부 Caddy가 forward-auth(Authentik)를 앞단에 물려서 노출하는 게 현재 권장
  구성 (`code.yaeji.moe { reverse_proxy http://containerip:port }` 형태 블록을
  서비스마다 하나씩).
- webmanager는 자체 로그인이 없고, 지금은 PWA manifest도 전혀 없음(설치 불가) —
  프론트는 전부 절대경로(`/api/...`, `/assets/...`)로 하드코딩돼 있어 서브패스
  이전이 전제 없이는 안 됨.
- code-server 쪽은 `code-server-autoinstall`(벤더링된 fork)이 공식 릴리즈
  tarball을 받아서 `sed`로 몇 군데만 패치하는 구조 — 이미 `PWA_NAME`/
  `PWA_SHORT_NAME`/`PWA_ICON_PREFIX` env var로 매니페스트 일부를 건드리고 있음
  (`code-server-autoinstall/start.sh`의 `apply_pwa_metadata_patch`).

## 리서치 결과

### 1. code-server는 서브패스 호스팅을 이미 네이티브로 지원한다

**공식 문서에 예시가 있음**(`coder/code-server`의 `docs/guide.md`):

```
mydomain.com/code/* {
  uri strip_prefix /code
  reverse_proxy 127.0.0.1:8080
}
```

**`--base-path` 같은 플래그는 없음** — v2엔 있었는데 v3에서 빠짐. 메인테이너
`code-asher`가 [issue #1987](https://github.com/coder/code-server/issues/1987)에서
직접 밝힌 이유: *"code-server should work no matter what base you put it behind
so there should be no need for such a setting... To run code-server behind a
base path you'll need to run a reverse proxy like Caddy."*

**소스 레벨로 직접 확인함** (이 레포에 벤더링된 code-server 4.109.2 /
vscode 1.105.0 번들, `code-server-autoinstall/code-server/{out/node/http.js,
lib/vscode/out/server-main.js}` 및 최신 `microsoft/vscode`의
`src/vs/server/node/webClientServer.ts`): `{{BASE}}` 같은 템플릿 변수와
매니페스트/HTML 안의 모든 asset `src`/`href`는 **현재 요청 경로의 `/` 개수를
세서 상대경로(`./` 또는 `../../`)로 계산**되지, 고정된 절대경로 `/`가 아님.
그래서 prefix를 벗겨주는(strip-prefix) 리버스 프록시 뒤에서 "그냥 동작"한다 —
프록시가 `/code`를 벗겨서 Express의 정확한 경로 라우트(`/manifest.json`,
`/login` 등)는 그대로 매치되고, 응답에 박히는 URL은 전부 상대경로라 브라우저가
주소창의 실제 `/code/...` 기준으로 다시 계산해서 정확히 맞아떨어짐.

**알려진 함정**: **trailing slash가 중요함** — `location /code`(슬래시 없이)로
설정하면 상대경로 계산이 깨져서 `/login`으로 리다이렉트되어야 할 게
`/code/login`이 아니라 `/login`으로 새는 버그가 남 ([Discussion
#2072](https://github.com/coder/code-server/discussions/2072)). nginx/Caddy
설정 양쪽 다(`location`과 `proxy_pass` 타겟) trailing slash를 맞춰야 함.

**덜 알려진, 소스에서만 발견한 메커니즘**: `webClientServer.ts`의 루트 페이지
핸들러가 `X-Forwarded-Prefix` 헤더도 인식함(`getFirstHeader('x-forwarded-prefix')
|| this._basePath`) — 이건 upstream `microsoft/vscode` 자체 웹서버에서 그대로
가져온 기능이고, `coder/code-server`가 문서화하거나 실제로 쓰는 걸 확인 못함
(어디서 `_basePath`를 설정하는지도 못 찾음). **비공식/불안정한 경로로 취급**
— 벤더링된 4.109.2 번들의 minify된 동치 코드는 우선순위가 3단계
(`경로 세그먼트 || X-Forwarded-Prefix 헤더 || 기본값`)로 최신 `main`의 2단계
로직과 달라서, vscode 버전 간에 이 동작이 바뀌어왔다는 뜻 — 여기 의존하지 말고
공식 문서 예시(strip-prefix)를 쓰는 게 안전함.

`--proxy-domain`은 **서브도메인 전용**(`{{port}}.도메인` 형태, Host 헤더 기반)
— code-server 자신을 서브패스에 놓는 것과 무관, dind에서 뜬 다른 서비스 포트를
code-server 경유로 접근하기 위한 기능. `/proxy/<port>`(경로 벗김, 상대경로
친화적)와 `/absproxy/<port>`(경로 유지)도 마찬가지로 "code-server가 로컬의 다른
포트를 프록시해주는" 기능이지, code-server 자신의 서브패스 호스팅과는 별개.

### 2. PWA manifest — 이게 진짜 핵심

`GET /manifest.json`은 code-server 자체 라우트(`out/node/routes/vscode.js`)가
생성함. 확인된 내용: **`start_url: "."`**(상대경로 — manifest 자신이 fetch된
위치 기준으로 resolve됨, 서브패스에서도 안전), **`display: "fullscreen"`**,
**명시적 `scope` 필드가 없음** — Web App Manifest 스펙상 `scope`가 없으면
브라우저는 **manifest 파일 자신이 있는 디렉토리**를 기본 scope로 삼는다.
`workbench.html`의 `<link rel="manifest" href="{{VS_BASE}}/manifest.json"
crossorigin="use-credentials">`도 마찬가지로 템플릿/상대경로.

**즉 이렇게 됨**:
- code-server를 **지금처럼 루트(`/`)에 그대로 두면** → manifest는
  `/manifest.json`에서 서빙되고 → **기본 scope가 `/`** → PWA로 설치한 뒤
  `/manager`로 이동해도 (일반 `<a href>` 네비게이션이라면) **새 브라우저 창이
  뜨지 않고 같은 설치된 앱 창 안에서 이동함** — 스펙대로의 정상 동작.
  **추가 패치가 전혀 필요 없음.**
- 반대로 code-server를 `/code`로 옮기면 → manifest가 `/code/manifest.json`에서
  서빙되고 → 기본 scope가 `/code/`로 좁아짐 → `/manager`가 scope 밖이라 PWA
  창 안에서 안 열림 → scope를 명시적으로 `/`로 넓히는 매니페스트 패치를 새로
  만들어야 함(지금 `PWA_NAME`처럼 `sed`로 `scope: "/"`를 주입하는 정도, 어렵진
  않지만 **안 해도 될 일을 만드는 셈**).

이게 아래 "추천 아키텍처"에서 code-server는 그대로 두고 webmanager만 옮기자는
결론의 핵심 근거임.

FAQ(`docs/FAQ.md`)는 PWA 설치를 "브라우저 키바인딩 제한 우회용 워크어라운드"로만
언급함(Chrome 주소창 설치 아이콘, Firefox는 별도 확장 필요) — scope 관련 언급은
없음. `workbench.html`에서 등록되는 별도 service worker는 못 찾음(웹뷰는 FAQ의
"Why do web views not work?" 절에 나오듯 별개의, secure context 필요한
서비스워커를 쓰지만 이건 익스텐션 웹뷰 얘기라 이 논의와 무관).

### 3. 기존 사례

Caddy `uri strip_prefix`(공식 문서 예시) 또는 nginx
`location /code/ { proxy_pass http://127.0.0.1:8080/; }` **양쪽 다 trailing
slash 포함** — 확인된 성공 사례 어디에도 `sub_filter`(응답 본문 텍스트 치환)가
필요하다는 얘기는 없음. code-server가 이미 상대경로로 응답을 만들기 때문 —
`sub_filter`는 이 사실을 모르고 일반적인 "서브패스 nginx" 블로그 글을 따라하다
등장하는 불필요한 워크어라운드로 보임(또는 절대경로를 쓰는 다른 앱을
`/absproxy`로 물릴 때나 필요한 것).

## 추천 아키텍처

```
             ┌─────────────────────────────────────┐
  /manager/* │  nginx (또는 기존 외부 Caddy)          │
  ─────────► │  strip_prefix /manager                │──► webmanager :81
             │                                        │
  /* (그 외) │                                        │──► code-server :80 (그대로)
             └─────────────────────────────────────┘
```

**code-server는 루트에 그대로 둔다.** 서브패스로 옮기지 않음 — 위 리서치 2번
때문에 옮길 이유가 없고(오히려 scope 패치가 추가로 필요해짐), 옮기면 trailing
slash 함정 같은 리스크만 새로 생김. **webmanager만 `/manager`로 옮긴다** — 이건
100% 우리 코드라 원하는 대로 고칠 수 있고, 실패 리스크가 code-server 서브패스
호스팅보다 훨씬 낮음.

이렇게 하면:
- **크로스오리진 문제 없음** — 하나의 origin.
- **PWA 하나로 합쳐짐, 패치 불필요** — code-server의 기본 scope(`/`)가 이미
  `/manager`를 포함하므로, PWA로 설치한 code-server 창 안에서 `/manager`로
  이동해도 새 창이 안 뜸. 사용자가 원한 "별도 code-server PWA인데 매니저가
  나오면 좋겠다"를 정확히 만족.
- **React 컴포넌트를 code-server 쪽에서 직접 렌더**하는 건 여전히 안 됨(별개
  SPA라서) — 대신 `/manager`로의 정상 페이지 네비게이션이 같은 PWA 창 안에서
  일어나므로 체감상 거의 같음. 진짜 임베드(아래 "대안: iframe/위젯" 참고)는
  선택 사항으로 남겨둠.

### 필요한 변경

**nginx(또는 Caddy) 설정** — 새 컴포넌트:
```nginx
location /manager/ {
    proxy_pass http://127.0.0.1:81/;   # trailing slash 필수 — prefix 제거
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;   # 터미널 웹소켓(GET /api/terminal)용
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
location / {
    proxy_pass http://127.0.0.1:80;   # code-server, 지금과 동일, 무변경
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```
어디에 둘지 두 가지 옵션:
1. **컨테이너 안에 새 supervisord program으로**(`config/nginx.default.conf` +
   `config/nginx-service.default.sh`, 기존 override 패턴 그대로) — 컨테이너가
   외부 프록시 없이도 자체적으로 완결됨, 포트 80/81 대신 새 포트(예: 8080)
   하나만 노출. 코드베이스 컨벤션과 가장 잘 맞음.
2. **이미 쓰고 있는 외부 Caddy에 그대로 추가** — README의 기존 서브도메인 블록
   하나를 지우고 그 도메인 안에 `handle_path /manager/* { reverse_proxy
   ...:81 }` + `handle { reverse_proxy ...:80 }`로 교체. 컨테이너 안엔 아무것도
   안 늘어남, 대신 사용자가 직접 Caddy 설정을 관리해야 함(README에 이미
   Caddy 예시가 있으니 문서 갱신만 하면 됨).

**webmanager 프론트엔드** — 서브패스 인식 필요:
- `vite.config.ts`에 `base: '/manager/'` 추가 (빌드된 asset 경로용).
- `src/api/client.ts`의 `fetch(`/api${path}`)`를 `fetch(`${import.meta.env.BASE_URL}api${path}`)`
  로 변경 — Vite의 `base`는 빌드된 `<script>`/`<link>` 태그에만 자동 적용되고
  코드 안의 raw `fetch()` 호출까진 안 건드리므로 이 한 줄은 직접 고쳐야 함.
- 정적 아이콘(`favicon.svg`) 등 `public/` 아래 파일 참조도 `base`가 자동으로
  처리해줌(별도 수정 불필요).

**webmanager 백엔드**: **무변경**. nginx가 `/manager` prefix를 이미 벗겨주므로
Go 서버는 지금처럼 `/`, `/api/...` 그대로 받음 — `staticHandler`/라우트 전부
그대로. 비밀번호 게이트 쿠키(`Path: "/"`)도 그대로 유효(더 넓을 뿐, 문제 없음).

**code-server**: 무변경.

### 남는 선택 사항 (필수 아님)

- webmanager를 **독립적으로도** PWA 설치 가능하게 하고 싶다면(예: 폰 홈화면에
  매니저만 따로 고정) — webmanager 프론트에 자체 `manifest.json`을
  `scope: "/manager/"`로 추가하면 됨. README의 기존 주의사항(Android APK
  빌드 서버가 `manifest.json`+아이콘에 인증 없이 접근 가능해야 함)이 여기도
  그대로 적용됨 — 지금 있는 문구를 webmanager 매니페스트 경로까지 언급하도록
  갱신 필요.
- code-server 창 안에 매니저로 가는 버튼/링크를 하나 심고 싶다면, 지금 있는
  `config/code-patch/`(tailscale 배너와 같은 메커니즘)로 JS 하나만 추가하면
  됨 — 이건 서브패스 이전과 별개로 지금 당장도 가능.

## 검토했지만 덜 우선순위인 대안

### 대안: code-server를 `/code`로, webmanager를 `/manager`로 (둘 다 이동)

리서치 1번대로 기술적으로는 가능하지만, 위에서 설명했듯 code-server를 그대로
루트에 두는 쪽이 PWA scope 이슈가 아예 없어서 더 낫다. code-server 쪽을 굳이
옮길 이점(원래 있던 게 없어서 새로 생기는 리스크 대비)이 안 보여서 비권장.

### 대안: iframe/위젯으로 code-server 안에 매니저 임베드

사용자가 언급한 "위젯으로 넣거나 프레임으로 띄우거나" — 이미 있는
`config/code-patch/`(`window.CDDialog` 등)로 매니저를 iframe 안에 띄우는 배너/
패널을 하나 만들 수 있음. 지금 아키텍처(서로 다른 서브도메인) 그대로도 당장
가능함 — CORS는 문제 안 됨(iframe 안에서 매니저 프론트가 하는 fetch는 항상
자기 자신의 origin으로 가므로 부모 페이지의 origin과 무관), 다만:
- webmanager 응답에 `X-Frame-Options`/제한적 `frame-ancestors` CSP가 없어야
  함(지금은 Go 쪽에서 아무것도 안 설정하므로 열려있음 — 나중에 보안 헤더를
  추가한다면 이 사실을 기억해둬야 함).
- 두 서비스가 서로 다른 서브도메인이라도, Authentik 세션 쿠키의 Domain이
  상위 도메인(예: `.yaeji.moe`)으로 잡혀있으면(일반적인 Authentik 아웃포스트
  구성) 서드파티 쿠키 차단에 안 걸림 — 브라우저의 "서드파티 쿠키" 판단은
  eTLD+1(같은 최상위 도메인) 기준이지 서브도메인 기준이 아니라서, 같은
  루트도메인 아래 서브도메인끼리는 애초에 "서드파티"가 아님. 다만 실제로
  Authentik 쿠키 Domain 설정을 직접 확인은 못 했음 — 검토 시 확인 필요.

이 방식은 **"매니저를 code-server 화면 안에 작은 패널로 보고 싶다"**엔 지금
당장 제일 싼 방법이지만, "URL로 `/manager` 전체 화면을 정상적으로 열고 싶다"는
요구는 못 채움(iframe 안의 부분 화면일 뿐). 위 "추천 아키텍처"(경로 기반 합치기)
와 상호 배타적이지 않음 — 둘 다 할 수 있음(예: 평소엔 작은 상태 위젯만 iframe으로
띄워두고, 자세히 보려면 `/manager`로 이동).

### 대안: nginx 대신 Caddy를 컨테이너 안 supervisord program으로

기능적으로 nginx와 거의 동일(둘 다 `strip_prefix`/`location`으로 이 문제를
푼다). 이 레포가 README에서 이미 Caddy를 예시로 쓰고 있어서 사용자에게 더
익숙할 수 있음. 반대로 이 컨테이너 안엔 지금 Caddy가 전혀 없고 nginx도 없어서
"뭘 새로 들이든 하나는 새로 배워야 함"은 동일 — 어느 쪽이든 설정 파일 몇 줄
수준이라 실질적 차이는 크지 않음, 취향 문제로 남겨둠. (참고: `webmanager/.claude/research/caddy-plan.md`가
이미 있는데 그건 dev 서버를 와일드카드 서브도메인으로 노출하는 **다른** 기능
얘기라 이것과는 별개 — 그 기능이 먼저 Caddy를 들인다면 이 기능도 같은 Caddy
인스턴스를 재사용하는 게 자연스러울 수 있음, 참고만 해둠.)

## 결론 / 다음 단계 제안

1. **code-server는 그대로 두고 webmanager만 `/manager`로 옮기는 쪽을 추천**
   — 리스크 대비 얻는 게 가장 큼(단일 PWA, CORS 걱정 없음, code-server 무변경).
2. 컨테이너 안에 nginx를 새 supervisord program으로 넣을지, 아니면 기존 외부
   Caddy 설정만 고칠지는 사용자 선택 — 위 "필요한 변경" 절 어느 쪽으로 가든
   webmanager 프론트엔드 변경사항(`base`, api client prefix)은 동일하게 필요.
3. 구현 착수 전 결정할 것: 위 두 옵션 중 배치 위치, 그리고 webmanager를
   독립 PWA로도 설치 가능하게 할지 여부(선택 사항, 없어도 핵심 목표는 달성됨).
