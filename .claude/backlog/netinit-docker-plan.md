# netinit-docker 설계 — 라벨 기반 호스트측 네트워크 에이전트

작성일: 2026-08-25. 계기는 같은 날 발생한 실제 장애(아래 "발단")고, 그 원인 클래스를
구조적으로 제거하면서 `netfilter-fix`의 env 리스트 배선까지 같이 걷어내는 설계.
아직 구현 전, 설계 단계.

## 발단 — 2026-08-25 장애

`roblox-studio`에 인터넷이 안 됐다. 원인은 default route 부재:

```
172.18.0.0/16 dev eth0 ...
172.20.0.0/16 dev eth1 ...     ← default via router 없음
```

라우트를 심는 `studio-netinit` 사이드카가 9시간 전부터 죽어 있었다
(`docker ps`엔 안 보이고 `docker ps -a`에만 `Exited (1)`):

```
joining network namespace of container: No such container: 1b9c0694...
restart=unless-stopped count=38
```

`network_mode: "service:studio"`는 컴포즈가 **대상의 컨테이너 ID로 고정**해서 저장한다.
대상이 *제자리 restart*(ID 유지)면 사이드카가 재시작으로 다시 붙지만, **recreate**(새 ID)
되면 사라진 ID의 netns에 붙으려다 시작 자체가 실패하고, `restart: unless-stopped`가 죽은
ID를 상대로 재시도만 반복하다 포기한다. netinit 자신의 로그가 기대하는
"exiting so restart: unless-stopped rejoins it" 전제가 recreate 케이스에선 성립하지 않는다.

복구는 `docker compose up -d --no-deps studio-netinit` 한 줄이었지만, 문제는 **증상이
조용하다는 것** — 대상 컨테이너는 `Up`이고, 라우터도 code-docker도 정상이라 아무 데도
빨간불이 안 뜬다.

## 기각된 대안과 그 이유

- **대상에 `NET_ADMIN`을 주고 라우트 루프를 안에서 돌린다** — 사이드카를 분리한 이유
  자체를 없앤다. studio 안에서 도는 건 Roblox Studio(HTTPService/플러그인으로 임의
  아웃바운드 가능)와 에이전트다. `NET_ADMIN`이 있으면 스스로 default route를 지우거나
  다른 게이트웨이를 심어 router의 netgate를 우회할 수 있다. "라우팅을 정할 권한"과
  "그 라우팅에 갇혀야 하는 워크로드"의 분리가 이 구조의 전부다.
  (dind는 이미 `privileged: true`라 자기 라우트를 관리해도 잃을 게 없는 반대 케이스이고,
  studio에 끌어올 선례가 아니다.)
- **netns 소유권을 뒤집어 사이드카를 netns 주인으로** — studio는 자주 죽는다. 현 구조는
  제자리 restart 시 ID가 유지돼 그 흔한 케이스를 이미 흡수하고 있다. 뒤집으면 netns 주인이
  죽는 순간 네트워크가 통째로 고아가 되므로, 흔한 실패를 드물지만 치명적인 실패로 바꾸는
  손해다.
- **운용 규칙으로만 덮기**(recreate 시 사이드카도 같이 recreate) — 사람이 규칙을 지켜야만
  성립한다. 이번에도 `depends_on: studio`가 있는데도 고아가 됐다.

## 설계 — netinit / netinit-docker 2종 체제

`netinit`은 **제거하지 않는다.** 두 도구는 대상 환경이 다르다.

| | `netinit` (기존) | `netinit-docker` (신규) |
|---|---|---|
| 위치 | 대상의 netns 안 (사이드카) | 호스트 netns (에이전트/데몬) |
| 대상 엔진 | 엔진 무관 (k8s 사이드카 등) | Docker 엔진 전용 |
| 설정 | env (`ROUTER_HOSTNAME`) | 대상 컨테이너의 **라벨** |
| 배선 | 대상 1개당 사이드카 1개 | 컴포즈 프로젝트당 데몬 1개 |
| 한계 | netns가 생성 시점에 고정 → recreate 시 고아 | 콜드스타트 레이스 (아래) |

`netinit`은 "비 도커 엔진에서의 사용성을 보장하는 이식 가능한 도구"로 남기고, 위 한계를
**문서화만** 한다. `netinit-docker`는 Docker의 하드닝 동작을 필요한 부분만 수리하고
inspect로 자동 처리하는 데몬 — DaemonSet 내지 Ofelia에 가까운 위치.

### 라벨 스키마

Ofelia가 라벨 모드로 하는 것과 같은 역전: 에이전트가 대상 목록을 들고 있는 게 아니라
**대상이 자기 요구를 선언하고 에이전트가 발견**한다.

**게이트웨이는 대상이 아니라 네트워크가 선언한다.** 대상 컨테이너의 라벨은 opt-in 하나뿐:

```yaml
services:
  studio:
    labels:
      netinit.provider: "${PREFIX:-}netinit-docker"

networks:
  code-docker-internal:
    labels:
      netinit.provider:       "${PREFIX:-}netinit-docker"
      netinit.gateway:        "${PREFIX:-}code-docker-router"
      netinit.exempt-forward: "true"
  roblox-studio-vnc:
    labels:
      netinit.provider:       "${PREFIX:-}netinit-docker"
      netinit.exempt-forward: "true"
      # gateway 라벨 없음 → 이 망은 라우트 대상이 아님 (VNC 전용 격리망)
```

대상이 여러 망에 붙어 있어도(studio는 2개) **게이트웨이를 선언한 망이 곧 라우트가 나갈
망**이라 대상 쪽에 `netinit.network`를 따로 쓸 필요가 없다. 한 대상에 대해 게이트웨이를
선언한 망이 둘 이상이면 모호하므로 **아무것도 하지 않고 크게 에러 로그**를 남긴다
(fail-closed).

이 역전이 중요한 이유: 현재 `NETFILTER_FIX_EXTRA_INTERNAL_NETWORKS`는 **code-docker의
`.env`에서** 유지된다. 즉 형제 프로젝트를 하나 붙일 때마다 code-docker 쪽 파일을 고쳐야
하는데, 그건 `EXTRA_INCLUDE`가 없애려던 결합 그 자체다. 라벨로 가면 형제 프로젝트의
오버레이 파일 하나가 자기 요구를 온전히 기술하게 되고, `ootb-extra.sh`가 PREFIX를
그 env에 맞춰 넣어주던 동기화 로직도 사라진다.

#### 검토 의견 / 보완할 점

1. **provider 매칭은 fail-closed** — 라벨이 없는 컨테이너는 "아무나 처리"가 아니라
   **처리하지 않는다**. 안 그러면 PREFIX가 다른 두 배포의 에이전트가 서로의 컨테이너를
   두고 다툰다. 에이전트 자신의 식별자도 env로 열어둔다
   (`NETINIT_DOCKER_PROVIDER_ID`, 기본값 = 자기 컨테이너 이름).
2. **`gateway`는 컨테이너 이름만 받는다 — IP 리터럴은 거부한다.**
   "IP를 그대로 쓰게 해서 router 없는 범용 라우팅 도구로도 열어두자"는 방향은 **명시적으로
   기각**한다. 이 도구의 존재 이유가 "클라이언트가 자기 egress 정책을 스스로 정하지 못하게
   하는 것"인데, 임의 게이트웨이를 받는 순간 그 성질이 사라진다 — 컴포즈 파일 한 줄로
   클라이언트를 LAN 게이트웨이에 물릴 수 있게 되고, 그러면 에이전트가 `192.168.*` 같은
   내부 망에 닿는 경로가 열린다. 받는 값은 **provider가 관리하는 게이트웨이 컨테이너의
   이름**뿐이고, 파싱해서 IP 리터럴이면 거부 + 에러 로그.

   동작: 게이트웨이를 선언한 네트워크에서 그 컨테이너의 IP를 조회 → 대상의 그 네트워크 쪽
   인터페이스를 찾음 → `ip route replace default via <gwip> dev <iface>`.
3. **인터페이스는 이름이 아니라 IP/MAC으로 찾을 것** — Docker는 "네트워크 X = eth0"을
   보장하지 않는다. 실제로 studio는 `eth0`=code-docker-internal(172.18.0.4),
   `eth1`=roblox-studio-vnc(172.20.0.2)인데 이 순서는 recreate마다 유지된다는 보장이 없다.
   `docker inspect`가 주는 네트워크별 IP/MAC과 netns 안의 인터페이스를 매칭해야 한다.
   (지금 netinit/dind가 쓰는 "default route가 없는 인터페이스" 휴리스틱보다 확실히 낫다.)
4. **netfilter 쪽도 같이 라벨화** — DOCKER-USER 예외는 컨테이너가 아니라 *네트워크*에
   걸리는 속성이므로 위 스키마의 `netinit.exempt-forward`가 그 자리를 대신한다. 이러면
   `NETFILTER_FIX_INTERNAL_NETWORK` / `..._EXTRA_INTERNAL_NETWORKS` 두 env가 전부 사라진다.
   같은 역전을 나머지 절반에 적용하는 것이라 같은 변경에 묶는 게 맞다.
5. **라벨 네임스페이스** — 서드파티 라벨의 Docker 관례는 역DNS(`moe.qwreey.netinit.*`)지만,
   손으로 쓰는 컴포즈 파일의 가독성을 생각하면 Ofelia 선례대로 맨 `netinit.*`가 낫다.
   의식적으로 정하고 문서화할 것. (권장: 맨 `netinit.*`)

## 실측으로 확인된 사실 (2026-08-25)

전부 실제로 돌려서 확인함. 스택은 건드리지 않았고 테스트 컨테이너는 정리했다.

1. **호스트 netns 컨테이너에서 대상 netns에 읽기·쓰기 모두 가능.**
   필요한 것은 `CAP_SYS_ADMIN` + `CAP_NET_ADMIN` + `/var/run/docker/netns` 마운트뿐.
   `privileged` / `pid: host` / `SYS_PTRACE` 전부 **불필요**.
   studio의 netns에 TEST-NET-1 라우트를 add/del 해서 확인(원복 완료).
   → **대상 컨테이너는 capability 0개 그대로**. 지키려던 경계가 유지된다.

2. **마운트 전파를 `rslave`로 해야 한다.** `/var/run/docker/netns/<id>`는 각각이 그 자체로
   bind mount라 기본 `rprivate`로는 전파되지 않는다. 에이전트가 뜬 *뒤에* 생긴 컨테이너에서:

   ```
   :ro         → -rw-r--r-- 0 bytes, setns(): can't reassociate to namespace 'net': Invalid argument
   :ro,rslave  → default via 172.17.0.1 dev eth0   ✅
   ```

   놓치면 "기존 컨테이너는 되는데 새로 뜬 건 안 된다"로 오래 헤맨다.

3. **SandboxKey는 제자리 restart마다 바뀐다.**
   `.../netns/930a028520f3` → `.../netns/20f2cdc3c4bc`
   → 매 사이클 재조회가 강제되고, 뒤집으면 **컨테이너 ID/핸들을 생성 시점에 붙잡아 두는
   지점이 아예 없어진다.** 이 설계가 발단의 원인 클래스를 구조적으로 제거하는 근거.

4. **`docker.sock`의 `:ro`는 소켓엔 아무 제약이 아니다.**
   `-v /var/run/docker.sock:/var/run/docker.sock:ro`로 `docker create`가 rc=0으로 성공.
   → `netfilter-fix`는 **이미** host-root 등가다. `SYS_ADMIN` 추가는 신뢰 등급의 천장을
   올리지 않고 blast radius만 넓힌다. 대가는 "그 스크립트를 작고 감사 가능하게 유지할 것"
   하나. (CLAUDE.md의 netfilter-fix 주석에 이 사실을 반영해야 한다 — 현재 주석은
   `:ro` 마운트를 마치 완화 요소인 것처럼 읽히게 쓰여 있다.)

## 설계된 한계

### 1. 콜드스타트 레이스 — 실질적 손해

지금은 사이드카가 대상과 사실상 동시에 뜨지만, 호스트 에이전트는 `start` 이벤트를
**받은 뒤에** 라우트를 심는다. 바깥에서 컨테이너의 시작을 막을 방법은 없다. CLAUDE.md가
dind의 resolv.conf 스냅샷 문제로 이미 기록해 둔 것과 같은 클래스이고, Wine/Studio가 초기에
DNS/HTTP를 치면 창이 열린다.

**대응: 대상 entrypoint에서 default route가 생길 때까지 대기** (권한 증가 0, 읽기 전용).

이건 "있으면 좋은" 완화책이 아니라 **이 설계의 필수 구성요소**다. 클라이언트가 egress
정책이 자리잡기 전에 워크로드를 시작하면, 그 창 동안 에이전트가 `192.168.*` 같은 내부 망에
접근을 시도할 시간이 생긴다 — netgate 전체가 막으려던 것이 바로 그거다. 따라서:

- 대기는 **fail-closed**다. 타임아웃이 지나도 라우트가 없으면 경고 후 계속 진행하는 게
  아니라 **종료**해서 `restart: unless-stopped`가 다시 시도하게 한다.
- **모든 클라이언트에 적용**한다. 지금 code-docker만 하고 있고 studio는 안 하고 있는데,
  그 비대칭이 이번 장애가 9시간 동안 조용했던 이유이기도 하다.

덤으로 이번처럼 사이드카가 조용히 죽어 있는 상황도 같이 없어진다.
code-docker는 이미 정확히 이걸 하고 있다 (`script/entrypoint.sh`):

```sh
if [ "${NETGATE_ENABLED:-true}" != "false" ]; then
    if ! wait_until "netinit's default route" 60 2 sh -c 'ip route show default | grep -q .'; then
        ...
```

roblox-studio-docker에는 이 대기가 **아예 없다** — 같은 패턴을 적용해야 한다. 다만 그
프로젝트는 router 없이 단독으로도(다른 곳에 떼어다) 써야 하므로 **env로 껐다 켤 수 있어야
한다.** 기본값은 단독 실행이 무설정으로 동작하도록 **off**, 오버레이
(`roblox-studio-code-docker.yml`)가 켠다 — 그 파일이 `VNC_BIND_ALIAS`에 이미 쓰고 있는
패턴 그대로다.

이 토글은 위의 "fail-closed" 원칙과 모순되지 않는다. 끄는 경우는 *애초에 강제할 egress
정책이 없는* 단독 배포뿐이고, router와 함께 뜨는 배포에서는 오버레이가 항상 켜기 때문이다.
즉 토글의 의미는 "대기를 건너뛴다"가 아니라 "이 배포에는 기다릴 provider가 없다"이다.
(env 이름은 미결정. code-docker의 `NETGATE_ENABLED`는 router/netgate 고유 이름이라
범용 도구 쪽엔 `NETINIT_WAIT` 류가 맞아 보인다 — 아래 "미결정" 참고.)

### 2. resolv.conf는 못 건드린다

`nsenter`는 netns만 바꾸지 mount ns는 안 바꾼다. 대상의 `/etc/resolv.conf`를 쓰려면
`/proc/<pid>/root/...` 경로가 필요하고, 그건 `pid: host` + `SYS_PTRACE`를 되살린다 —
위 1번에서 피한 바로 그 권한이다. 따라서 **netinit-docker는 라우트 전용**이고
`apply_nameserver`는 기존 인컨테이너 경로에 남긴다 (dind는 어차피 privileged, code-docker는
dns-local 사용). 정말 필요해지면 Docker API의 `PUT /containers/{id}/archive`로 호스트 권한
없이 파일을 밀어 넣는 우회로가 있으나, 현재는 필요 없다.

## 마이그레이션 위험 — 조용히 실패하는 클래스

router-docker-client는 소비 측에서 **floating `#main` 원격 git 컨텍스트**로 들어오고
**Docker가 그 fetch를 캐시한다.** 이 저장소에는 이미 전례가 있다: `CODE_DOCKER_*` →
`NETFILTER_FIX_*` 이름 변경(af86213)이 캐시된 이미지 때문에 소비 측에 도달하지 못했고,
기본값이 정상 동작을 흉내 내는 바람에 **에러 하나 없이** 조용히 틀렸다.

env → 라벨 전환은 정확히 같은 모양의 변경이다. 따라서:

- 최소 한 주기는 **env 경로를 폴백으로 남긴다.**
- 에이전트가 **어느 경로로 설정을 얻었는지 매 부팅 로그로 크게 남긴다.** env 폴백을 탔으면
  경고로.
- 관련 문서/커밋에 `--no-cache` 재빌드 필요를 명시한다.

## 구현 단계

1. **`netinit-docker` 뼈대** — `netfilter-fix/fix.sh`의 reconcile 루프를 그대로 재사용한다
   (이미 `curl --unix-socket` + `jq`로 docker.sock을 폴링하고, ensure/cleanup-stale 구조에
   TERM 트랩 정리까지 갖췄다). 라우트 reconcile을 nft 규칙 reconcile 옆에 추가하는 형태라
   실제 신규 코드량은 작다.
2. **라벨 디스커버리** — `/containers/json?filters={"label":["netinit.provider=<id>"]}`,
   네트워크 쪽은 `/networks?filters=...`.
3. **netns 진입/라우트 적용** — SandboxKey 재조회 → `nsenter --net=` → IP/MAC 매칭으로
   인터페이스 확정 → `ip route replace default`.
4. **컴포즈 배선** — `network_mode: host`, `cap_add: [NET_ADMIN, SYS_ADMIN]`,
   `-v /var/run/docker/netns:/netns:ro,rslave`, docker.sock.
5. **대상측 대기** — roblox-studio-docker `entrypoint.sh`에 env 게이트 대기 추가.
   오버레이에서 켠다.
6. **사이드카 철거** — `studio-netinit` 서비스 제거. 겸사겸사 roblox-studio-docker의
   로컬 `netinit/` 사본(8/14자, 8/19 추출 이전 것)도 정리 대상 — 지금 오버레이는
   원격 git이 아니라 이 스테일 사본을 빌드하고 있다.
7. **문서** — `netinit`의 recreate 한계를 그 도구의 CLAUDE.md에 명시, code-docker
   CLAUDE.md의 netfilter-fix 절/`docker.sock :ro` 서술 갱신, `docs/` 반영.

## 미결정

- 라벨 네임스페이스: 맨 `netinit.*` vs 역DNS `moe.qwreey.netinit.*` (권장: 전자)
- 대기 토글 env 이름. code-docker는 이미 `NETGATE_ENABLED`를 쓰고 있어 그대로 갈지,
  범용 이름(`NETINIT_WAIT` 등)을 새로 두고 code-docker도 옮길지.
- `netfilter-fix`를 `netinit-docker`로 **개명 통합**할지, 별도 도구로 둘지.
  현재 정의된 임무("DOCKER-USER 예외 동기화")를 넘어 "클라이언트 컨테이너 전체의 호스트측
  네트워크 에이전트"가 되므로 이름이 더 이상 내용을 설명하지 못한다. 개명 쪽이 맞아 보이나
  위 "마이그레이션 위험"과 겹쳐서 한 번에 갈지 나눠 갈지는 판단 필요.

---

## 구현 기록 (2026-08-25)

설계 승인 후 같은 날 구현 + 실측 검증 완료. 아직 커밋/푸시 전.

### 미결정 3건의 결론

- **라벨 네임스페이스**: 맨 `netinit.*`로 확정 (Ofelia 선례, 손으로 쓰는 컴포즈 가독성).
- **대기 토글 env 이름**: 새 클라이언트(roblox-studio-docker)는 `NETINIT_WAIT`
  (+`NETINIT_WAIT_TIMEOUT`, 기본 60s). code-docker는 기존 `NETGATE_ENABLED` 게이트를
  그대로 두었다 — 이미 fail-closed로 동작하고 있어서 굳이 건드릴 이유가 없었다.
  (남은 정리: 두 이름이 공존하므로 언젠가 한쪽으로 통일하는 게 낫다.)
  덧붙여, 문서 스윕 중에 `NETGATE_ENABLED=false` 옵트아웃이 netinit-docker에는 아예
  안 먹는다는 **기능 회귀**가 드러났다(사이드카는 이 값을 읽어 idle이 됐었다). 문서로
  덮지 않고 고침 — 도구 자신의 `NETINIT_DOCKER_ENABLED`를 두고, code-docker의 compose가
  `NETGATE_ENABLED`를 거기에 매핑한다(env 이름은 소유자를 따른다는 기존 원칙 그대로).
  꺼지는 건 **라우트 심기 절반뿐**이고 DOCKER-USER 예외는 유지된다 — 그건 netgate 활성
  여부와 무관한 별개 작업이고, 예전 netfilter-fix도 이 값을 읽은 적이 없다. 실측 확인함.
- **개명 통합**: 통합으로 확정. `netfilter-fix/` → `netinit-docker/`,
  `fix.sh` → `netinit-docker.sh`, 컴포즈 서비스 `code-docker-netfilter-fix` →
  `code-docker-netinit-docker`. 마이그레이션 위험은 스크립트 안에 env 폴백 + 경고를
  남기는 것으로 대응.

### 설계 대비 달라진 점

**code-docker도 같이 옮겼다** (원래는 studio만 하고 code-docker는 사이드카에 두려 했음).
이유: 라벨을 적용하려면 `code-docker-internal` 네트워크를 재생성해야 했는데, 그 과정에서
`code-docker-netinit`이 **같은 버그로 그 자리에서 다시 고아가 됐다** — 발단과 똑같이
"only loopback visible"만 반복하며 code-docker의 egress가 죽었다. 알려진 고장 메커니즘을
남겨둘 이유가 없어져서 `code-docker-netinit` 서비스도 제거하고 라벨 opt-in으로 전환했다.

`code-docker-dind`는 **옮기지 않았다.** 이미 privileged라 자기 netns 안에서 라우트를
관리하고, 그 루프는 컨테이너 ID에 고정되지 않아 이 고장 클래스에 애초에 해당하지 않는다.

### 실측 검증 결과

- studio / code-docker 둘 다 default route 정상, egress `204`.
- **핵심 회귀 테스트 통과**: `docker compose up -d --force-recreate studio`
  (= 발단의 사이드카를 고아로 만들던 바로 그 동작) 후, **수동 개입 없이** netinit-docker가
  새 SandboxKey를 재조회해 라우트를 다시 심었고 egress가 즉시 복구됐다.
- entrypoint 대기가 실제로 동작: studio 로그에
  `waiting for the netinit provider to plant a default route...` → `default route present
  (...) - continuing`.
- **인터페이스를 이름이 아니라 IP로 찾는 설계가 바로 값을 했다**: 네트워크 재생성 과정에서
  서브넷이 뒤바뀌어(`code-docker-internal`이 172.18 → 172.20) studio의 egress 인터페이스가
  `eth0`이 아니라 `eth1`이 됐는데, IP 매칭이라 아무 문제 없이 맞췄다. 이름을 가정했다면
  VNC 격리망으로 라우트를 심는 조용한 사고가 났을 자리다.
- rslave 전파도 라이브로 검증됨 — 에이전트가 뜬 뒤에 recreate된 studio에 정상적으로
  setns 성공.

### 구현 중 추가로 잡은 버그 — nft 주석 태그가 인스턴스별로 안 나뉘어 있었음

`netfilter-fix` 시절부터 DOCKER-USER 규칙에 붙이는 주석 태그가 **상수**였다
(`netfilter_fix_internal_forward_fix`). PREFIX 다중 인스턴스는 이 프로젝트가 명시적으로
지원하는 시나리오인데, 그러면 한 호스트의 같은 DOCKER-USER 체인에 에이전트가 둘 붙고,
각자의 종료 정리(`remove_all_own_rules`)와 stale 규칙 청소가 **상대방의 예외까지 지운다.**

실측으로 재현됨: 두 번째 인스턴스를 띄웠다 내리자 실행 중이던 에이전트의 규칙이 0개로
사라졌다(그 에이전트의 다음 reconcile이 2초 뒤 복구하긴 했지만, 그 사이 router의 FORWARD
트래픽이 막히는 창이 생긴다).

수정: 태그에 provider id를 붙인다 —
`netfilter_fix_internal_forward_fix:${PROVIDER_ID}`. 접미사 없는 옛 태그의 규칙은 일부러
건드리지 않는다(옛 netfilter-fix 컨테이너가 자기 SIGTERM에서 스스로 지우므로, 강제 kill된
경우에만 고아가 남는다). 재검증: 다른 provider 인스턴스가 종료돼도 실행 중 에이전트의
규칙 2개가 그대로 유지됨.

폐기 env 폴백 경로(`NETFILTER_FIX_*`)도 이때 같이 실측 확인 — 경고 문구가 정상 출력되고
라벨 경로와 공존한다.

### 마이그레이션 시 주의 (실제로 겪음)

네트워크에 라벨을 추가하면 **Docker 네트워크가 재생성**되고, 그때 *재시작만 되고 재생성되지
않은* 컨테이너는 **네트워크 별칭을 잃는다.** 이번에 `code-docker-router`가 그래서
`code-docker-internal` 위의 `router`/`forward` 별칭을 통째로 잃었고, 그 결과 모든
컨테이너에서 `router` 이름 해석이 실패했다(dind는 자기 `wait_until`에 갇혀 부팅을 못
끝냈다). `docker compose up -d --force-recreate --no-deps code-docker-router`로 해결.
→ 이 변경을 배포할 때는 **router를 명시적으로 recreate**할 것.

### 남은 일

- `router-docker-client`를 push해야 기본 원격 git context가 동작한다. 그 전까지는
  `NETINIT_DOCKER_CONTEXT`로 로컬 체크아웃을 가리켜야 한다.
- push 후 소비 측은 **`--no-cache` 재빌드** 필요 (Docker가 원격 git fetch를 캐시함 —
  CLAUDE.md의 netshare 절에 기록된 전례와 동일한 함정).
- roblox-studio-docker의 로컬 `netinit/` 디렉터리는 이제 아무 데서도 참조되지 않는다.
- dind는 이 고장 클래스에는 해당 없지만, 자기 `wait_until` 루프에 갇히면 조용히 부팅을
  못 끝낸다는 별개의 취약점이 이번에 드러났다 (위 "마이그레이션 시 주의" 참고).
