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

---

# 구현 완료 (2026-09-04)

구현하면서 원안에서 바뀐 것들과, 나중에 이 기능을 건드릴 사람이 알아야 할 것들.

## 원안과 달라진 것

### 1. "라우트 자체를 안 붙임" → 라우트는 항상 붙이고 요청마다 판단

원안 항목 3은 fail-closed를 "설정이 없으면 mux에 등록하지 않는다"로 적어뒀다.
실제로는 `/webdav`와 `/webdav/`를 항상 등록하고, `Service.ServeHTTP`가 매 요청
`Status().Active`(켜짐 AND 해시 있음)를 보고 아니면 404를 돌려준다.

fail-closed 성질은 동일하다(비활성 상태에서 파일시스템을 아예 건드리지 않는다).
바꾼 이유는 **탭에서 켠 게 즉시 반영돼야** 하기 때문 — 등록 시점에 결정하면
비밀번호를 만들 때마다 webmanager 재시작이 필요해진다.

### 2. env 우선순위: "env로 먼저 설정 가능" → env는 항목별 고정(lock)

원안은 env를 초기값처럼 적어뒀지만, 초기값 방식은 "그래서 지금 뭐가 먹히고 있는
건가"가 화면에서 안 보인다. 최종 규칙은 항목별로 균일하게:

> `WEBMANAGER_WEBDAV_ENABLED` / `_USER` / `_PASSWORD_HASH` 중 **비어 있지 않은
> 값**은 그 항목을 고정한다. 탭은 그 항목을 잠그고 어느 env 변수 때문인지
> 표시하며, 그 값을 바꾸려는 PUT은 409로 거절된다.

거절이 조용하지 않은 게 요점이다 (`.claude` 피드백: 설치/설정 스크립트의 조용한
건너뛰기 금지).

### 3. argon2id 검증 캐시 (원안에 없던 것, 성능상 필수)

WebDAV 클라이언트는 쿠키를 못 쓰므로 **모든 요청**에 Basic auth를 새로 보낸다.
Finder로 폴더 하나 여는 데 PROPFIND + 파일 수만큼의 GET이 나가고, 그 전부가
64 MiB짜리 argon2id 유도를 유발한다 — 공유가 못 쓸 만큼 느려지고 자기 자신에
대한 DoS가 된다.

그래서 성공한 자격증명은 `HMAC(프로세스 랜덤 시크릿, user\0pass)` → 만료시각
맵에 5분간 캐시한다. 비밀번호/사용자명 변경 시 캐시를 통째로 비운다
(`resetAuthLocked`). 실패는 캐시하지 않으므로 무차별 대입에는 이득이 없고,
`authgate.Gate`의 IP별 백오프(5회 실패 후 지수 증가)를 그대로 쓴다.

**사용자명이 틀려도 argon2id 비용을 낸다** — 일부러 그렇게 뒀다. 사용자명 불일치에서
빨리 빠져나오면 응답 시간이 사용자명 oracle이 된다.

### 4. 노출 경로: 전용 nginx 리스너를 새로 만들었다

원안 항목 6은 `ROUTER_VHOST_WEBDAV`를 권장 경로로 적었는데, **그대로는 안 된다**:
router vhost의 upstream은 경로 없는 `host[:port]`라서(`router/config/nginx/
nginx-service.default.sh`의 charset 검사) `code-docker:80`을 가리키면 그
호스트네임에 code-server까지 통째로 노출된다.

그래서 `config/nginx/nginx.default.conf`에 두 번째 `server{}` 블록을 추가했다
(`NGINX_WEBDAV_PORT`, 기본 82) — `/webdav` 외 전부 404. 이제
`ROUTER_VHOST_WEBDAV="dav.example=code-docker:82"`가 의도대로 동작한다.

**경로는 두 리스너에서 똑같이 `/webdav/`다.** 전용 호스트네임 쪽에서 루트(`/`)로
rewrite하고 싶어질 텐데, 하면 안 된다: PROPFIND 응답의 `<D:href>`가 핸들러의
`Prefix`를 그대로 담아서 나가므로 프록시에서 경로를 바꾸면 클라이언트가 링크를
못 따라간다. 이게 `URLPrefix`를 설정 가능하게 만들지 않은 이유이기도 하다.

### 5. 심볼릭 링크 차단 (원안은 "경로 검증 재사용"까지만)

`webdav.Dir`는 `..` 탈출은 스스로 막지만 심볼릭 링크는 그냥 따라간다. 파일
매니저는 `files.ResolveForAccess`로 이미 이걸 막고 있어서, `jailedDir`가
`webdav.Dir`를 감싸서 모든 이름을 같은 함수로 검증한 뒤 위임한다. 두 기능이
"루트 안"의 정의를 공유하는 지점이 정확히 여기 하나다.

## 검증 결과

### 컨테이너 실측 (2026-09-04, 테스트 스택)

- fail-closed: 꺼진 상태에서 `:82/webdav/`, `:82/webdav`, `:82/`, `:80/webdav/`
  전부 404. 켜고 비밀번호만 없을 때도 404. 켠 뒤 `:80/`(code-server)과
  `:80/manager/`는 영향 없음.
- Basic auth: 무자격 401 + `WWW-Authenticate` 챌린지, 틀린 비번 401, 틀린
  사용자명 401, 정상 200.
- 프로토콜: PROPFIND 207(`<D:href>`에 `/webdav/` 접두사 정상), MKCOL 201,
  PUT 201, GET, MOVE 201, COPY 201, DELETE 204. 접두사 없는 `/webdav`로 보낸
  PROPFIND도 207.
- 200 MB 단일 PUT 정상(1 MiB 캡을 안 받는다는 확인).
- 심볼릭 링크: 루트 밖(`/etc/shadow`) 404, 루트 안 정상 서빙.
- 레이트 리밋: 틀린 비번 연속 5회까지 401, 6회째 429.
- **캐시가 백오프를 우회한다** — 429가 뜬 직후에도 올바른 자격증명은 200이었다.
  캐시에는 이미 검증에 성공한 값만 들어가므로 추측 공격에는 이득이 없고, 오히려
  같은 IP를 쓰는 정상 클라이언트가 다른 클라이언트의 실패 때문에 잠기지 않는
  바람직한 성질이다. 의도된 동작이니 "버그"로 고치지 말 것.
- 브라우저: File share 탭 렌더링/무작위 비밀번호 생성(한 번만 표시 + 복사 버튼)
  확인, 콘솔 에러 없음. 확인 후 공유는 끄고 `webdav.json`도 삭제해 원상복구했다.

### 로컬

- `go test ./internal/webdavshare/` — 11개 케이스: 비활성 404, 비밀번호 없이
  켠 상태 404, Basic auth 4분기(무자격/틀린 비번/틀린 사용자명/정상), 캐시 적중과
  비밀번호 변경 시 무효화, env 고정 3항목 + `ENABLED=false` 우선, 설정 파일
  왕복(0600 확인), 사용자명 `:` 거절, 심볼릭 링크 탈출 거절, `..` 탈출 봉쇄.
- `go build ./...` / `go vet ./...` / 전체 `go test ./...` 통과.
- `tsc --noEmit` / `npm run build` 통과.

## 남긴 것 (일부러 안 한 것)

- **읽기 전용 공유 옵션** — 원안에 없었고, 붙일 수 있으면 쓸 수도 있다. 노출
  사고 시 피해를 줄여주므로 나중에 넣을 만하다(메서드 화이트리스트 ~10줄).
- **`golang.org/x/net/webdav`의 in-memory LockSystem** — webmanager 재시작 시
  잠금이 사라진다. 개인 파일 공유 용도로는 충분하다고 보고 그대로 뒀다.
- **바깥 forward-auth 제외는 사용자 몫** — 이 레포가 바깥 프록시 설정을 만질 수
  없으므로, 문서(`docs/tips/webdav.md` 맨 위)와 탭 상단 경고로만 다룬다.

## 이 기능이 이상할 때 (후행 에이전트용)

**먼저 확인할 것 3가지**

```sh
# 1. 공유가 실제로 켜져 있고 비밀번호가 있는가 (둘 중 하나만 없어도 404)
docker compose exec code-docker cat /code/.local/share/code-docker/webmanager/webdav.json

# 2. env가 항목을 고정하고 있지 않은가 (고정돼 있으면 탭 저장이 409)
docker compose exec code-docker env | grep WEBMANAGER_WEBDAV

# 3. nginx가 두 리스너를 다 열었는가
docker compose exec code-docker ss -ltnp | grep -E ':(80|82) '
```

**증상별**

- **404만 온다** — 정상적인 fail-closed일 가능성이 높다. `GET /api/webdav`의
  `reason` 필드가 이유를 그대로 담고 있으니 그걸 먼저 봐라.
- **401이 반복된다** — 사용자명까지 맞는지 확인. 5회 실패 후에는 401이 아니라
  429가 나온다(그게 나오면 백오프 중).
- **비밀번호를 바꿨는데 옛 비밀번호가 계속 먹힌다** — 캐시 무효화가 깨진 것이다.
  `resetAuthLocked`가 `SetPassword`/`SetUsername` 양쪽에서 불리는지 확인
  (`TestSuccessfulAuthIsCached`가 이걸 잡는다).
- **폴더는 열리는데 파일이 404/403** — 심볼릭 링크일 수 있다. `jailedDir.check`가
  거절한 것이므로 설계대로다.
- **클라이언트가 목록은 받는데 그 안의 항목으로 못 들어간다** — 거의 확실히
  프록시에서 `/webdav` 접두사를 rewrite한 것이다. 위 4번 참고.
- **큰 업로드가 끊긴다** — 이쪽 nginx는 이미 `client_max_body_size 0` +
  `proxy_request_buffering off`다. 바깥 프록시를 봐라.

**고칠 때 깨면 안 되는 불변식 3가지**

1. `URLPrefix`는 핸들러가 벗기는 접두사이자 nginx가 넘기는 접두사다. 한쪽만
   바꾸면 PROPFIND 링크가 통째로 어긋난다.
2. 비활성 상태에서는 파일시스템에 손대지 않는다 — `Active` 검사는 반드시
   `ServeHTTP` 맨 앞에 있어야 한다.
3. WebDAV 디스패치는 `server.go`의 `webdavRouter`가 mux **앞**에서 한다.
   `limitRequestBody`보다 앞이라 1 MiB 캡을 안 받는데, mux 안으로 되돌리면 그
   면제가 사라져 큰 업로드가 전부 깨진다. 게다가 mux 등록 자체가 불가능하다 —
   아래 "실수 기록" 참고.

## 실수 기록 (2026-09-04)

`mux.Handle("/webdav/", ...)`로 등록했다가 **컨테이너를 띄우는 순간 패닉**했다:

```
pattern "GET /" conflicts with pattern "/webdav/":
GET / matches fewer methods than /webdav/, but has a more general path pattern
```

`go build`/`go vet`/`go test`는 전부 통과했다 — `net/http.ServeMux`의 충돌 검사는
**등록 시점(런타임)**에만 돈다. 정적 핸들러가 `GET /`로 등록돼 있고 WebDAV는
메서드를 못 고정하니(PROPFIND/MKCOL/MOVE/...) 구조적으로 mux에 넣을 수 없다.

교훈: webmanager에 `/api` 밖의 새 최상위 경로를 추가할 때는 **반드시 컨테이너를
띄워서 확인해라.** 빌드가 통과했다는 건 이 클래스의 버그에 대해 아무 말도 하지
않는다.

두 번째 실수: nginx의 `proxy_set_header Host $host`로 시작했다가 **MOVE가 502**로
떨어졌다. `$host`는 포트를 떼어내는데, MOVE/COPY는 `Destination` 헤더에 포트가
붙은 절대 URL을 담고 `x/net/webdav`가 그걸 `r.Host`와 대조해 다르면 502를 준다.
`$http_host`로 바꿔서 해결. 표준 포트(80/443) 뒤에서는 증상이 안 나오므로,
전용 리스너(82)로 실측하지 않았으면 못 잡았을 버그다.

세 번째: `PUT /api/webdav`의 요청 바디를 `bool`/`string`으로 받았더니 필드를
생략한 요청이 **조용히 공유를 꺼버렸다**(Go의 zero value가 `false`). 포인터로
바꿔서 "생략 = 그대로 두기"로 만들었고, 비밀번호 엔드포인트도 필드 누락을 400으로
거절하게 했다(오타 하나로 자격증명이 날아가면 안 되므로).
