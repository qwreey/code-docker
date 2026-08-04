# .env.webmanager 마이그레이션 도구 — 구현 완료

## 구현 완료 (2026-08-03)

아래 설계 그대로 전부 구현. `internal/envmigrate`(라인 분류기 + old 파일
파싱/템플릿 조립, 순수 함수라 유닛 테스트 12개 + 실제 `example-env.webmanager`
대상 스모크 테스트로 검증) + `envmigratecmd.go`(`--env-migrate` CLI, stdin→stdout
+ stderr 노트) + 기동 시 버전 체크 로그(`main.go`) + `internal/envversionprefs`
(dismiss 상태 영속화, `uiprefs`와 동일 패턴으로 별도 패키지 유지) +
`GET/POST /api/system/env-version` + 프론트 `EnvVersionBanner`(마운트 시 1회
fetch, mismatch면 경고 배너 — `ErrorBanner`에 `variant` prop 추가해서 재사용).

`example-env.webmanager` 전체를 `#.` 관례로 치환, 맨 위
`#!important`+`WEBMANAGER_ENV_VERSION=1` 블록 추가. `Dockerfile`에 템플릿
COPY 한 줄(`go:embed` 대신 경로 기반 — 아래 설계 그대로), `docker-compose.yml`에
`WEBMANAGER_ENV_TEMPLATE_PATH` 문서화(조직 커스텀 템플릿 마운트 안내 포함).
문서는 `docs/build-customization.md`(마이그레이션 워크플로우),
`webmanager/backend/README.md`(CLI + 신규 엔드포인트 스펙),
`webmanager/CLAUDE.md`(Ground rules에 버전 올리기/`#.` 관례 항목 추가) 전부 갱신.

아래 "확인 필요"의 두 항목은 계획대로 진행(부활 안 함, `envversionprefs` 별도
패키지 유지) — 별다른 이견 없이 확정.

`go build`/`go vet`/`gofmt`/`go test`(`internal/envmigrate` 전체 통과),
`npm run build`/`npm run lint`, `docker compose config` 전부 클린.
**실컨테이너(`docker compose build && up`) 검증만 아직 안 함** — 특히 기동 시
버전 불일치 로그/웹 UI 배너/dismiss 영속화/이미지 버전 재무장이 실제로 되는지,
`--env-migrate`를 컨테이너 안에서 실제로 돌려 왕복 확인하는 게 남음(아래
"구현 순서"의 8번 항목).

## 배경 / 목표

`example-env.webmanager`(레포 루트)는 전부 주석 처리된 `#KEY=value` 형태로
제공되고, 유저가 `cp example-env.webmanager .env.webmanager` 한 뒤 필요한 줄만
주석 해제해서 쓴다(루트 `CLAUDE.md`의 override 패턴과 결이 같음). 문제는 이
파일에 키가 추가/삭제/개명되면 유저의 기존 `.env.webmanager`가 자동으로 안
따라온다는 것 — 새 키는 존재를 모르고 지나치고, 삭제된 키는 죽은 값으로 남는다.

목표: `webmanager` 바이너리에 `--env-migrate` 서브커맨드를 추가해서, 유저가
자기 `.env.webmanager`를 stdin으로 넣으면 **그 시점 이미지가 아는 최신
`example-env.webmanager` 템플릿**을 기준으로 재구성한 결과를 stdout으로 뱉게
한다. 유저가 실제로 활성화(언코멘트)해둔 값은 보존하고, 유저가 그 값 위에 직접
써둔 코멘트도 보존하고, 새로 생긴 키/사라진 키는 최신 템플릿 기준으로 정리된다.
사용 예:

```sh
cp .env.webmanager .env.webmanager.bak
cat .env.webmanager | docker compose exec -T code-docker \
  /etc/code-docker/webmanager/webmanager --env-migrate > .env.webmanager
```

(`-T` 필수 — tty 없는 파이프 입출력이라 `hashpassword.go`의 `--hash-password`와
같은 이유로 요구됨. 백업은 도구가 하지 않음 — 항상 stdin→stdout만 하는 순수
변환기로 유지하고, 백업은 유저/문서 관례로 둔다. 대부분 키에 코드 상 합리적
기본값이 있어서 마이그레이션 안 해도 대체로 잘 돌아가긴 하지만, 유저가 최신
구조를 확인할 기회는 있어야 하므로 아래 버전 체크로 보완.)

## 파일 문법 규칙 (신규 — 지금은 없음, 이 작업의 일부로 도입)

### 값 줄 판별

공백 없이 `[A-Z][A-Z0-9_]*=`로 시작하는 줄(코멘트 처리됐든 아니든)은 "값 줄"로
본다:

- `KEY=value` — 활성화된 값
- `#KEY=value` — 주석 처리된 값(`#`와 `KEY` 사이 공백 없음이 핵심 — `# KEY=value`처럼
  공백이 있으면 그냥 프로즈 코멘트로 취급, 값 줄 아님)

(유저 지시는 "대문자+언더바만"이었는데 실제로는 앞글자 뒤에 숫자도 허용하는
`[A-Z][A-Z0-9_]*`로 살짝 넓힘 — 지금 존재하는 키 전부와 호환되고 향후 숫자 섞인
키 이름도 커버, 동작 차이 없음.)

### 접두어 5종 — 누가 쓰고 마이그레이션이 어떻게 다루는지

값 줄이 아닌 줄(코멘트/마커)은 접두어로 구분한다. 파싱 시 아래 순서대로
매칭(위에서부터 먼저 매칭되는 걸로 확정):

| 접두어 | 누가 씀 | 의미 | old 파일 파싱 시 취급 | 출력에 남는가 |
|---|---|---|---|---|
| `#~` (뒤에 값줄 모양) | 도구 | 삭제된 키 아카이브 (`#~KEY=value`) | 이전 라운드의 죽은 키 목록으로 읽음 | 아래 "죽은 키 섹션" 참고 |
| `#~` (뒤에 프로즈) | 도구 | 죽은 키에 딸린, 원래 유저가 썼던 코멘트 | 그 죽은 키의 코멘트로 읽음 | 죽은 키 섹션에 그대로 |
| `#!important` (단독 줄, 정확히 이 문자열) | example-env.webmanager 작성자(조직) | 바로 아래 값 줄을 **항상 강제 적용** | old 파일에 있어도 무시(템플릿에만 의미 있는 마커) | 아니오 — 강제 적용된 값 줄만 깔끔하게 남음 |
| `#!` (단독 줄, 정확히 이 문자열) | example-env.webmanager 작성자 | 바로 아래 값 줄을 **권장값 변경 알림 대상**으로 표시 | old 파일에 있어도 무시(마찬가지로 템플릿 전용 마커) | 아니오 — 대신 아래 "충돌 표시" 참고 |
| `#!KEY=...` / `#!<프로즈>` | 도구 (직전 마이그레이션 결과물) | 충돌 표시 블록(참고용 최신값 + 설명) | **버려짐** — 매번 새로 재생성(`#.`와 동일 취급, idempotent) | 다시 계산돼서 남거나 사라짐 |
| `#.` | 도구 | 우리가 쓴 설명/섹션 헤더 | 버려짐, 최신 템플릿 내용으로 교체 | 최신 템플릿 그대로 |
| `#` (위 전부 아님) | 유저 | 유저가 직접 쓴 코멘트 | **보존 대상** | 해당 값 바로 위, `#.` 설명보다 위 |
| (빈 줄) | — | 구조적 경계 | 코멘트 블록 스캔 종료 트리거 | 템플릿 구조 그대로 |

`#!important`/`#!` 마커는 **`example-env.webmanager`(템플릿)에만 등장하는
문법**이고, 유저의 실제 `.env.webmanager`에는 결과물로 안 남는다(강제는
값만 깔끔하게 적용되고, 권장 변경 알림은 도구가 매번 새로 만드는
`#!KEY=.../#!<설명>` 블록으로 바뀐다) — 그래서 위 표에서 "old 파일 파싱 시
취급"이 전부 "무시/버려짐"이다. **이 두 마커는 상호 배타적**이다(한 키에
동시에 못 씀).

이전 계획에 있던 "`#.` 코멘트 블록이 값에 붙는 규칙"(값 줄 바로 위쪽으로
연속된 `#`류 줄을 스캔하다 빈 줄/다른 값 줄에서 멈춘다)은 그대로 유지 —
위 표의 모든 접두어가 이 스캔 대상에 포함된다. 유저가 한 값에 대해 여러
문단짜리 코멘트를 남기고 그 사이에 시각적 여백을 주고 싶다면, 진짜 빈 줄이
아니라 내용 없는 `#` 한 줄을 써야 한다(진짜 빈 줄은 스캔을 끊음). 반대로
**우리가 템플릿에 쓰는 코멘트 중 이런 여백용 줄은 반드시 `#.`여야 한다** —
순수 `#`가 하나라도 섞이면 "유저 코멘트"로 오인되어 마이그레이션 때
엉뚱하게 보존/이동됨.

### 죽은 키 섹션 (`#~`)

템플릿에서 사라진 키는 조용히 버리지 않고 파일 맨 아래 전용 섹션으로
몰아넣는다:

```
#. ------------------------------------------------------------------
#. 아래는 예전 .env.webmanager에는 있었지만 이 버전의 example-env.webmanager
#. 에는 더 이상 없는 키입니다(더 이상 쓰이지 않음). 필요 없으면 통째로
#. 지우세요.
#. ------------------------------------------------------------------
#~ 예전에 유저가 이 키에 남겨둔 코멘트가 있었다면 여기 이렇게 따라옵니다.
#~WEBMANAGER_OLD_REMOVED_KEY=some-value
```

구성 규칙:

- old 파일에서 활성/비활성 상관없이 값이 있었고, 그 키가 최신 템플릿에
  없으면 → `#~KEY=value` 형태로(항상 주석 취급, 두 번 다시 "활성화"되지
  않음) 이 섹션에 추가. 원래 붙어있던 유저 코멘트(순수 `#` 줄)는 `#~`로
  접두어만 바꿔서 같이 옮김.
- old 파일에 이미 `#~KEY=value` 형태로(이전 라운드에서 옮겨진) 있던 죽은
  키는, 이번 템플릿에도 여전히 없으면 그대로 유지(순서 보존), 혹시 이번
  템플릿에 그 키가 다시 생겼다면 → **부활시키지 않고 최신 템플릿의 신규
  기본값으로 취급**(예전에 죽었던 값은 버림 — 애매한 부활 시맨틱을 피하기
  위한 단순화, 아래 "확인 필요" 참고).
- 새로 이번 라운드에 죽은 키마다 stderr에 `WARN` 한 줄(아래 로그 레벨 절
  참고) — 카드리 옮겨진 건 조용히 유지, 반복 경고 안 함.

### 충돌 표시 (`#!`) / 강제 적용 (`#!important`)

**`#!important`** — 조직/기관이 여러 인스턴스에 강제하고 싶은 값에 씀
(커스텀 템플릿에서, 아래 "템플릿 파일 배치" 참고). 마이그레이션은 이 키를
old 파일에 뭐가 있었든 무조건 템플릿의 값으로 **활성화 상태로** 교체한다
(템플릿에서 타겟 줄이 주석 처리돼 있어도 강제 적용 시엔 항상 언코멘트 —
"강제"인데 비활성 상태를 강제할 이유가 없음). 파일에는 흔적을 안 남기고
(마커 자체도, 이전 값도 안 남음) 깔끔한 `KEY=value` 한 줄만 남긴다. stderr에
`INFO` 한 줄만: `env-migrate: INFO: WEBMANAGER_FOO forced to "X" (was "Y") — #!important`.

`WEBMANAGER_ENV_VERSION`은 **이 메커니즘의 첫 실사용 사례**로 취급한다 —
버전 필드만을 위한 별도 특수 케이스 코드를 만들지 않고, 템플릿에 그냥
`#!important`를 붙여서 일반 로직이 자동으로 처리하게 한다:

```
#!important
WEBMANAGER_ENV_VERSION=1
```

("직접 수정하지 마세요, 마이그레이션이 매번 되돌립니다"라는 안내 문구는
`#.`로 그 위에 추가.)

**`#!`(단독)** — "이 키의 권장 기본값이 바뀌었으니 사용자가 이미 커스텀한
값이 있으면 알려는 주되, 강제는 안 함"을 뜻하는 약한 버전. 대상 키가 old
파일에서 **활성 상태**였을 때만 의미가 있다(유저가 안 건드린 키는 그냥
템플릿 최신값이 조용히 적용되는 일반 케이스와 동일하게 처리 — 충돌이랄 게
없음). 유저의 기존 값은 그대로 존중해서 활성 유지하고, 그 바로 위에 참고용
블록을 끼워넣는다:

```
#. (평소의 #. 설명은 그대로 여기)
#! .env.webmanager 버전 2 → 3 마이그레이션 중 이 키의 권장 기본값이
#! 바뀌었습니다. 아래는 새 권장값이고, 지금 값은 그대로 유지됩니다 —
#! 필요하면 직접 바꾸세요.
#!WEBMANAGER_FOO=new-recommended-value
WEBMANAGER_FOO=user-existing-value
```

버전 번호(`old→new`)는 각 파일의 `WEBMANAGER_ENV_VERSION` 값(old는 파싱된
값, 없으면 "알수없음")에서 그대로 뽑아 문구에 채운다. stderr엔 `WARN` 한
줄: `env-migrate: WARN: WEBMANAGER_FOO recommended value changed (kept user value "Y", template now suggests "X")`.

이 블록은 **매 마이그레이션마다 새로 계산**된다(위 접두어 표대로 old 파일에
있던 `#!...` 블록은 파싱 시 전부 버려짐) — 그래서 조직이 다음 릴리즈에서도
계속 `#!`를 붙여두면 유저가 마이그레이션 돌릴 때마다 매번 다시 뜨는 게
의도된 동작(한 번 보고 넘어간 걸 기억해뒀다가 숨기는 기능은 없음 — 이건
"진짜로 바뀌었다"는 사실을 매번 정확히 반영하는 게 우선).

### 로그 레벨 정리

`--env-migrate`가 stderr에 남기는 줄은 세 가지뿐:

- `INFO` — `#!important` 강제 적용(자동으로 처리됨, 유저 조치 불필요)
- `WARN` — `#!` 권장값 변경 충돌(유저가 검토할 만함), 죽은 키가 `#~`
  섹션으로 새로 옮겨짐(유저가 지워도 되는지 판단할 만함)
- (그 외 특이사항 있으면 필요할 때 추가)

레벨드 로깅 프레임워크는 안 씀(이 코드베이스 다른 곳도 plain `log.Printf`) —
그냥 `env-migrate: INFO: ...` / `env-migrate: WARN: ...` 접두어 문자열로 충분.

## 템플릿 파일 배치 — 경로 기반, `go:embed` 안 씀

처음엔 `go:embed`로 바이너리에 템플릿을 구워넣는 걸 고려했는데, **여러
인스턴스를 관리하는 조직이 자체 정책(`#!important` 강제값 등)을 반영한
커스텀 템플릿을 쓰고 싶을 수 있다**는 요구가 있어서 방향을 바꿈 — 바이너리에
고정으로 박아넣지 않고, **경로**로 템플릿을 찾게 한다.

- `Config`에 `EnvTemplatePath string` 추가, env var
  `WEBMANAGER_ENV_TEMPLATE_PATH`(기본값
  `/etc/code-docker/webmanager/example-env.webmanager`).
- Dockerfile: 기존에 바이너리/정적 자산을 굽는 자리에 나란히 한 줄 추가
  (레포 루트가 빌드 컨텍스트라 별도 스테이지 없이 바로 가능):

  ```
  COPY example-env.webmanager /etc/code-docker/webmanager/example-env.webmanager
  ```

- `--env-migrate`/서버 기동 시 버전 체크 둘 다 이 경로를
  `os.ReadFile`으로 읽어서 씀. 읽기 실패 시:
  - `--env-migrate`: stderr에 에러 남기고 exit 1(템플릿 없이 마이그레이션
    자체가 불가능하니 조용히 넘어가면 더 위험).
  - 기동 시 버전 체크: 서버 전체를 죽이지 않고 체크만 건너뛰고 경고 로그
    한 줄(다른 partial-failure degrade 패턴과 동일 — `webmanager/CLAUDE.md`
    Ground rules 참고).
- **조직 커스터마이징 경로**: 이미지 기본 템플릿을 그대로 두고 싶지 않으면
  `WEBMANAGER_ENV_TEMPLATE_PATH`가 가리키는 경로에 볼륨을 하나 더 마운트해서
  자체 `example-env.webmanager`로 덮어쓰면 됨(예: 회사 공통 `#!important`
  강제값들이 담긴 파일). docker-compose.yml 안에 주석으로 안내:

  ```yaml
  # webmanager --env-migrate가 참고하는 템플릿 경로. 여러 인스턴스를 운영하며
  # 조직 공통 정책(#!important 강제값 등)을 반영한 커스텀 템플릿을 쓰고
  # 싶다면, 이 경로에 볼륨을 하나 더 마운트해서 이미지 기본 파일을
  # 덮어쓰세요:
  #   - ./custom-example-env.webmanager:/etc/code-docker/webmanager/example-env.webmanager:ro
  # WEBMANAGER_ENV_TEMPLATE_PATH: /etc/code-docker/webmanager/example-env.webmanager
  ```

  **이 변수는 `.env.webmanager`/`example-env.webmanager` 안에는 안 둔다** —
  `.env.webmanager` 자체가 이 경로가 가리키는 템플릿을 기준으로 재작성되는
  대상이라, 그 안에 "템플릿을 어디서 찾을지"를 적는 건 자기참조적이고
  부트스트래핑 순서상 꼬임(마이그레이션 도구가 자기 자신이 참고할 파일
  위치를, 마이그레이션 대상 파일 안에서 읽어야 하는 셈) — 그래서 다른
  `WEBMANAGER_*` 값들과 달리 docker-compose.yml에서만 관리(`plan.md`에 이미
  기록된 "docker-compose.yml에 모든 WEBMANAGER_* env var를 주석 처리된
  상태로 문서화" 관례와 같은 자리에 추가하면 됨).

이 방식의 부수 효과: `go:embed`를 안 쓰니 로컬 `go build`/`go vet`이 템플릿
파일 유무와 완전히 무관해짐(임베드 대상 파일이 모듈 트리 안에 있어야 한다는
제약 자체가 사라짐) — 심볼릭 링크 같은 우회가 필요 없어서 오히려 더 단순함.

## `--env-migrate` 동작

`main.go`에 `hashPasswordCmd()`와 나란히 분기 추가:

```go
if len(os.Args) > 1 && os.Args[1] == "--env-migrate" {
    os.Exit(envMigrateCmd())
}
```

새 패키지 `internal/envmigrate`에 순수 함수로 로직을 둔다(테스트하기 쉽게,
`main` 패키지엔 stdin 읽기 + `cfg.EnvTemplatePath` 읽기 + stdout/stderr
쓰기만):

```go
type Result struct {
    Output string
    Notes  []Note // {Level: "INFO"|"WARN", Message: string}
}

func Migrate(old, template string) Result
```

### 파싱

old 파일과 템플릿 둘 다 같은 라인 분류기로 파싱(위 "접두어 5종" 표 그대로
적용). 값 줄마다 위쪽으로 "붙은 코멘트 블록"을 스캔(빈 줄/다른 값 줄에서
멈춤), 그 안에서 순수 `#` 줄만 걸러 유저 코멘트로 저장:

```
oldParsed[key] = {active, value, userComments, wasDead bool}
```

`wasDead`는 old 파일에서 이미 `#~KEY=`로 아카이브돼 있던 경우. 같은 key가
old 파일에 두 번 이상 나오면(정상적으론 안 생김) 마지막 등장을 채택하고
`WARN` 한 줄.

템플릿 파싱은 값 줄마다 추가로 `forced bool`(`#!important` 마커) /
`flagged bool`(`#!` 마커)을 함께 기록.

### 조립 (템플릿을 기준 골격으로 순회)

템플릿을 위에서 아래로 그대로 순회 — **키 집합/순서/섹션 구조는 전부
템플릿이 원본**이라 삭제/추가된 키가 자동 반영됨:

1. 코멘트/빈 줄 → 그대로 복사, 단 각 값 줄의 "붙은 코멘트 블록" 시작
   지점에서 `oldParsed[key].userComments`가 있으면 먼저 삽입(→ `#.` 설명
   → 필요하면 `#!` 충돌 블록 → 값 줄 순서).
2. 값 줄:
   - `forced`(`#!important`) → 템플릿 값으로 강제, 활성화. old에 있던
     값과 다르면 `INFO` 로그.
   - `flagged`(`#!`) **그리고** `oldParsed[key].active` → 유저 값 유지 +
     바로 위에 `#!` 충돌 블록 삽입 + `WARN` 로그.
   - `oldParsed[key].active`(위 두 케이스 아니고) → `KEY=<old 값>`으로
     교체(빈 문자열이어도 활성 상태 유지 — 유저가 명시적으로 비워둔 것
     존중).
   - 그 외(old에 없거나 old에서도 비활성) → 템플릿 줄 그대로.
3. 순회 끝나고: `oldParsed`에서 key가 최신 템플릿에 없는 것들(`wasDead`든
   아니든) → 죽은 키 섹션 조립(위 "죽은 키 섹션" 규칙), 새로 죽은 것만
   `WARN` 로그.

### CLI 래퍼 (`envMigrateCmd`)

- `cfg.EnvTemplatePath`를 `os.ReadFile` — 실패 시 stderr 에러 + exit 1.
- stdin 전체 읽어 `old`로.
- `envmigrate.Migrate(old, template)` 호출, `Output`은 stdout, `Notes`는
  stderr에 레벨 접두어 붙여 한 줄씩.
- 파싱 자체가 실패해서 죽는 상황은 만들지 않음(포맷이 이상한 줄은 최대한
  관대하게 "그냥 프로즈 코멘트"로 취급하고 넘어감) — 최악의 경우에도
  템플릿 골격은 항상 나옴.

## 서버 기동 시 버전 체크 + 로그 + 웹 UI 배너

- `Config`에 `EnvVersion string`(env var `WEBMANAGER_ENV_VERSION`) 유지.
- `main()`에서 `loadConfig()` 직후, `cfg.EnvTemplatePath`를 읽어 그 안의
  `WEBMANAGER_ENV_VERSION` 값(=`currentVersion`)을 뽑고 `cfg.EnvVersion`(=
  `fileVersion`)과 비교:
  - 다르거나 `fileVersion`이 비어있음(이 기능 도입 이전 파일/파일 자체 없음)
    → `log.Printf`로 눈에 띄게 경고(예: `main: ⚠️ .env.webmanager 버전이
    최신(%s)과 다릅니다(현재 %q) — README의 env-migrate 안내를
    따르세요`).
  - 템플릿 자체를 못 읽으면 체크를 건너뛰고 별도로 한 줄만 경고(서버는
    정상 기동).
- `Server`가 `currentVersion`/`fileVersion`/`mismatch`를 들고 있다가
  `GET /api/system/env-version`로 노출(읽기 전용, 게이트 없음).
- **dismiss 상태는 브라우저가 아니라 백엔드에 영속화** — `internal/uiprefs`와
  똑같은 패턴(작은 JSON, `/code/.webmanager/` 아래, temp-file+rename atomic
  write, 게이트 없음 — 순수 UI 취향이라 `internal/uiprefs`의 사이드바 순서와
  동급). 새 패키지 `internal/envversionprefs`(혹은 그냥 `uiprefs`에 필드
  하나 추가해도 되지만, `uiprefs`는 지금 `SidebarOrder` 전용으로 하드코딩돼
  있어서 별도 패키지가 더 깔끔— 착수 시 재확인):

  ```go
  type Dismiss struct {
      DismissedVersion string `json:"dismissedVersion"`
  }
  ```

  `GET /api/system/env-version` 응답에 `dismissed bool`도 같이 계산해서
  포함(`DismissedVersion == currentVersion`이면 true) — 프론트가 한 번의
  요청으로 배너 표시 여부를 바로 판단하게. `POST /api/system/env-version/dismiss`
  가 `DismissedVersion = currentVersion`으로 저장.
  이미지가 새 버전으로 올라가서 `currentVersion`이 바뀌면(=재빌드) 예전
  dismiss가 자동으로 무효화되고 배너가 다시 뜸 — 매 이미지 버전마다 최소
  한 번은 확인시키는 게 목적.
- 프론트: 앱 마운트 시 한 번 fetch(주기적 폴링 불필요 — env는 컨테이너
  재생성 전엔 안 바뀜). `mismatch && !dismissed`면 배너 표시 —
  `ErrorBanner`(`src/components/common/ErrorBanner.tsx`) 재사용 여지 있음
  (색상 톤이 에러용이라 경고용 className 분기 정도는 필요해 보임 — 착수 시
  재확인). 메시지에 정확한 마이그레이션 명령어를 그대로 박아 복붙 가능하게.
  닫기 버튼 클릭 시 dismiss 엔드포인트 호출 후 숨김. `App.tsx` 최상단,
  탭 전환과 무관하게 항상 보이는 위치.

## 문서화

- `example-env.webmanager` 전체: 기존 `#` 설명/섹션 헤더를 전부 `#.`로
  기계적 치환(값 줄 `#KEY=`는 제외), 맨 위에 `#!important` +
  `WEBMANAGER_ENV_VERSION=1` 블록 추가, 파일 상단 안내 문단에 "값
  삭제/추가가 있으면 마이그레이션하라"와 정확한 명령어, `#.`/`#`/`#!`/
  `#!important`/`#~` 관례 요약.
- `README.md`: 웹매니저 관련 섹션(또는 새 섹션)에 마이그레이션 워크플로우
  전체(백업 → `--env-migrate` → 검토) + 조직 커스텀 템플릿 마운트하는 법.
- `docker-compose.yml`: `WEBMANAGER_ENV_TEMPLATE_PATH` 주석 항목 추가(위
  "템플릿 파일 배치" 절 예시 그대로).
- `webmanager/CLAUDE.md` Ground rules에 "example-env.webmanager 키/기본값
  변경 시 그 파일 자체의 `WEBMANAGER_ENV_VERSION`을 올릴 것"(별도 Go
  상수가 없어져서, 규율 대상이 파일 한 줄로 단순해짐) 한 줄 추가.
- `webmanager/backend/README.md`: 신규 `GET /api/system/env-version`,
  `POST /api/system/env-version/dismiss` 엔드포인트 스펙 추가.

## 구현 순서 (제안)

1. `Config.EnvTemplatePath` + Dockerfile `COPY` 한 줄 + docker-compose.yml
   주석 항목.
2. `example-env.webmanager` 본문 전체 개정(`#.` 치환 + `#!important` 버전
   블록 + 안내 문단).
3. `internal/envmigrate`(파싱/조립/충돌/강제/죽은키 로직) — 유닛 테스트로
   핵심 시나리오: 값 보존, 유저 코멘트 보존(+ `#.`/`#!`류는 버려짐), 삭제된
   키 `#~` 아카이브(+ 기존 아카이브 유지, 부활 안 함), 추가된 키가 템플릿
   기본값으로 등장, `#!important` 강제 적용(+ INFO 로그), `#!` 충돌 표시(+
   WARN 로그, 유저 값 유지), old가 비어있는 경우(신규 유저) 템플릿 그대로.
4. `main.go`에 `--env-migrate` 분기 + `envMigrateCmd()`.
5. 버전 체크(기동 로그) + `internal/envversionprefs` + `GET/POST
   /api/system/env-version`.
6. 프론트 배너 + dismiss 연동.
7. README/CLAUDE.md/backend README 문서 갱신.
8. `docker compose build && up` 실컨테이너 검증: 구버전 `.env.webmanager`
   시뮬레이션(버전 필드 없는 상태) → 로그 경고/웹 UI 배너 뜨는지, dismiss
   후 재기동해도 안 뜨는지, 이미지 버전 올렸다고 가정하고 다시 뜨는지,
   `--env-migrate` 실제로 컨테이너 안에서 돌려서 왕복 확인(충돌/강제/죽은
   키 케이스 각각 최소 하나씩).

## 확인 필요 (착수 전 사용자 확인이 있으면 좋은 것들 — 안 막힘, 기본값으로 진행 가능)

- **부활 안 하는 정책**: 한 번 `#~`로 죽은 키가 나중에 템플릿에 다시
  생기면 옛 값을 버리고 템플릿 신규 기본값 취급 — 애매한 부활 시맨틱을
  피하려는 단순화. 반대로 "옛 값을 살려서 다시 활성화해줬으면 좋겠다"는
  선호가 있으면 알려주면 반영.
- **`internal/envversionprefs`를 별도 패키지로 뺄지 vs `uiprefs` 확장할지**:
  `uiprefs`가 지금 `SidebarOrder` 전용으로 하드코딩돼 있어서 일단 별도
  패키지로 계획해뒀는데, 착수 시점에 `uiprefs`를 제네릭하게 리팩터링해서
  합치는 것도 고려 가능(코드량 자체는 크지 않아서 급한 결정은 아님).
