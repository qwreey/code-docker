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

## 마이그레이션 (env-migrate)

**이미지를 업데이트했는데 `example-env.webmanager`의 키가 추가/삭제됐다면**,
기존 `.env.webmanager`를 최신 구조에 맞게 재구성하는 `--env-migrate` 서브커맨드가
있습니다:

```sh
cp .env.webmanager .env.webmanager.bak
cat .env.webmanager | docker compose exec -T code-docker \
  /etc/code-docker/webmanager/webmanager --env-migrate > .env.webmanager
```

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
> `/api/auth/unlock`으로 풀기 전까진 접근할 수 없는 라우트가 생깁니다(쓰기 작업 재확인
> 기준 10분). [Dev Proxy 인증](dev-proxy.md#인증)은 이제 별개의 도구
> ([tinyauth](router.md#tinyauth), router 컨테이너)가 담당하므로 이 잠금과는 완전히
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
> "인증 요구"는 대신 [tinyauth](router.md#tinyauth)가 담당) — router-manager는
> `ROUTER_MANAGER_AUTH_PASSWORD_HASH`로 켜는 자기 자신만의 별도 비밀번호 게이트를
> 갖고 있습니다([router.md](router.md#router-manager-자체-인증) 참고). 예외로 **Terminal, 파일 탭, Logs, Sessions,
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
