# WebDAV 파일 공유 계획

작성 2026-09-03. 아직 착수 전.

## 요구

다른 기기에서 파일 업/다운로드를 하고 싶은데 sftp는 느리고 전용 클라이언트가 필요해서
불편하다. 이미 HTTPS가 물려 있으니 WebDAV를 서브 서비스로 올리자. 비밀번호는
webmanager와 **분리**. webmanager에 "File share" 탭을 만들어 거기서 비밀번호 설정
(env로 먼저 설정 가능, `openssl rand` 랜덤 생성 권장).

## 먼저 바로잡을 전제

- **지금 구현된 WebDAV는 없다.** repo 전체에서 `webdav`/`PROPFIND`/
  `golang.org/x/net/webdav` 전부 0건. 처음부터 만드는 기능이다.
- **바깥 대문은 Caddy가 아니라 nginx다.** router의 Caddy(`caddy-adapter`)는 Dev Proxy /
  App Routes 전용 내부 백엔드고, 실제 프론트는
  `router/config/nginx/nginx.default.conf`. 그래서 "caddy에 path 하나 더"라는 그림은
  실제로는 **nginx location 하나 또는 App Route 하나**가 된다.
- `mholt/caddy-webdav` 모듈은 **못 쓴다.** router의 Caddy는 Arch 패키지
  (`router/Dockerfile:105`의 `pacman -S caddy`)라 xcaddy 커스텀 빌드가 아니다.
  게다가 Caddy는 router 컨테이너에 있고 파일(`/code`)은 code-docker 컨테이너에 있다.
- Caddy `basic_auth`는 이 레포에서 **한 번도 안 쓰인다**(grep 0건). 지금 있는 인증은
  argon2id 기반 Go 미들웨어 두 개(webmanager `internal/authgate`,
  router `internal/authgate` + `--hash-password`)와 tinyauth(forward-auth) 뿐이다.

## 가장 중요한 설계 제약: forward-auth 제외

이 스택은 바깥 리버스 프록시의 forward-auth(Authentik 등) 뒤에 있다는 전제로 설계돼
있다(루트 `CLAUDE.md`의 `auth: none` 항목). **WebDAV 클라이언트는 브라우저 SSO 리다이렉트
플로우를 못 탄다** — Finder/탐색기/Solid Explorer는 Basic auth만 안다.

그래서 "비밀번호를 webmanager와 분리한다"는 건 취향 문제가 아니라 **필수 조건**이다:
WebDAV 경로는 바깥 forward-auth에서 반드시 제외돼야 하고, 그러면 그 경로를 지킬 수단이
자체 Basic auth밖에 없다. 이건 사용자가 바깥 Caddy 설정에서 직접 해줘야 하는 부분이라
문서에 크게 박아야 한다.

→ 이 이유로 **path(`/files/`)보다 전용 호스트네임(`ROUTER_VHOST_*`)을 권장**한다.
경로 예외보다 호스트 단위 예외가 바깥 프록시에서 훨씬 적게 실수한다.

## 구현 선택지

| | 방식 | 판단 |
|---|---|---|
| a | Caddy `webdav` 모듈 | **기각.** xcaddy 빌드 스테이지 신설 + 파일이 없는 컨테이너 |
| b | 독립 데몬(`rclone serve webdav` / `hacdias/webdav`)을 supervisord 프로그램으로 | 가능. 이 레포 규약(`config/<name>/`, `config/supervisord.d/<name>.conf`)에 잘 맞음. 대신 바이너리 + 유닛 + 설정 파일이 새로 늘어남 |
| c | webmanager 안에 `golang.org/x/net/webdav` | **채택** |

**(c) 채택 이유**: 새 바이너리·새 supervisord 유닛·새 컨테이너 홉이 전부 0이다.
webmanager는 이미 `/code`가 있는 컨테이너에서 돌고, `internal/files`의 root-jail
경로 검증(`WEBMANAGER_FILES_ROOT`, 기본 `/code`, `config.go:211`)과 argon2id 해시
패턴(`internal/authgate/password.go`, `--hash-password`)을 그대로 재사용할 수 있다.
실제 신규는 `go.mod` 의존성 하나와 핸들러 배선 정도.

주의: `golang.org/x/net/webdav`는 유지보수가 활발하진 않고, 락은 in-memory
(`webdav.NewMemLS()`)라 다중 클라이언트 동시 편집엔 약하다. 개인 파일 공유 용도로는
충분하다고 보고 채택한다. 나중에 문제가 생기면 (b)로 갈아타기 쉬운 구조로 둔다
(경로/인증 계약만 유지하면 프록시 대상만 바뀜).

## 파일 매니저를 대체하는가 → **아니다**

사용자가 "직접 만들던 파일 서버 구현을 webdav에 위임"을 기대했지만, 이건 성립하지 않는다.
브라우저는 WebDAV를 네이티브로 마운트 못 하므로 webmanager 프론트엔드는 어차피 자기
REST API가 필요하다. 지금 백엔드는 `handlers_files.go`(293줄) +
`internal/files/`(723줄)이고, 배치 삭제/이동의 항목별 결과, 심볼릭 링크 타깃 표시,
8진수 퍼미션 표시, 인라인 텍스트 편집 같은 건 WebDAV 프로토콜 위에 다시 얹어야 한다 —
줄어드는 게 아니라 늘어난다.

→ **둘은 공존한다.** 같은 `/code` 루트를 보되, WebDAV는 "OS 네이티브 드래그&드롭"용,
파일 매니저는 "브라우저 안 관리"용. 공유되는 건 `internal/files`의 경로 검증뿐.

## 작업 항목

1. `webmanager/backend/go.mod`에 `golang.org/x/net` 추가
2. `internal/webdavshare/` — `webdav.Handler{FileSystem: webdav.Dir(root), LockSystem: NewMemLS()}` +
   Basic auth 미들웨어(argon2id, `internal/authgate/password.go` 재사용).
   루트는 `WEBMANAGER_WEBDAV_ROOT`(기본은 `WEBMANAGER_FILES_ROOT`와 동일하게 `/code`),
   별도 서브디렉터리로 좁히는 것도 허용
3. 설정: `WEBMANAGER_WEBDAV_ENABLED`(기본 false), `WEBMANAGER_WEBDAV_USER`,
   `WEBMANAGER_WEBDAV_PASSWORD_HASH`. **기본 비활성 + 해시 미설정이면 라우트 자체를 안 붙임**(fail-closed)
4. `webmanager --hash-password`가 이미 있으면 재사용, 없으면 동일 관례로 추가
5. 프론트엔드 "File share" 탭 — 활성/비활성, 사용자명, 비밀번호 설정.
   비밀번호는 직접 입력도 되지만 **`openssl rand -base64 24` 상당의 랜덤 생성 버튼을
   기본 유도**(생성값을 한 번만 보여주고 해시만 저장). 마운트 URL 안내 표시
6. 노출 경로 — router `ROUTER_VHOST_WEBDAV` 권장 경로를 문서화. path 방식도 쓸 수
   있게 nginx location 예시 같이 제공. 업로드용 nginx 튜닝 필수:
   `client_max_body_size 0`, `proxy_request_buffering off`,
   그리고 WebDAV 메서드(PROPFIND/MKCOL/MOVE/COPY/LOCK/UNLOCK) 통과 확인
7. `docs/tips/webdav.md` — 특히 **바깥 forward-auth에서 이 호스트/경로를 제외해야 한다**는
   경고를 맨 위에. 기기별 마운트 방법(Windows 탐색기, macOS Finder, Android Solid
   Explorer, `rclone mount`)
8. 보안 문서 갱신 — 루트 `CLAUDE.md`의 "Security-relevant, intentional trade-offs"에
   항목 추가(SSO 밖에 있는 단일 비밀번호 표면이 하나 생긴다는 사실)
