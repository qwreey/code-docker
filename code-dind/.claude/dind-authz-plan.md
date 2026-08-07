# dind privileged 제한 설계 노트 (code-docker-dind)

## 구현 현황 (2026-08-05)

**구현 완료 및 실제 테스트 인스턴스(`code-docker-dind`)에 배포/검증까지 끝남:**
- `dind-authz/` — Go 표준 라이브러리만으로 작성한 Docker authz 플러그인 (`policy.go`/`main.go`, 유닛테스트 포함, `go test ./...` 통과).
- `Dockerfile`의 `dind-authz-build`/`dind-authz` 스테이지, `config/dind-authz/00-base.default.json` (기본 허용 목록).
- `script/dind-entrypoint.sh` — 플러그인 바이너리 존재 여부를 스스로 감지해 `--authorization-plugin` 플래그를 추가 (plain `dind` 스테이지는 그대로 동작).
- `docker-compose.yml` — `code-docker-dind`에 `/code` 미러 마운트 + `DIND_AUTHZ_VOLUME`(`/etc/dind-authz.d`, code-docker에는 어디에도 마운트 안 함) + `build.target: ${DIND_TARGET:-dind-authz}`.
- `example-env`, `docs/tips/dind.md` 갱신.
- 라이브 검증(실제 `code-docker-dind` 테스트 인스턴스, 사용자가 라이브 서비스 아님을 직접 확인해줌 — `/code/Projects` 비어있음, dind 안 컨테이너/볼륨 0개): privileged 거부, 허용 안 된 CapAdd 거부, seccomp/apparmor 우회 거부, pid/network=host 거부, `/code` 밖 마운트 거부(정책 디렉토리 자기 자신 포함), `/code` 안 마운트는 실제 호스트까지 정상 왕복, named volume/허용된 cap/일반 컨테이너 정상 통과 — 전부 실제 클라이언트(`code-docker` 컨테이너, `DOCKER_HOST=tcp://dind:2375`)에서 확인.

**추가로 구현 완료 (2026-08-05, 같은 날 이어서):**
- `dind-authz-remap` 스테이지 (userns-remap) — 이 기기 호스트는 LXC 등에 중첩돼있지 않아 직접 실험/검증까지 완료. **`DIND_TARGET` 기본값은 여전히 `dind-authz`로 유지** — 계획대로 옵트인, 기본값 아님. 구현 중 발견한 것:
  - `docker:dind` 베이스 이미지가 이미 `dockremap` 유저 + 고정 subuid/subgid 범위(`165536:65536`)를 갖고 있어서, Dockerfile에서 유저/subuid를 새로 만들 필요가 전혀 없었음 — `dind-authz-remap` 스테이지는 `ENV DIND_USERNS_REMAP=dockremap` 한 줄과 entrypoint의 자기 감지 로직 몇 줄이 전부. 예상보다 훨씬 쉬웠음.
  - **실사용 제약을 실제로 재현해서 확인함**: `/code`(및 프로젝트 폴더들)가 보통 `root:root 755`라서, remap된 컨테이너의 root(호스트에서는 UID 165536)는 그 안에 쓰기가 안 됨 — `-v /code/myproject/pgdata:/data`류의 흔한 패턴이 Permission Denied로 실패하는 걸 직접 재현. named volume은 Docker가 소유권을 알아서 관리해서 문제 없음(확인함), bind mount를 꼭 써야 하면 `docker exec code-docker-dind chown -R 165536:165536 <path>`(dind 자신에서 실행 — code-docker에서 하려면 host UID로의 chown 권한이 추가로 필요)로 우회 가능함을 확인. `docs/tips/dind.md`의 "추가 경화" 절에 정리.
  - `docker info`의 `Docker Root Dir: /var/lib/docker/165536.165536`로 remap이 실제 적용됐음을 확인, authz 플러그인과 동시에(`Authorization: dind-authz`) 정상 동작.

**아직 구현 안 됨 (계획만 있음):**
- `Sysctls`/`/proc`·`/sys` 마운트 옵션 세부 검사 (v2 이후로 미룸, 아래 표 참고).
- webmanager의 dind 엔진 버전 업데이트 알림 연계 (아래 "webmanager 버전 관리 기능과의 연계" 절).

---

`agent-sandbox-hardening.md`의 1번 항목("dind 소켓 접근 제한")을 실제로 어떻게
구현할지 파고든 대화 기록. 결론부터:

- **rootless dind는 기본값으로 추천하지 않음** (실사용 문제가 실제로 많이 보고됨)
  → **authz 플러그인을 `code-docker-dind` 커스텀 이미지에 내장**하는 쪽으로 방향
  전환.
- bind mount 소스는 **`/code/` prefix allowlist**로 제한 — DinD의 잘 알려진
  "마운트 소스는 daemon 자신의 파일시스템 기준" 문제도 같이 해결됨.
- userns-remap은 효과는 있지만 LXC 등 중첩 가상화 환경에서 호환성 문제 소지가
  있어 **기본값 아님** — `dind` → `dind-authz` → `dind-authz-remap` Dockerfile
  스테이지 계층화 + `docker-compose.yml`의 `build.target`으로 사용자가 선택하는
  방식으로 opt-in화.

## 왜 "privileged 하나만 막으면 되는" 게 아닌가

`--privileged`는 사실 단일 스위치가 아니라, 켜지는 순간 아래를 한 번에 다 켜주는
**묶음 플래그**다:

1. 모든 리눅스 capability 부여 (`--cap-add=ALL`과 동일)
2. seccomp 프로파일 비활성화 (문자열로는 `SecurityOpt: ["seccomp=unconfined"]`)
3. AppArmor/SELinux 컨파인먼트 비활성화 (`SecurityOpt: ["apparmor=unconfined"]`)
4. 호스트의 모든 디바이스 접근 허용 (`/dev/*`)
5. `/proc`, `/sys`의 기본 마스킹 해제

**"privileged만 막고 CAP만 별도로 제한하면 된다"는 방향 자체는 맞지만, 정확히는
"privileged 하나"가 아니라 "privileged가 한 번에 켜주는 위 5가지 개별 스위치"를
각각 따로 막아야 privileged와 동일한 효과를 우회로 재구성하지 못한다.** 다행히
이 목록은 짧고 안정적이다 (Docker HostConfig 스펙에 새 위험 필드가 자주 추가되는
편은 아님) — "끝없이 설정을 추가해야 하는" 종류의 문제는 아니다.

여기에 dind라는 맥락에서만 추가로 신경 써야 하는 것 두 가지:

6. `HostConfig.Binds`/`Mounts`에 `/var/run/docker.sock` 마운트 — 이걸 허용하면
   생성된 컨테이너가 dind의 소켓에 직접 붙어 "제한 없이 컨테이너를 또 만들 수 있는"
   경로가 열린다 (같은 플러그인이 그 재귀 요청도 검사하긴 하지만, 애초에 dev
   컨테이너가 이걸 요구할 이유가 없으므로 기본 차단이 맞음).
7. `PidMode`/`NetworkMode`/`IpcMode` == `"host"`, `Devices`/`DeviceCgroupRules`
   와일드카드(`"a *:* rwm"`) — privileged 없이도 개별적으로 요청 가능한 강력한
   권한들.

## 실제로 필요한 정책 (전체 목록 — 이게 다임)

의미 있는 v1 정책은 아래 9개 규칙이면 충분하다고 판단. redis/postgres류 개발용
컨테이너는 이 중 어느 것도 정상적으로 필요로 하지 않는다.

| # | 필드 | 거부 조건 |
|---|---|---|
| 1 | `HostConfig.Privileged` | `== true` |
| 2 | `HostConfig.CapAdd` | 명시적 허용 목록(`NET_BIND_SERVICE` 등 소수) 밖의 값 |
| 3 | `HostConfig.SecurityOpt` | `seccomp=unconfined`, `apparmor=unconfined`, `label=disable` 포함 |
| 4 | `HostConfig.PidMode` | `== "host"` |
| 5 | `HostConfig.NetworkMode` | `== "host"` |
| 6 | `HostConfig.IpcMode` | `== "host"` |
| 7 | `HostConfig.Devices` / `DeviceCgroupRules` | 비어있지 않음 (또는 와일드카드) |
| 8 | `HostConfig.Binds`/`Mounts` | **(개정, 아래 "bind mount 소스를 /code로 제한" 절 참고) 소스가 `/code/`로 시작하지 않으면 전부 거부 — denylist가 아니라 allowlist** |
| 9 | `HostConfig.CgroupnsMode` | `== "host"` (cgroup v1 release_agent류 탈출 대비) |

~~10. authz 정책 디렉토리 자기-마운트 차단~~ — 8번을 allowlist로 바꾸면서
자동으로 포함됨 (`/etc/dind-authz.d`는 `/code` 밖이므로 8번 규칙에 이미 걸림).
별도 규칙 불필요.

(참고용, v2 이후 검토: `Sysctls`의 `kernel.*` 계열 차단, `/proc`·`/sys` 마운트
옵션 세부 검사 — 지금 당장 필수는 아니라고 판단해서 뒤로 미룸.)

이 표는 새로 발명한 게 아니라 OPA 공식 문서(`openpolicyagent.org/docs/docker-authorization`)의
예시 정책 패턴(`deny { seccomp_unconfined }`, `deny { privileged }` 식으로 규칙을
쌓는 구조)을 그대로 따른 것 — Kubernetes Pod Security Standards의
"restricted" 프로파일이 checking하는 필드 집합과도 거의 동일한 taxonomy라, 업계에서
이미 수렴된 체크리스트라고 봐도 됨.

## 구현: `code-docker-dind`는 이미 커스텀 빌드이므로 어렵지 않음

`Dockerfile`의 `dind` 스테이지가 이미 `docker:dind`를 베이스로
`script/dind-entrypoint.sh`를 `ENTRYPOINT`로 갈아끼우는 구조라, authz 플러그인을
더 넣는 것도 같은 패턴의 연장선이다. 필요한 추가 작업:

1. **플러그인 바이너리 반입**: `open-policy-agent/opa-docker-authz` (또는 그냥 OPA
   서버 + 얇은 브리지)의 정적 링크 Go 바이너리를 `dind` 스테이지에 `COPY`. 2025년
   4월 릴리즈가 있어 현재도 유지보수됨 확인.
2. **정책 파일**: `config/dind-authz/policy.default.rego` (git 추적) — 위 9개
   규칙, 약 40~60줄. `default allow = false` / `allow { not deny }` 구조.
3. **entrypoint 확장**: `dind-entrypoint.sh`에 15~20줄 추가 —
   - 플러그인 프로세스를 백그라운드로 먼저 띄우고 (unix 소켓)
   - `/etc/docker/plugins/<name>.spec`에 소켓 주소를 써서 dockerd가 찾을 수 있게 하고
   - 소켓 파일이 생길 때까지 짧게 대기한 뒤
   - 기존 `exec dockerd ...`에 `--authorization-plugin=<name>` 추가
   - 프로세스 2개(플러그인 + dockerd)를 다루는 정도라 supervisord까지는 필요
     없고, 지금 스타일(`exec` 기반 셸 스크립트)에 백그라운드 실행 + 소켓 대기
     루프만 얹으면 충분.
4. **첫 부팅 시드**: 아래 conf.d 디렉토리를 시드 — **단, `/code` 아래가 아니라
   `code-docker`에는 아예 마운트되지 않는 전용 볼륨 아래에** (자세한 내용은 바로
   아래 "볼륨 격리" 절 — 여기가 이번 논의에서 가장 중요한 정정 사항).

**정직한 난이도 평가**: "한 줄로 끝나는" 수준은 아니고, 새 기능 하나 추가하는
정도(파일 몇 개, 코드 몇백 줄)의 작업이지만, 필드 목록 자체가 짧고 안정적이라
"끝없이 설정을 늘려야 안전해지는" 구조는 아님. 한 번 구현해두면 유지보수 부담은
낮다고 판단.

## 볼륨 격리 — code-docker는 이 설정에 절대 닿으면 안 됨 (이전 설계의 실수 정정)

**이전 설계안의 결함**: `/code/.dind-authz.d/`를 제안했었는데, `/code`는
`docker-compose.yml`의 `HOME_VOLUME`으로 **정확히 `code-docker`(에이전트가 셸을
쥐고 도는 바로 그 컨테이너)에 마운트되는 경로**다. 즉 그 제안대로 했다면 에이전트가
자기 자신을 규제하는 정책 파일을 자기 손으로 고쳐 쓸 수 있었다 — 방어 대상이
방어 설정의 편집 권한까지 같이 갖는, 본말이 전도된 구조였음.

**정정된 설계**: 정책/데이터 디렉토리는 `code-docker`에는 **어떤 형태로도**
마운트하지 않는다. 대신 `docker-compose.yml`에 `DIND_VOLUME`(`./dind:/var/lib/docker`)과
같은 패턴으로 전용 볼륨을 하나 더 추가해서 **`code-docker-dind` 서비스에만** 붙인다:

```yaml
# docker-compose.yml, code-docker-dind 서비스에만 추가 (code-docker 쪽엔 절대 추가 X)
volumes:
  - "${DIND_VOLUME:-./dind}:/var/lib/docker"
  - "${DIND_AUTHZ_VOLUME:-./dind-authz}:/etc/dind-authz.d"   # 신규
```

이렇게 하면 편집 가능한 사람은 **호스트 자체에 SSH/로그인 권한이 있는 사람**뿐이다
— `code-docker` 컨테이너 안에서 도는 그 무엇도(에이전트, webmanager File Manager,
Terminal 탭 전부 `/code` 기준으로 동작) 이 경로를 볼 수조차 없다.

**단, 볼륨 격리만으로는 부족하다 — API 경로로 한 번 더 우회될 수 있음.** `code-docker`가
파일시스템으로 `./dind-authz`에 못 닿아도, 여전히 `DOCKER_HOST=tcp://dind:2375`를
통해 dind의 Docker API 자체는 호출할 수 있다. 만약 authz 정책이 이 경로 자체를
막지 않는다면, `docker run -v /etc/dind-authz.d:/foo ...` 같은 요청을 dind API로
보내서 — **dind 자신의 파일시스템 안에 있는** 그 정책 디렉토리를 새로 만든
컨테이너 안으로 마운트한 뒤 고쳐 쓸 수 있다. 이게 위 "실제로 필요한 정책" 표의
10번 규칙(`Binds`/`Mounts` 소스가 정책 디렉토리 자신인 경우 거부)이 볼륨 격리와
별개로 반드시 필요한 이유 — **볼륨 격리는 "파일시스템 직접 접근"을 막고, 10번
규칙은 "API를 거친 우회 마운트"를 막는다. 서로 다른 경로를 막는 것이라 둘 다
있어야 함.**

## allow 목록의 정확한 동작 방식 — 확인 질문에 대한 답

사용자 질문: *"`'sys-ptrace-block': true` 같은 값들이 있고, 그 값에 따라 OR로 deny가
쌓이는 구조입니까?"* — **개념은 정확히 맞고, 다만 방향(allow vs block)을 하나
정리하면 됩니다.**

- 규칙(로직)은 git 추적되는 `.rego` 파일 하나로 고정 — "요청된 capability가
  `data.dind_authz.allowed_caps`라는 허용 목록에 없으면 deny"라는 식으로,
  **거부 사유마다 독립된 `deny[...]` 조건**을 갖는다. 어느 하나라도 참이면
  전체 요청이 거부되므로, 말씀하신 대로 **여러 deny 조건이 OR로 쌓이는 구조**가
  맞다.
- 다만 개별 항목을 `sys-ptrace-block: true`(블록 목록, 참이면 차단)로 두는 대신
  `allowed_caps.SYS_PTRACE: true`(허용 목록, 참이어야 통과) 형태로 뒤집는 걸
  권장한다 — 이유는 사용자가 이미 정확히 짚은 마지막 조건과 직결된다:
  **"정의되지 않은 값은 false, 즉 허용 안 한 것으로 취급되어 기본이 deny인
  구조"**. 허용 목록 모델에서는 이게 공짜로 따라온다 — 어떤 값이든 목록에 없으면
  (`data.dind_authz.allowed_caps[cap]`이 undefined) Rego에서 자동으로 false 취급이라
  별도 마이그레이션/기본값 관리 없이도 "새로 추가된 위험한 필드를 깜빡 잊고
  분류 안 해도 기본은 막힌다"가 보장된다. 반대로 블록 목록(`*_block: true`) 모델을
  쓰면, 새 필드가 생겼을 때 그 필드를 블록 목록에 추가하는 걸 깜빡하면 기본값이
  "차단 안 함(허용)"이 되어버려 정확히 원하시는 것과 반대 방향이 된다.
- 정리: **새로운 deny(차단 항목)는 로직 파일 쪽에 사용자가 직접 규칙을 추가하는
  것**이고, **더 allow(예외 허용)는 데이터 파일 조작으로 처리**된다는 이해가
  정확하다. 로직 파일은 "허용 목록에 없으면 막는다"는 틀만 제공하고, 그 허용
  목록 자체를 conf.d 파일들로 채우는 게 이번 설계.

## conf.d 스타일 확장

OPA는 디렉토리 전체를 로드해서 여러 `.rego`/`.json` 파일을 하나의 정책·데이터로
합치는 걸 네이티브로 지원한다. **주의할 점**: Rego의 `deny { ... }` 규칙 자체는
파일이 여러 개여도 전부 OR로 합쳐지고, 다른 파일의 deny 규칙을 나중에 "취소"하는
문법은 없다 — 그래서 위에서 정리한 대로 로직은 "허용 목록 조회형 deny" 하나로
고정해두고, **exec는 오직 데이터 파일(허용 목록)만 conf.d로 쌓는** 구조로 가야
한다:

```rego
# config/dind-authz/policy.default.rego (git 추적, 로직 — 다시는 안 건드림)
deny["disallowed capability"] {
    cap := input.Body.HostConfig.CapAdd[_]
    not data.dind_authz.allowed_caps[cap]
}
deny["mount targets authz config"] {
    b := input.Body.HostConfig.Binds[_]
    startswith(b, "/etc/dind-authz.d")
}
```

```json
// config/dind-authz.d/00-base.default.json (git 추적, 기본 허용 목록)
{ "dind_authz": { "allowed_caps": { "NET_BIND_SERVICE": true } } }
```

```json
// ./dind-authz/10-my-exception.json (호스트에서 직접 작성, code-docker에서는 안 보임)
{ "dind_authz": { "allowed_caps": { "SYS_PTRACE": true } } }
```

OPA는 이 세 파일을 병합해서 `data.dind_authz.allowed_caps`를 하나의 합쳐진
객체로 만들어준다 — 로직은 그대로 두고 데이터 파일만 추가/수정해서 예외를
만드는 게 정확히 conf.d가 하려는 것과 일치.

부가 이점: OPA는 `--watch` 옵션으로 정책/데이터 디렉토리 변경을 감지해 **런타임에
자동 리로드**할 수 있다 — 이 레포의 일반 override 패턴(`.sh` 오버라이드는 이미지
리빌드 필요)보다 오히려 더 가볍다. `./dind-authz/`에 파일을 추가/수정하면 컨테이너
재시작 없이 바로 반영되게 만들 수 있음 — "호스트 접근 가능한 사람이 편집 가능,
컨테이너는 리빌드 불필요"라는 두 요구사항을 동시에 만족.

## bind mount 소스를 `/code`로 제한 — DinD의 실제 알려진 버그와도 맞물리는 제안

**결론: 가능하고, 안전할 뿐 아니라 DinD를 쓸 때 흔히 겪는 실사용 버그를 동시에
고쳐주는 제안입니다.**

핵심 사실 하나를 짚어야 함: **DinD에서 `Binds`/`Mounts`의 소스 경로는 항상
"요청을 처리하는 데몬(dind) 자신의 파일시스템 기준"으로 해석된다** — 요청을
보낸 클라이언트(`code-docker`)의 파일시스템 기준이 아니다. 이건 이 설계 문서
전체가 이미 전제하고 있던 사실이지만, 동시에 **DinD를 쓸 때 사람들이 실제로
자주 걸려 넘어지는 버그이기도 하다** — `docker run -v $(pwd):/app ...`를
`code-docker` 안에서 실행하면, dind는 그 경로를 자기 자신의 파일시스템에서
찾으려 하고, dind에 그 경로가 없으면 그냥 실패하거나(마운트 소스 없음 에러)
엉뚱한 빈 디렉토리가 마운트된다. 지금 구조에서 dind에는 `/code`가 아예
마운트돼 있지 않으므로, **사실 지금도 "프로젝트 폴더를 dev 컨테이너에
마운트하는" 흔한 워크플로우 자체가 제대로 동작하지 않을 가능성이 높다.**

**해결책은 사용자가 제안한 것과 정확히 같다** — 호스트의 같은 `./code`
디렉토리를 `code-docker-dind`에도 `/code`로 한 번 더 마운트한다:

```yaml
# code-docker-dind 서비스에 추가 (code-docker와 동일한 호스트 경로를 가리킴)
volumes:
  - "${DIND_VOLUME:-./dind}:/var/lib/docker"
  - "${DIND_AUTHZ_VOLUME:-./dind-authz}:/etc/dind-authz.d"
  - "${HOME_VOLUME:-./code}:/code"   # 신규 — code-docker와 동일한 호스트 경로
```

이렇게 하면 `code-docker`에서 보이는 `/code/myproject/...`와 dind에서 보이는
`/code/myproject/...`가 **같은 호스트 디렉토리**를 가리키게 되어, 마운트가
실제로 의도대로 동작하게 됨과 동시에:

- authz 정책의 "실제로 필요한 정책" 표 8번을, **막을 경로 목록(denylist)**이
  아니라 **`/code/`로 시작하지 않으면 전부 거부하는 허용 목록(allowlist)**으로
  뒤집을 수 있다:
  ```rego
  deny["bind mount source outside /code"] {
      b := input.Body.HostConfig.Binds[_]
      src := split(b, ":")[0]
      not startswith(src, "/code/")
  }
  ```
  denylist보다 allowlist가 항상 더 안전하다 — denylist는 놓친 경로가 있으면
  뚫리지만, allowlist는 새로 알려지지 않은 위험한 경로라도 `/code/` 밖이면
  자동으로 걸린다.
- **표 10번(정책 디렉토리 자기-마운트 차단)이 사실상 자동으로 따라온다** —
  `./dind-authz`는 `/code` 밖의 별도 경로이므로, 위 allowlist 규칙 하나가 이미
  그 우회도 막아준다. 별도 규칙을 안 써도 되니 정책이 단순해짐.

**이 제한이 실제로 무엇을 보호하는지 명확히 할 필요가 있음**: `/code` 자체는
어차피 `code-docker` 안에서 에이전트가 이미 직접 읽고 쓸 수 있는 영역이라, 이
제한이 "에이전트로부터 `/code`를 보호"하는 건 아니다. 이 제한이 막는 건
**"nested 컨테이너의 bind mount를 곁다리 삼아 `/code` 밖(`/`, `/var/run/docker.sock`,
dind 자신의 `/var/lib/docker`, authz 설정 디렉토리 등)으로 나가는 경로"**다 —
에이전트가 직접 손댈 수 없는 영역으로 우회 진입하는 걸 막는 것.

## userns-remap을 dind의 내부 데몬에만 적용 — rootless와는 다른 메커니즘

**질문 요지**: "code-docker 바깥 UID가 dind 안 컨테이너들의 root가 되게 할 수
있는가? 그러면 UID를 스팸 못 하니 공격 표면이 준다" — 이 방향은 실제로
**Docker의 user namespace remapping (userns-remap)** 기능이 정확히 하는 일이고,
**rootless 모드와는 완전히 다른 메커니즘**이라 실사용 경험에서 겪었던 문제들이
그대로 재현되지는 않는다는 게 확인됨.

**rootless와 무엇이 다른가** (이게 중요한 이유는, 이전에 사용자가 rootless dind로
겪은 "컨테이너가 거의 안 도는" 문제와 이게 같은 카테고리인지 구분해야 하기 때문):

| | rootless 모드 | userns-remap |
|---|---|---|
| 데몬 프로세스 자체 | 비특권 호스트 유저로 실행 | **그대로 root로 실행** |
| 스토리지 드라이버 | 커널 미지원 시 fuse-overlayfs(느림) | **일반 overlay2 그대로 사용** |
| 네트워킹 | slirp4netns(유저스페이스 스택, 오버헤드) | **일반 브리지 네트워킹 그대로** |
| cgroup 리소스 제한 | systemd delegation 필요(까다로움) | **일반 cgroup, 별도 설정 불필요** |
| 바뀌는 것 | 데몬 자체의 권한 | **데몬이 만드는 컨테이너 안 UID 매핑만** |

즉 userns-remap은 "데몬은 그대로 root로, 강력하게 돌지만, 그 데몬이 만드는
컨테이너 안에서 root(UID 0)라고 주장하는 프로세스는 실제 호스트에서는 특정
비특권 UID 대역에 매핑된다"는 것 — 데몬 자체의 스토리지/네트워킹 스택은 전혀
안 바뀌므로, rootless에서 보고된 성능/호환성 문제(fuse-overlayfs, slirp4netns,
cgroup v2 delegation)는 애초에 해당 사항이 없다.

**"code-docker의 UID 정확히 하나로 고정"은 가능하지만 권장하지 않음**: 이론상
`/etc/subuid`에 `dockremap:<code-docker의-UID>:1`처럼 딱 1개짜리 범위를 줄 수는
있다. 하지만 postgres/redis 같은 공식 이미지 다수가 내부적으로 root에서
자기 전용 서비스 계정(예: postgres 이미지의 UID 999)으로 drop-privilege 하는
동작을 하므로, 매핑 가능한 UID가 1개뿐이면 그 전환 자체가 실패해서 이미지가
정상 동작 안 할 가능성이 높음. 대신 **일반적인 65536개짜리 subuid 범위**를
쓰되(예: `dockremap:100000:65536`), **그 범위 자체가 실제 호스트의 특권 UID와
전혀 안 겹치게** 하는 쪽을 권장 — "정확히 code-docker와 같은 UID"는 아니지만,
"nested 컨테이너의 root가 실제 호스트에서는 항상 비특권"이라는 보호 목적은
동일하게 달성됨.

**뜻밖의 보너스 확인함**: Docker는 `--privileged`와 `userns-remap`을 **daemon
레벨에서 상호 배타적으로 강제**한다 — 원격 클라이언트가 `Privileged: true`를
요청하면 (해당 컨테이너가 명시적으로 `--userns=host`로 리맵을 빼지 않는 한)
데몬이 자체적으로 거부한다("Privileged mode is incompatible with user
namespaces"). 우리는 이미 authz 플러그인에서 `Privileged: true`를 거부할
계획이었으므로, **userns-remap을 켜두면 authz 플러그인에 버그/우회가 생겨도
데몬 자체가 독립적으로 한 번 더 막아준다** — 공짜로 얻는 2중 방어선.

**적용 범위 명확히**: 이건 `code-docker-dind` 서비스 자체(dind 컨테이너)의
`privileged: true`에는 영향 없음 — dind 자신은 컨테이너 생성을 위해 여전히
그대로 privileged 유지. userns-remap은 **dind 안에서 도는 내부 dockerd**에만
적용해서, **그 dockerd가 만드는 nested 컨테이너들**의 UID만 리맵한다. 이미
`dind-entrypoint.sh`에서 커스텀 플래그로 dockerd를 실행하고 있으므로,
`--userns-remap=default`(또는 특정 매핑 유저) 플래그 하나 추가 + `dind` 빌드
스테이지에 `/etc/subuid`/`/etc/subgid` 항목 굽는 것 정도로 authz 플러그인과
같은 타이밍에 같이 넣을 수 있는 작업.

### "바깥에서 code-docker랑 정확히 똑같이 유지"는 안 되나? — 되지만, 그러면 의미가 없음

여기서 구조를 좀 더 정확히 짚어야 함 — 세 개의 서로 독립적인 "root" 정체성이
있다:

1. **`code-docker` 자신의 root** — `privileged: true`가 아니므로 일반 컨테이너
   격리(네임스페이스+capability)만 적용되지만, **userns-remap이 안 걸려 있어서
   컨테이너 안 UID 0가 실제 호스트의 진짜 UID 0에 그대로 대응**한다 (도커
   엔진 자체에 별도 remap 설정이 없다는 전제 — 이건 이 레포가 아니라 사용자의
   호스트 도커 데몬 설정 영역이라 여기서 건드릴 수 있는 부분이 아님).
2. **`code-docker-dind`(dind 컨테이너) 자신의 root** — `privileged: true`라서
   강제로 `--userns=host`와 동일하게 동작, 역시 진짜 UID 0.
3. **dind가 만드는 nested 컨테이너(postgres 등)의 root** — 지금 논의 중인
   userns-remap 대상. **이걸 1번(`code-docker`)과 "똑같이" 맞춘다는 건, 결국
   nested 컨테이너의 root도 진짜 UID 0로 만든다는 뜻인데, 그건 지금 상태(remap
   없음)와 정확히 같은 결과라 userns-remap을 켜는 의미 자체가 없어진다.**

즉 "code-docker와 맞춘다"는 방향은 기술적으로 가능은 하지만(그냥 remap을 안
켜면 됨), 그건 **보호를 추가하는 게 아니라 지금 상태를 유지하는 것**과 같다.
userns-remap이 실제로 가치를 내는 지점은 정반대 방향 — **nested 컨테이너의
root를, `code-docker`/dind 어느 쪽의 진짜 identity와도 절대 겹치지 않는,
의미 없는 비특권 UID 대역으로 떨어뜨리는 것**이다. "UID를 스팸 못 하게"라고
표현하신 게 정확히 이거라고 이해했다 — nested 컨테이너가 내부적으로 어떤 UID를
자처하든(0이든, 1000이든, postgres의 999든), 실제 호스트에서는 항상 같은
고정 무의미 대역(예: 100000~165535)에 갇혀서, 진짜 계정(호스트의 `yaeji`,
`code-docker`의 root 등) 중 어느 것과도 절대 충돌/사칭할 수 없다.

### 컨테이너가 내려갔다 올라와도 UID가 바뀌나? — 안 바뀜, 빌드 시점에 고정하면

바뀌지 않는다 — 단, **`/etc/subuid`/`/etc/subgid`를 `dind` 빌드 스테이지에서
고정값으로 직접 구워야** 한다. 주의할 점 하나: `"userns-remap": "default"`로
설정하면 Docker가 `dockremap`이라는 유저를 **자동으로 `useradd`해서** 처음
보는 subuid 범위를 잡아줄 수 있는데, 이 자동 생성은 이미지 빌드 시점의 시스템
상태에 따라 달라질 수 있어 재현성이 떨어진다. 그래서 권장하는 건:

```dockerfile
# dind 빌드 스테이지에 명시적으로 고정값 굽기
RUN echo "dockremap:100000:65536" >> /etc/subuid && \
    echo "dockremap:100000:65536" >> /etc/subgid
```

이렇게 고정값을 Dockerfile에 직접 박아두면, 같은 Dockerfile로 빌드하는 한
**컨테이너를 몇 번을 내렸다 올려도, 이미지를 몇 번을 재빌드해도 항상 같은
매핑**이 나온다 — nested 컨테이너가 내부에서 UID 999로 파일을 만들었다면,
호스트에서는 항상 100999로 보인다, 매번. 유일하게 이게 바뀌는 경우는 나중에
사람이 의도적으로 저 숫자 자체를 Dockerfile에서 바꾸는 경우뿐이고, 그때도
`code-docker`(진짜 root)는 소유권 상관없이 접근 가능하니 (아래 참고) 실사용
문제로 이어지진 않음.

### bind mount를 `/code`로 제한해도 "프로젝트 지우면 dev 볼륨도 같이 지워지는" 흔한 패턴이 되나?

된다 — 오히려 지금(변경 전)보다 더 잘 될 가능성이 높다. 이유:

프로젝트 자체의 `docker-compose.yml`에 흔히 있는 패턴,
```yaml
services:
  db:
    image: postgres
    volumes:
      - ./pgdata:/var/lib/postgresql/data
```
같은 상대경로 마운트는, **`docker compose` CLI 프로세스 자신이(즉 `code-docker`
안 셸에서 실행되는 그 프로세스가) 자기 자신의 작업 디렉토리 기준으로 상대경로를
절대경로로 미리 변환한 뒤, 그 절대경로를 API 요청에 실어 daemon(dind)에 보낸다**
— 이건 Compose Spec에 정의된 표준 동작이라 어떤 daemon을 바라보든 동일하다.
즉 프로젝트가 `/code/myproject/docker-compose.yml`에 있다면, `./pgdata`는
**`code-docker` 쪽에서 이미 `/code/myproject/pgdata`로 계산되어** dind로
전달된다.

`code-docker-dind`에도 정확히 같은 호스트 경로를 가리키는 `/code` 마운트를
추가해뒀으므로(둘 다 같은 `${HOME_VOLUME}` 변수를 참조하게 하면 자동으로
일치함), dind는 그 절대경로를 자기 자신의 `/code/myproject/pgdata`에서 찾아
마운트하는데 — 이게 `code-docker`가 보는 것과 같은 호스트 디렉토리이므로
정상 동작한다. `rm -rf myproject/`로 프로젝트 폴더를 지우면 `pgdata`도
당연히 같이 지워진다 — 이 관계는 애초에 프로젝트 폴더 내부 상대경로 구조에서
나오는 것이라 이번 변경과 무관하게 그대로 유지된다.

오히려 지적할 부분: **지금(dind에 `/code`가 아예 없는 상태)은 이 흔한 패턴이
이미 제대로 동작하지 않고 있을 가능성이 높다** — dind가 `/code/myproject/pgdata`라는
경로를 자기 파일시스템에서 못 찾아 마운트 실패하거나, 존재하지 않는 경로를
그냥 새로 만들어버려서(도커의 기본 동작 — bind mount 소스가 없으면 빈 디렉토리를
자동 생성함) dind 컨테이너 안에 붕 뜬 빈 데이터가 생겼을 것. `/code` 마운트
추가는 보안 조치인 동시에 이 워크플로우 자체를 고쳐주는 조치이기도 함.

`/code` 밖의 절대경로(예: `/tmp/...`)를 명시적으로 쓰는 예외적인 프로젝트가
있다면 그건 이번 allowlist에 걸려서 막히는데, 애초에 이 레포의 "프로젝트는
전부 `/code` 아래에 산다"는 전제와 안 맞는 예외적 사용이라 의도된 차단으로 봄.

## userns-remap은 과연 필요한가 — 정직한 재평가

authz 플러그인(privileged/CAP/mount denylist 아닌 allowlist)과 `/code`-only
bind mount 제한만으로도, **지금까지 구체적으로 나열한 위험 항목들은 이미 다
막혀 있다.** 그렇다면 userns-remap이 실제로 추가하는 가치는 뭔가 — 정직하게
따져보면 두 가지로 좁혀진다:

1. **authz 플러그인 자체가 뚫렸을 때의 서킷 브레이커.** CVE-2026-34040처럼
   authz 플러그인 메커니즘 자체가 우회된 전례가 실제로 있다 — 그 경우에도
   userns-remap이 켜져 있으면 데몬이 `Privileged: true` 요청을 독립적으로
   한 번 더 거부한다. **이건 이미 나온 실제 CVE로 뒷받침되는, 구체적인 근거가
   있는 방어선.**
2. **아직 모르는(미래의) 컨테이너 런타임 버그에 대한 보험.** `--privileged`나
   특정 CapAdd와 무관하게, runc/containerd 자체의 구현 버그로 인한 탈출
   사례가 과거에 있었다(예: CVE-2019-5736 — privileged 아닌 컨테이너에서도
   `docker exec`을 매개로 호스트의 runc 바이너리를 덮어써서 탈출). 이런
   "우리가 필드 단위로 나열해서 막을 수 없는" 범주의 버그가 터졌을 때도,
   탈출한 프로세스가 얻는 identity가 여전히 subuid 대역(비특권)이라면
   피해가 제한된다 — **이건 "지금 아는 구멍을 막는다"가 아니라 "모르는
   구멍이 터져도 상한선을 낮춰둔다"는 성격의 방어.**

반대로, "UID 스팸/사칭 방지"라는 세 번째 근거는 `/code`-only 마운트 제한을
이미 걸어둔 상태에서는 상당 부분 약해진다 — `/code` 밖으로는 애초에 아무것도
마운트가 안 되므로, nested 컨테이너가 어떤 UID를 자처하든 접근 가능한 파일
범위 자체가 이미 `/code` 안으로 좁혀져 있고, 그 안에서는 UID가 뭐든 어차피
`code-docker`(진짜 root)가 다 볼 수 있는 영역이라 추가로 지킬 게 많지 않음.

**결론**: userns-remap은 "지금 뚫려 있는 구체적인 구멍을 막는" 조치라기보다는
"authz 플러그인·마운트 제한이 실패했을 때를 대비한, 비용이 낮은 추가 보험"에
가깝다. 비용이 낮다는 게 확인됐으니(overlay2/네트워킹/cgroup 전부 그대로,
rootless 문제 재현 안 됨) 넣는 걸 권장하긴 하지만, **세 방어선 중 가장
선택적(optional)인 것으로 취급하고, 앞의 두 개(authz 플러그인, `/code`-only
마운트)를 먼저 구현한 뒤 여유가 되면 추가하는 순서를 권장.**

**정정: "비용이 낮다"는 평가에 예외가 있음이 확인됨 — LXC 등 중첩 가상화
환경.** Proxmox의 unprivileged LXC 안에 Docker를 돌리는 흔한 홈랩 구성을
검색으로 확인해보니:

- unprivileged LXC는 **호스트 쪽에서 이미 자체 UID remap을 걸고 있음**
  (컨테이너 UID 0 → Proxmox 호스트의 100000+ 같은 임의 UID). 여기에 dind 내부
  dockerd가 **또 한 번** userns-remap을 얹으면 remap 위에 remap이 쌓이는
  이중 구조가 됨.
- 실제 Proxmox 포럼에 nesting=1/keyctl=1 unprivileged LXC 안에서 Docker를 돌릴
  때 스토리지 드라이버가 VFS로 강제되고(overlay가 ZFS에서 불가, aufs가
  non-init 네임스페이스에서 불가), 이미지 레이어 저장 중 권한 에러가 나는
  사례가 반복 보고됨.
- "unprivileged 컨테이너의 UID/GID 매핑은 항상 복잡하고 에러가 나기 쉽다"는
  게 Proxmox 커뮤니티 자체의 정리된 평가.

즉 이 프로젝트가 "여러 호스트 환경(베어메탈, VM, LXC 등)에 배포되는 범용
개인용 이미지"를 지향하는 이상, userns-remap을 **기본값으로 켜서 배포**하면
바로 이런 중첩 가상화 환경 사용자들에게 원인 파악이 어려운 실패로 나타날 수
있음 — "비용이 낮다"는 평가는 "표준적인 단일 계층 Docker 호스트" 전제에서만
성립하고, 중첩 환경에서는 오히려 rootless 못지않게 골치 아파질 수 있음.
런타임 환경변수로 껐다 켰다 하는 방식(이전에 제안했던 방식)도 완전한 해법은
아니다 — **이미지 안에 remap 관련 코드/설정이 항상 존재**하므로, 끄는 걸
깜빡하거나 기본값을 잘못 이해하면 여전히 같은 문제에 부딪힐 수 있음.

## opt-in을 어떻게 구현할까 — Dockerfile 스테이지 분리 (사용자 제안, 채택)

**제안**: 런타임 env var 토글이 아니라, **Dockerfile 빌드 스테이지 자체를
계층으로 쌓고, `docker-compose.yml`의 `build.target`으로 원하는 단계를
선택**하는 방식.

```dockerfile
# Dockerfile — 기존 dind 스테이지 뒤에 이어서
FROM dind AS dind-authz
# opa-docker-authz 바이너리 + 기본 정책 반입, entrypoint가 authz 플러그인을
# 띄우도록 (아래 "구현" 절의 1~3번 그대로)

FROM dind-authz AS dind-authz-remap
# subuid/subgid 굽고, entrypoint가 --userns-remap을 추가로 넘기도록
```

```yaml
# docker-compose.yml, code-docker-dind 서비스
build:
  context: "${BUILD_CONTEXT:-.}"
  network: host
  target: "${DIND_TARGET:-dind-authz}"   # dind | dind-authz | dind-authz-remap
```

**이게 env var 토글보다 명확히 나은 이유:**

1. **이미 이 레포에 있는 패턴의 자연스러운 확장.** `code-docker-dind`는
   지금도 `docker-compose.yml`에서 `target: dind`로 스테이지를 고르고 있음 —
   `DIND_TARGET` 변수 하나 추가해서 고르는 스테이지를 넓히는 것뿐이라, 완전히
   새로운 개념을 들여오는 게 아님.
2. **진짜 opt-out — "끄면 코드가 안 실행됨"이 아니라 "애초에 이미지에 없음".**
   env var 토글은 코드가 이미지 안에 항상 존재하고 조건문으로 우회하는 구조라
   설정 실수의 여지가 남는다. 스테이지 분리는 `dind-authz`를 고르면 그 이미지
   안에 userns-remap 관련 바이너리/설정이 **물리적으로 존재하지 않음** — LXC
   환경 사용자는 애초에 그 코드를 실행할 방법이 없어서, 설정 실수로 인한
   실패 가능성 자체가 사라짐.
3. **기존 override 관례(리빌드 필요)와 일관됨.** 이 레포는 이미 "설정 바꾸려면
   리빌드"가 표준(`.sh` override 전부 그러함) — 다른 정도를 고르려면 리빌드가
   필요하다는 게 새로운 불편함이 아니라 기존 패턴 그대로.
4. **개별 단계를 독립적으로 빌드/테스트 가능.** `docker build --target=dind-authz`
   식으로 각 단계를 따로 검증할 수 있어 authz 플러그인만 있는 상태와 remap까지
   있는 상태를 분리해서 디버깅하기 쉬움.

**구현 시 실무 팁 하나**: `dind-authz`/`dind-authz-remap` 스테이지마다 별도
entrypoint 스크립트를 3벌 유지하기보다, **entrypoint 하나가 자기 이미지 안에
무엇이 존재하는지 보고 동작을 스스로 판단**하게 하는 걸 권장 — 예를 들어
"opa-docker-authz 바이너리가 있으면 authz 플러그인을 띄우고 `--authorization-plugin`
플래그를 추가", "`/etc/subuid`에 dockremap 항목이 있으면 `--userns-remap` 플래그를
추가" 식으로 스크립트가 자체 감지하게 만들면, Dockerfile의 `COPY` 구성만
스테이지별로 다르게 하고 `dind-entrypoint.sh` 자체는 한 벌만 유지하면 됨.

**기본값 권장**: `DIND_TARGET`의 기본값은 `dind-authz`로 — plain `dind`(보호
없음)도 아니고 `dind-authz-remap`(중첩 가상화 환경에서 문제 소지)도 아닌 중간
단계. authz 플러그인은 비용/호환성 문제가 확인되지 않았고 효과가 확실한
1순위 방어선이니 기본으로 켜두고, remap은 이해하고 선택한 사용자만 켜는
고급 옵션으로.

## UID 불일치로 인한 불편함 — 실제로는 code-docker 쪽엔 거의 안 생김

사용자가 우려한 "컨테이너 안 UID와 dind 컨테이너 UID가 안 맞아서 rm을 못 하는"
상황을 구체적으로 짚어보면:

- `Dockerfile`을 확인해보니 `code-docker`에는 `USER` 지시어가 없고, 오히려
  `chsh root --shell ...` / `/etc/passwd`에서 root의 홈을 `/code`로 바꾸는
  작업까지 하고 있다 — 즉 **`code-docker` 자신은 실제 root(UID 0)로 돈다.**
- root는 파일 소유 UID가 뭐든(userns-remap으로 231072 같은 이상한 UID가 됐든,
  postgres 이미지의 UID 999든) DAC 권한 검사를 그대로 통과해서 읽기/쓰기/삭제가
  가능하다. 즉 **`code-docker` 안에서 도는 에이전트/셸 입장에서는, nested
  컨테이너가 `/code` 아래 남긴 파일을 UID 불일치 때문에 못 지우는 상황이
  거의 발생하지 않는다.**
- 이 불편함이 실제로 발생할 수 있는 지점은 딱 하나 — **컨테이너를 전혀 거치지
  않고 진짜 호스트(도커 엔진이 도는 물리/가상 머신)에 직접 로그인한 사람**이
  `./code/myproject/pgdata` 같은 걸 `ls -la`로 보면 이상한 숫자 UID(예:
  231099)로 보이는, 흔한 userns-remap의 "지저분한 UID 표시" 현상 — 다만 이건
  거의 항상 그 호스트 유저가 `sudo`를 쓸 수 있는 상황이라 실질적으로 막히는
  경우는 드물고, 애초에 이 프로젝트가 상정하는 "개인 홈랩 호스트"에서는 크게
  문제될 시나리오가 아니라고 판단.

정리하면: **UID 불일치 우려는 정당하지만, `code-docker` 자신이 root로 도는
지금 구조에서는 실질적 걸림돌이 되지 않을 가능성이 높다** — userns-remap을
넣어도 좋다고 판단.

## rootless dind — 왜 기본값으로 추천하지 않는지 (실사용 근거 확인함)

사용자의 "실제로 여러 컨테이너가 거의 안 돌아가는 수준" 경험을 검색으로 교차
확인했고, 개별 사례가 아니라 **반복적으로 보고되는 알려진 문제군**이었다:

- **cgroup v2 delegation 필요**: 리소스 제한(`--memory`, `--cpus`) 플래그를 쓰려면
  호스트에 systemd user delegation까지 제대로 설정돼야 하고, 안 돼 있으면 조용히
  무시되거나 에러. 컨테이너 오케스트레이션 환경(이 레포처럼 docker-compose로 얇게
  띄우는 구조)에서 이 delegation을 매번 보장하기가 까다로움.
- **fuse-overlayfs 성능 저하**: 커널이 5.11 미만이거나 unprivileged overlay mount를
  지원 안 하면 FUSE 기반 오버레이로 폴백 — 쓰기 위주 워크로드(빌드, DB 데이터
  디렉토리)에서 체감되는 성능 저하.
- **slirp4netns 네트워킹 오버헤드**: 유저스페이스 TCP/IP 스택을 거치므로 컨텍스트
  스위칭 비용 발생, 컨테이너 100개 기준 메모리도 rootful 대비 약 316MB 더 사용.
- **실제 dind-rootless 이슈들 (GitHub, 여러 독립 리포지토리에서 반복 보고)**:
  - `testcontainers-java` #3582: dind-rootless에서 실행 실패
  - `docker/for-linux` #1390: dind-rootless 안에서 privileged 컨테이너 실행 시 에러
  - `docker-library/docker` #432: 같은 호스트에 dind 인스턴스 여러 개 띄우면 시작이
    행(hang)
  - `docker-library/docker` #414: non-root UID로 dind-rootless 실행 시
    `ip_tables` 모듈 없음, `/lib/modules` 접근 문제로 실패
  - CI 환경(testcontainers)에서 "OCI runtime create failed: sysfs 마운트 permission
    denied" — **빌드/테스트가 깨지는 정확히 그 종류의 문제**, 사용자가 언급한
    경험과 일치.

이 정도로 반복되는 이슈면, "이론적으로 더 안전하다"는 이유만으로 기본값으로
밀어붙이기엔 실사용성 리스크가 크다고 판단. **결론: rootless dind는 이 레포의
기본값 후보에서 제외**하고, 위 authz 플러그인 접근을 1순위로 채택.

## webmanager 버전 관리 기능과의 연계

CVE-2026-34040(1MB 바디로 authz 플러그인 우회, Engine 29.3.1에서 패치)이 보여주듯
authz 플러그인 방어선은 **엔진이 항상 최신 패치 상태여야 한다는 전제**에 기대고
있다. 마침 webmanager가 버전 관리 기능을 준비 중이고 Docker/dind 관리 탭이 이미
있으므로:

- dind 이미지/엔진 버전을 최신 upstream 태그와 비교해서 "업데이트 필요" 배너를
  webmanager Docker 탭에 노출.
- 기존 tailscale 로그인 배너가 쓰는 `cd-dialog.js`(`window.CDDialog`, 재사용
  가능한 배너/토스트 모듈)를 그대로 재사용하면, code-server 화면에도 같은 방식으로
  "dind 엔진 업데이트 필요" 알림을 띄울 수 있음 — 별도 UI 컴포넌트를 새로 만들
  필요 없이 기존 패턴 재사용.
- 이렇게 하면 "엔진을 항상 최신으로 유지해야 한다"는 요구사항이 "사용자가 기억해야
  하는 것"에서 "웹매니저가 계속 알려주는 것"으로 바뀌어, authz 플러그인 방어선의
  가장 약한 전제(패치 지연)를 실질적으로 보완함.

## 최종 방향 정리

1. **rootless dind는 채택하지 않음** — 실사용 이슈가 반복적으로 보고되는 카테고리.
2. **authz 플러그인(OPA + opa-docker-authz)을 `code-docker-dind` 이미지에 내장** —
   위 9개 필드 체크리스트, 데이터 기반(allowlist) 설계로 conf.d 확장 가능.
3. **`./dind-authz/`(신규 전용 볼륨, `code-docker-dind`에만 마운트 — `code-docker`
   에는 어떤 경로로도 노출 안 됨)에 사용자 예외 규칙을 conf.d 방식으로 얹을 수
   있게** — OPA `--watch`로 리빌드 없이 즉시 반영. 정책 로직 자체가 정책 디렉토리
   자신을 마운트 소스로 쓰는 요청도 거부하므로, API를 거친 우회 마운트도 막힘.
4. **webmanager 버전 관리 기능으로 dind 엔진 업데이트를 지속적으로 알림** — authz
   플러그인 자체의 신뢰도(엔진 버전 의존성)를 보완.
5. dind 컨테이너 자체는 여전히 `privileged: true` 유지 (컨테이너 생성이라는
   본연의 기능을 위해 필요) — 대신 그 안에서 **클라이언트가 만드는 컨테이너**가
   같은 권한을 요구하지 못하게 막는 것이 이번 설계의 목표.
6. **bind mount 소스를 `/code/` prefix로만 허용(allowlist)** — `./code`를
   `code-docker-dind`에도 동일하게 마운트해서 DinD의 "마운트 소스는 dind 자신의
   파일시스템 기준" 문제를 같이 해결하면서, `/` 등 민감 경로 마운트를 원천 차단.
7. **userns-remap을 dind의 내부 dockerd(nested 컨테이너를 만드는 쪽)에 적용** —
   rootless와 다른 메커니즘이라 성능/호환성 부담이 훨씬 적고, 부수 효과로
   `--privileged` 요청을 데몬 레벨에서 한 번 더 독립적으로 거부하게 됨. 다만
   1·6번(authz 플러그인, `/code`-only 마운트)이 이미 구체적 위험을 다 막고
   있어서 이건 "알려진 구멍"이 아니라 "미지의 위험에 대한 보험" 성격이고,
   LXC 등 중첩 가상화 환경에서 호환성 문제가 생길 수 있어 **기본값으로 켜지
   않음.**
8. **`dind` → `dind-authz` → `dind-authz-remap`으로 Dockerfile 빌드 스테이지를
   계층화하고, `docker-compose.yml`의 `build.target`(`${DIND_TARGET:-dind-authz}`)
   으로 사용자가 선택** — env var 런타임 토글이 아니라 빌드 시점 이미지 선택이라,
   remap을 원치 않는 사용자의 이미지에는 관련 코드/설정이 물리적으로 존재하지
   않음(설정 실수의 여지 자체가 없음). 기본값은 `dind-authz`(authz 플러그인
   O, remap X) — 효과 확실하고 호환성 문제 없는 것만 기본으로.

이 설계는 아직 실제 코드로 구현되지 않았음 — 위는 설계 방향 합의 수준이고,
`config/dind-authz/`, `dind-entrypoint.sh` 수정, Dockerfile `dind` 스테이지 수정은
별도 구현 작업으로 남아있음.

## 현재 상태 / 다음 단계

지금은 **설계만 진행** — 코드 구현은 시작하지 않음. 사용자가 준비되면(git 상태가
clean인 시점) 다른 에이전트를 중단시키고 이 설계를 실제 구현으로 넘기겠다고
알려주기로 함. 그 전까지는 이 문서와 `agent-sandbox-hardening.md`만 계속
다듬는 단계.

구현 시작 시 체크할 것(잊지 않기 위해 미리 적어둠):
- `docker-compose.yml`에 `DIND_AUTHZ_VOLUME`을 **`code-docker-dind` 서비스에만**
  추가하고, `code-docker` 서비스의 `volumes:`에는 절대 추가하지 않았는지 diff로
  재확인.
- 정책 로직(`policy.default.rego`)이 "허용 목록 조회형 deny"로만 구성돼 있고
  하드코딩된 deny가 섞여 있지 않은지 (섞이면 conf.d로 나중에 못 풂).
- "실제로 필요한 정책" 표 8번이 denylist가 아니라 `/code/` prefix
  allowlist로 구현됐는지 (denylist면 `/etc/dind-authz.d` 같은 경로를 놓칠 수 있음).
- `code-docker-dind`에 `HOME_VOLUME`(`./code`)이 `/code`로 같이 마운트됐는지,
  그리고 `code-docker` 쪽 마운트와 정확히 같은 호스트 경로를 가리키는지.
- `dind`/`dind-authz`/`dind-authz-remap` 세 스테이지가 각각 `docker build
  --target=<name>`으로 독립적으로 빌드/기동 확인이 되는지.
- `docker-compose.yml`의 `DIND_TARGET` 기본값이 `dind-authz`인지(remap 아님).
- dind 내부 dockerd에 `--userns-remap`이 적용됐는지(`dind-authz-remap`
  스테이지에서만), `/etc/subuid`/`/etc/subgid`가 **`"userns-remap": "default"`의
  자동 생성이 아니라** build 스테이지에 고정값으로 구워졌는지(재현성), 매핑
  범위가 실제 호스트 특권 UID와 안 겹치는지. 구현 순서상 이건 authz
  플러그인·`/code`-only 마운트 이후, 가장 마지막.
