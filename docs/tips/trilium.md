# Trilium 노트 연동 (code-docker-trilium)

[code-docker-trilium](https://github.com/qwreey/code-docker-trilium)을 `EXTRA_INCLUDE`로
붙이면 프로젝트 지식을 담는 [Trilium Notes](https://github.com/TriliumNext/Trilium)
인스턴스가 스택 안에 뜹니다. roblox-studio-docker와 같은 사이드 프로젝트 메커니즘이고,
submodule이 아닙니다.

붙이고 나면:

- Trilium이 **자기 도메인**에서 서비스됩니다 (`note.example.com` 같은, router의 vhost).
- code-docker 안의 Claude Code가 **Trilium 내장 MCP**로 노트를 읽고 씁니다.
- 설치된 code-server PWA 아이콘 **우클릭(길게 누르기) 메뉴에 "Trilium"** 항목이 생깁니다.

설치 절차, 인증 선택, MCP 등록은 그 레포의 `README.md`가 단일 출처입니다. 이 문서는
**code-docker 쪽에서 무슨 일이 일어나는지**만 설명합니다.

## 왜 `/app/trilium/`이 아닌가

App Routes(`/app/<이름>/`)로 붙이면 code-server와 **같은 origin**이 됩니다. 그런데
Trilium은 노트에 담긴 JavaScript를 실행하고(스크립트 노트 — 기능입니다) CSP를 켜지
않습니다. code-server의 origin에는 webmanager가 같이 있고, webmanager에는 터미널(루트
셸)과 파일 API가 있습니다(`WEBMANAGER_AUTH_PASSWORD_HASH`는 기본 꺼짐).

즉 한 origin에 두면 **노트 한 개가 컨테이너 셸**입니다. 이게 이론적인 얘기가 아닌 이유는
이 연동의 목적 자체가 "에이전트가 MCP로 노트를 쓰게 하는 것"이기 때문입니다 — 웹에서
읽어온 내용이 노트가 되는 경로가 실제로 존재합니다.

그래서 router의 **vhost**(호스트네임 하나를 통째로 주는 경로)를 씁니다. 이건 Trilium
전용 기능이 아니라 범용 기능입니다 — `router/docs/vhost.md` 참고.

## code-docker 쪽에서 바뀌는 것

`ootb.sh`/`migrate.sh`가 물어보는 값은 **호스트네임 하나**(`TRILIUM_HOST`)뿐이고, 그
값 하나가 세 군데로 갑니다 (전부 그 레포의 오버레이 파일이 선언합니다):

| 어디 | 무엇 |
|---|---|
| `code-docker-router` | `ROUTER_VHOST_TRILIUM="<호스트네임>=trilium:8080"` — router의 nginx가 그 호스트네임용 `server{}` 블록을 만듭니다 |
| `code-docker` | `WEBMANAGER_MANIFEST_SHORTCUT_TRILIUM="Trilium\|https://<호스트네임>/\|..."` — PWA 바로가기 |
| 바로가기가 여는 주소 | 같은 값 |

바깥 리버스 프록시에는 `ROUTER_MANAGER_HOSTS`/`TINYAUTH_HOSTS`와 **똑같이** 한 줄
추가하면 됩니다 (path rewrite 불필요):

```caddyfile
note.example.com {
    reverse_proxy http://routerip:80
}
```

PWA로 설치까지 하려면 매니페스트와 아이콘만 인증 예외로 빼야 합니다 — Trilium은
서비스워커가 없어서 경로가 `/manifest.webmanifest`, `/icon.png` 둘뿐입니다. 이유는
[security-login.md](../security-login.md)의 "PWA 설치가 안 되는 이유" 절과 같습니다.

## MCP

Trilium은 **v0.103.0부터 MCP 서버를 내장**하고 있어서 브리지가 필요 없습니다
(roblox-studio가 supergateway를 끼워야 했던 것과 다릅니다). `code-docker-internal` 위에서
직접 붙으므로 router도, 바깥 프록시도 거치지 않습니다.

```
claude (code-docker) ──code-docker-internal──> trilium:8080/mcp
브라우저 ──바깥 프록시──> router:80 ──vhost──> trilium:8080   (UI만)
```

등록은 roblox-studio와 같은 모양의 수동 1회입니다 — 진짜 게이트는 Trilium UI 안의
"MCP 서버" 토글(DB 옵션이라 환경변수로 못 켬)이라 ootb가 대신 해줄 수 있는 게 없습니다:

```sh
claude mcp add --transport http trilium http://trilium:8080/mcp \
  --header "Authorization: Bearer <ETAPI 토큰>" -s user
```

**토큰 하나가 노트 트리 전체를 읽고 씁니다** (Trilium에는 노트별 권한 모델이 없습니다).
개인 노트용 인스턴스와 이 프로젝트용 인스턴스를 섞지 마세요 — 자세한 내용과 완화 수단은
그 레포의 README를 보세요.

## 알아둘 것

- **iframe 탭은 못 만듭니다.** Trilium은 `X-Frame-Options: SAMEORIGIN`을 붙이므로
  webmanager에 Dev Proxy/VNC 같은 임베드 탭을 만들 수 없습니다. 그래서 PWA
  바로가기(새 창)로 갑니다.
- **바깥 인터넷에 못 나갑니다** (기본값). 링크 미리보기·아이콘 팩 다운로드가 안 되고,
  나머지는 영향 없습니다.
- **데이터는 `builds/code-docker-trilium/data/trilium/`에 쌓입니다.** compose 상대 경로는
  그 경로를 적은 파일 기준으로 풀리기 때문입니다. 운영에서는 `.env`의 `TRILIUM_VOLUME`에
  절대 경로를 넣으세요.
