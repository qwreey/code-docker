# webmanager 설정 (환경 변수 / 비밀번호)

webmanager가 읽는 런타임 환경변수(`.env.webmanager`)를 이미지 업데이트 후 최신
구조로 재구성하는 방법과, webmanager 자체 비밀번호 게이트를 켜는 방법을 다룹니다.

## 환경 변수

webmanager 바이너리가 읽는 환경변수 전체 목록과 설명은 저장소 루트의
`example-env.webmanager`에 정리되어 있습니다. 이 파일을 `.env.webmanager`로
복사하면 `docker-compose.yml`이 자동으로 읽어들입니다(더 자세한 내부 동작은
`webmanager/backend/README.md` 참고).

```sh
cp example-env.webmanager .env.webmanager
```

값을 바꾼 뒤에는 `docker compose up -d`로 컨테이너를 재생성해야 반영됩니다
(`restart`로는 환경변수 변경이 적용되지 않습니다). 이 파일이 아예 없어도
정상 동작합니다 - 전부 합리적인 기본값이 있습니다.

## PWA 바로가기 (`WEBMANAGER_MANIFEST_SHORTCUT_*`)

설치된 code-server PWA의 아이콘을 우클릭(데스크톱)하거나 길게 누르면(안드로이드) 나오는
메뉴에 항목을 추가합니다. "관리 패널 열기"는 webmanager가 기본으로 넣는 항목이고, 그
목록에 붙습니다.

```sh
WEBMANAGER_MANIFEST_SHORTCUT_TRILIUM="Trilium|https://note.example.com/|프로젝트 노트 열기"
#                                ^^^^^^^  이름   |주소                  |설명(선택)
```

키 이름의 `WEBMANAGER_MANIFEST_SHORTCUT_` 뒷부분이 그대로 **아이디**가 됩니다(소문자로
바뀌고 `_`는 `-`가 됩니다). 항목마다 키를 따로 두는 이유는, 이 값을 보통 붙인 사이드
프로젝트의 compose 오버레이가 `code-docker` 서비스의 `environment:`에 직접 선언하기
때문입니다 — 하나의 목록을 여럿이 나눠 쓰면 두 프로젝트를 동시에 붙일 수 없습니다.

### 다른 도메인을 가리킬 때: `/goto/<아이디>`

W3C 매니페스트 스펙상 바로가기의 `url`은 그 매니페스트의 scope 안이어야 하고, **밖이면
브라우저가 그 항목을 조용히 버립니다** — 콘솔 에러도, DevTools 매니페스트 화면에 흔적도
없이 그냥 없는 항목이 됩니다.

그래서 주소가 다른 origin을 가리키는 절대 URL이면, 매니페스트에는 같은 origin의
`/goto/<아이디>`가 실리고 그 경로가 실제 주소로 302 리다이렉트합니다. 주소가 `/`로
시작하는 같은 origin 경로면 그대로 실립니다.

`/goto/`는 오픈 리다이렉트가 아닙니다 — 목적지는 이 컨테이너의 환경변수에서만 나오고,
목적지를 쿼리 파라미터로 받는 경로는 없습니다. `http`/`https`가 아닌 스킴은 거부합니다.

### 확인

```sh
curl -s https://<code-server 주소>/manifest.json | jq .shortcuts
```

- 값 형식이 틀렸거나 스킴이 이상하면 그 항목만 건너뛰고 **이유가 webmanager 로그에
  남습니다**(매니페스트 자체는 정상 반환 — 매니페스트가 깨지면 PWA 설치가 통째로
  죽습니다). 값을 비워두면 그 항목만 꺼지고, 그 사실도 로그에 남습니다.
- 브라우저는 보통 앞의 4개까지만 그립니다(Chrome/Edge). 더 넣어도 오류는 아니고 표시만
  잘립니다.
- **이미 설치된 PWA에 반영되는 데 시간이 걸립니다.** Chrome은 매니페스트 재확인을 24시간
  스로틀하고 앱 창을 전부 닫아야 교체하며, 안드로이드는 WebAPK를 다시 발급받아야 해서
  충전 중 + Wi-Fi 조건까지 붙습니다. 바로 안 보인다고 설정이 틀린 게 아닙니다 —
  위 `curl`로 매니페스트부터 확인하세요.

## 마이그레이션 (env-migrate)

**이미지를 업데이트했는데 `example-env.webmanager`의 키가 추가/삭제됐다면**,
기존 `.env.webmanager`를 최신 구조에 맞게 재구성하는 `--env-migrate` 서브커맨드가
있습니다:

```sh
cat .env.webmanager | tee -a .env.webmanager.bak | docker compose exec -T code-docker \
  /etc/code-docker/webmanager/webmanager --env-migrate > .env.webmanager
```

(`tee -a`로 백업 파일에 매번 이어붙이는 이유: 두 줄로 나누면 백업을 깜빡하기 쉽고, 이렇게
합쳐두면 실행할 때마다 과거 내용이 `.env.webmanager.bak`에 계속 누적되어 남습니다.)

활성화(주석 해제)해둔 값과 직접 남긴 코멘트는 보존되고, 더 이상 안 쓰이는 키는
지우지 않고 파일 맨 아래 "더 이상 쓰이지 않는 키" 섹션으로 옮겨집니다. `#.`로
시작하는 코멘트는 code-docker가 관리하는 설명이라 매번 갈아끼워지고, 순수 `#`로
시작하는 코멘트만 여러분이 남긴 것으로 취급되어 보존됩니다 — `.env.webmanager`에
직접 메모를 남기고 싶다면 `#.`가 아니라 `#`만 쓰세요. 값을 안 바꿔도 대부분 그냥
잘 동작하긴 합니다(전부 합리적인 기본값이 있음)만, 새로 생긴 설정을 놓치지 않으려면
가끔 확인하는 걸 권장합니다 — `.env.webmanager`의 버전이 이미지가 기대하는 버전과
다르면 컨테이너 로그와 webmanager 웹 UI 양쪽에 알림이 뜹니다.

### 조직 커스텀 템플릿

여러 인스턴스를 운영하며 조직 공통 정책(특정 키를 항상 특정 값으로 강제)을
반영한 커스텀 템플릿을 쓰고 싶다면, `WEBMANAGER_ENV_TEMPLATE_PATH`가 가리키는
경로(기본 `/etc/code-docker/webmanager/example-env.webmanager`)에 볼륨을 하나
마운트해서 이미지 기본 템플릿을 덮어쓰세요(`docker-compose.yml` 참고).

## 비밀번호 게이트

> **주의: webmanager는 자체 비밀번호 게이트를 지원합니다(선택 사항, 기본은 꺼짐).**
> `WEBMANAGER_AUTH_PASSWORD_HASH` 환경변수에 argon2id로 해시한 비밀번호를 설정하면
> `/api/auth/unlock`으로 풀기 전까진 접근할 수 없는 라우트가 생깁니다. 잠금은 **마지막
> 요청 기준 10분**(쓰기 작업 재확인 기준)이며, 게이트를 통과하는 요청마다 다시 밀립니다 —
> 즉 계속 쓰는 동안엔 안 풀리고, 손을 뗀 뒤 10분이 지나야 잠깁니다. 다만 탭을 열어만 둬도
> 무한정 열려 있지는 않도록, 비밀번호를 입력한 시점부터 **12시간**이 지나면 활동과 무관하게
> 다시 잠깁니다. [Dev Proxy 인증](../router/docs/dev-proxy.md#인증)은 이제 별개의 도구
> ([tinyauth](../router/docs/router.md#tinyauth), router 컨테이너)가 담당하므로 이 잠금과는 완전히
> 무관합니다 — 예전엔 같은 토큰을 공유했지만, Dev Proxy가 router로 옮겨가면서 분리됐습니다.
> **해시는 컨테이너가 이미 떠 있는 상태에서 아래 명령으로 직접
> 생성합니다**(비밀번호를 두 번 입력받아 오타를 확인하고, 화면엔 안 보이며, 결과로
> `$argon2id$...`로 시작하는 해시 한 줄만 출력됨 — 이 값을 그대로 `.env.webmanager`
> 파일([환경 변수](#환경-변수) 참고,
> 없으면 저장소 루트의 `example-env.webmanager`를 복사해서 만드세요)의
> `WEBMANAGER_AUTH_PASSWORD_HASH`에 붙여넣고 `docker compose up -d`로
> 다시 올리면 적용됩니다, `restart`로는 새 환경변수가 안 먹습니다). **반드시 작은따옴표로
> 감싸서 붙여넣으세요** (`WEBMANAGER_AUTH_PASSWORD_HASH='$argon2id$...'`) —
> docker compose가 `env_file`도 `$변수` 형태로 해석하므로, 따옴표 없이 붙이면 해시 안의
> `$` 뒤 조각들이 (없는 변수로 취급되어) 조용히 빈 문자열로 사라져 해시가 깨집니다:
>
> ```
> WEBMANAGER_AUTH_PASSWORD_HASH='$argon2id$v=19$m=65536,t=3,p=2$salt...$hash...'
> ```
>
> ```sh
> docker compose exec code-docker /etc/code-docker/webmanager/webmanager --hash-password
> ```
>
> 원칙은 **조회(읽기)는 그대로 열어두고, 변경(쓰기)만 게이트** —
> Supervisor의 start/stop/restart, Git Config의 모든 추가·수정·삭제(전역
> gitignore 편집 포함), SSH Keys 추가·삭제, Projects 탭 상세 시트의 git worktree
> 삭제 등이 여기 해당합니다. Dev Proxy/Tailscale은 이제 router 컨테이너의
> 자체 API(router-manager)를 호출하므로 이 게이트 대상이 아닙니다(개별 라우트의
> "인증 요구"는 대신 [tinyauth](../router/docs/router.md#tinyauth)가 담당) — router-manager는
> `ROUTER_MANAGER_AUTH_PASSWORD_HASH`로 켜는 자기 자신만의 별도 비밀번호 게이트를
> 갖고 있습니다([router.md](../router/docs/router.md#router-manager-자체-인증) 참고). 예외로 **Terminal, 파일 탭, Logs, Sessions,
> Supervisor의 프로그램별 로그 조회, Claude Code 탭의 대화 세션 로그 서브탭(Projects
> 탭 상세 시트에서 프로젝트별로 필터링해 재사용하는 곳 포함)은
> 조회까지 통째로 게이트**됩니다(각각 root 쉘/임의 파일 접근/로그 속 시크릿
> 노출/세션 내용 노출 위험 때문 — 단, 같은 상세 시트의 git worktree 목록 조회와
> Claude Code 메모리 뷰어는 정제된 데이터라 조회는 게이트되지 않습니다). 값은 반드시 환경변수로만 주입해야 하며(설정
> 파일에 저장하면 컨테이너 안에서 프로세스를 재시작해 우회할 수 있어 일부러 지원하지
> 않습니다), `/etc/environment`에도 같은 이름의 변수가 있으면 조작 가능성으로 보고
> 게이트가 무시됩니다. 설정하지 않으면 이 게이트는 기본적으로 열려 있으므로(다른
> 탭과 동일하게 리버스 프록시 인증에만 의존), 컨테이너 밖에 노출한다면 반드시 설정을
> 권장합니다 — 특히 Terminal(브라우저에서 곧바로 root 쉘)과 파일 탭(임의 파일시스템
> read/write/delete)은 webmanager 안에서 가장 강한 권한을 가진 기능입니다.

자세한 기능/탭 설명은 [webmanager.md](webmanager.md)를, 리버스 프록시 앞단
인증(SSO 등)은 [security-login.md](security-login.md)를 확인하세요.
