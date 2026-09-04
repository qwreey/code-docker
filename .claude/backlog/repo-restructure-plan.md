# 레포 구조 정리 계획 (submodule → 원격 참조 + `dev/`)

작성 2026-09-03. 사용자 제안에 대한 판단 + 실행 계획. 아직 착수 전.

## 배경 / 제안

현재 code-docker는 submodule 4개(`code-server-autoinstall`, `envmigrate`, `router`,
`code-dind`)를 들고 있다. 사용자 제안:

- `code-dind`, `router`는 이미 독립 repo(`qwreey/dind-authz-docker`,
  `qwreey/router-docker`)이므로 submodule일 필요가 없다
- 대신 gitignore된 `dev/` 폴더를 두고 거기에 clone해서 개발
- `.env`로 각각의 빌드 컨텍스트를 로컬 경로에 바인딩(이미 있는
  `NETINIT_DOCKER_CONTEXT` 패턴), 기본값은 git URL
- `envmigrate`도 변경이 거의 없으니 submodule일 필요가 있나?
- 서브 프로젝트를 개발용으로 전부 받는 sh 스크립트 제공

## 실측으로 확인한 사실 (2026-09-03, Docker 29.7.2 / Compose 5.5.0)

이 두 가지가 계획의 전제이고, 둘 다 **된다**는 것을 실제 빌드로 확인했다.

1. **`ARG` 값을 `ADD`의 source로 쓸 수 있다.**
   ```dockerfile
   ARG SRC=https://github.com/qwreey/router-docker-client.git#main:netshare
   ADD $SRC /netshare
   ```
   기본값(원격 git)도, `--build-arg SRC=localsrc`(빌드 컨텍스트 안의 로컬 디렉터리)도
   둘 다 빌드 성공. → 지금 오버라이드 수단이 전혀 없는 `Dockerfile:89`(netshare),
   `Dockerfile:96`(dns-local), `code-dind/Dockerfile:26`(netshare)에도 `.env` →
   `build.args` 경유로 로컬 체크아웃 바인딩을 달 수 있다.

2. **Compose `include:`가 원격 git URL을 지원한다.**
   ```yaml
   include:
     - path: https://github.com/qwreey/router-docker.git#main:docker-compose.router.yml
   ```
   `docker compose config`가 정상 resolve했고, 그 파일 안의 `build.context: .`는
   `~/.cache/docker-compose/<커밋 sha>`로 잡혔다. 즉 router의 "이 파일 위치 기준으로
   상대경로가 풀린다"는 기존 설계(그 파일 상단 주석)가 원격에서도 그대로 성립한다.
   캐시 디렉터리 이름이 **커밋 sha**라서 새 커밋이면 새 디렉터리 → Docker의
   `ADD <url>` 캐시(af86213 사건, 루트 `CLAUDE.md` netshare 절)와 달리 stale 문제가
   구조적으로 덜하다.

## 판단 (항목별)

### `code-dind` → 원격 컨텍스트: **찬성**

순수 빌드 컨텍스트 하나뿐(`docker-compose.yml:273`의 `context:`). `netinit-docker`와
완전히 같은 모양이라 리스크가 가장 낮다. 여기부터 먼저 하는 게 좋다.

### `router` → 원격 include: **찬성** (위 실측 2번으로 가능 확인)

원래 이 항목이 유일한 블로커라고 봤는데(`include:`가 로컬 경로만 받을 거라고 가정),
실측 결과 원격이 된다. code-docker 쪽이 계속 소유해야 하는 것(`env_file: .env.router`,
`ROUTER_VOLUME` 바인드 마운트)은 지금도 code-docker의 `docker-compose.yml`에서
merge하는 구조라 그대로 유지된다 — 바뀌는 건 `path:` 한 줄뿐.

### `code-server-autoinstall` → 원격 `ADD`: **찬성, 단 반드시 핀**

`Dockerfile:102-103`의 단순 `COPY`라 전환은 가장 쉽다. 다만 이건 code-server를
설치/패치하는 물건이라 floating `#main`이 깨지면 컨테이너가 안 뜬다. **태그 핀 필수.**

### `envmigrate` → submodule 2개 다 제거: **찬성. 단 태그를 붙여서 정상 Go 모듈로.**

이게 제일 이득이 크다. 지금 같은 repo가 **두 번** 체크아웃돼 있고(루트 `envmigrate/`,
`router/envmigrate/`) 서로 다른 커밋에 핀돼 있다(`89cc257` vs `a5841a1`). 게다가
`router/vendor-envmigrate.sh`를 수동으로 다시 돌려야 하는 vendor 단계까지 붙어 있다.

단, **그냥 submodule만 지우면 빌드가 깨진다**: 두 `go.mod` 모두
`require github.com/qwreey/envmigrate v0.0.0` + `replace => <경로>` 조합인데,
`v0.0.0`은 유효한 해석 가능 버전이 아니라서 `replace`가 사라지면 resolve가 안 된다.
그리고 envmigrate repo에는 **태그가 하나도 없다**(`git tag` 빈 출력).

→ 순서: (1) envmigrate에 `v0.1.0` 태그를 붙인다 → (2) 두 `go.mod`에서 `replace` 제거 +
`go get github.com/qwreey/envmigrate@v0.1.0` → (3) `router/backend/vendor/` 재생성 →
(4) submodule 2개 제거 + `Dockerfile:39`의 `COPY envmigrate/` 제거.
Docker 빌드는 이미 네트워크를 쓰므로(`ADD https://...`) `go mod download`가 추가로
네트워크를 쓰는 건 새 제약이 아니다.

### `dev/` 폴더 + clone 스크립트: **찬성, 단 `builds/`와 역할을 문서로 갈라둘 것**

이미 `builds/`라는 비슷한 모양의 디렉터리 규약이 있다(`ootb-extra.sh:53`이 사이드
프로젝트를 `$TARGET_DIR/builds/$name`에 clone, `migrate-continue.sh:44-70`이 거기를
순회). 둘은 의도가 다르다:

- `builds/` = **배포**용. `EXTRA_INCLUDE`로 실제 스택에 합류하는 사이드 프로젝트
- `dev/` = **개발**용. 원격 참조로 바뀐 코어 의존물을 로컬 체크아웃으로 갈아끼우는 용도

이름이 헷갈릴 여지가 크므로 `docs/`와 `CLAUDE.md`에 한 문단으로 못박아야 한다.
(참고: `builds/`는 현재 `.gitignore`에 **없다** — `$TARGET_DIR`가 보통 배포 디렉터리라
지금까지 문제가 안 됐을 뿐. `dev/` 추가할 때 `builds/`도 같이 넣는 게 맞다.)

### 핀(pinning) 정책: **이 계획에서 제일 중요한 신규 결정**

submodule이 지금 공짜로 주고 있던 것이 **"정확한 커밋 고정"**이다. 원격 참조로 옮기면
그게 사라지고, 이 레포는 이미 그 함정에 한 번 빠진 적이 있다(af86213, 루트 `CLAUDE.md`
netshare 절 — floating `#main`인데 Docker가 fetch를 캐시해서 rename이 조용히 반영 안 됨).

그래서 원격 전환과 **동시에** 다음을 세트로 넣어야 한다:

- `.env`에 ref 변수를 노출: `ROUTER_REF`, `DIND_REF`, `AUTOINSTALL_REF`,
  `ROUTER_CLIENT_REF`. `example-env`의 기본값은 **태그**(예: `v1.0.0`), `main`은
  주석으로 "개발 시" 안내
- 각 upstream repo에 릴리스 태그를 실제로 붙이는 게 선행 작업 (지금 태그가 없다)
- `docs/`에 "upstream을 바꿨는데 반영이 안 될 때는 `--no-cache`" 문구 유지

핀을 안 붙일 거면 이 전환은 하지 않는 게 낫다. submodule을 지우는 값어치가
"핀을 잃는 것"보다 크지 않다.

## 잃는 것 (정직하게)

- **레포 트리에서 `router/CLAUDE.md`, `code-dind/CLAUDE.md`, `router/docs/*.md`가 사라진다.**
  루트 `CLAUDE.md`가 이 경로들을 대량으로 참조하고 있어서, 이 레포에서 작업하는
  에이전트/사람이 곧바로 참고 문서를 잃는다. → 완화: `dev/` clone 스크립트를 "개발할 땐
  먼저 이거 돌려라"로 문서 최상단에 두고, 루트 `CLAUDE.md`의 경로 참조를
  `dev/router-docker/CLAUDE.md`(로컬) 또는 GitHub URL로 일괄 갱신.
- 오프라인 빌드가 더 어려워진다(이미 부분적으로 그렇긴 함).
- `git clone --recurse-submodules`(`docs/index.md:8`)와
  `git pull --recurse-submodules`(`migrate.sh:39`)의 의미가 달라진다 → 문서/스크립트 수정.

## 실행 순서 (의존 순서대로, 각 단계마다 빌드 확인)

1. **upstream 태그 붙이기** — `envmigrate`, `router-docker`, `dind-authz-docker`,
   `code-server-autoinstall`, `router-docker-client`에 첫 릴리스 태그. (선행 필수)
2. **`code-dind` 전환** — `docker-compose.yml`의 `context:`를
   `${DIND_CONTEXT:-https://github.com/qwreey/dind-authz-docker.git#${DIND_REF}}`로.
   submodule 제거. 가장 안전하므로 여기서 패턴을 확정한다.
3. **`code-server-autoinstall` 전환** — `Dockerfile:102-103`을
   `ARG AUTOINSTALL_SRC` + `ADD $AUTOINSTALL_SRC`로. `.env` → `build.args` 배선.
4. **netshare / dns-local 오버라이드 변수 추가** — `Dockerfile:89,96`,
   `code-dind/Dockerfile:26`에 `ARG` 도입 (실측 1번). 이건 submodule과 무관한
   독립 개선이라 순서상 아무 데나 넣어도 된다.
5. **`envmigrate` 전환** — 위 "순서 (1)~(4)" 그대로. 두 `go.mod` 다.
6. **`router` 전환** — `docker-compose.yml:39`의 `include: path:`를 원격 URL로.
   submodule 제거.
7. **`dev/` + `script/dev-clone.sh`** — 위 6개 repo를 `dev/` 아래 clone,
   `.env`에 넣을 오버라이드 줄을 stdout으로 출력(직접 쓰지 않고 사람이 붙여넣게).
   `.gitignore`에 `/dev/`, `/builds/` 추가.
8. **문서 스윕** — 루트 `CLAUDE.md`(submodule 서술 다수), `docs/index.md:8`,
   `migrate.sh:39`, `example-env`. 이 레포는 문서-구현 불일치를 실제로 겪은 적이
   있으므로(메모리의 docs-vs-impl audit) 마지막에 전용 스윕을 한 번 돌린다.
