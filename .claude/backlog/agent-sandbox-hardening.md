# code-docker 안에서 AI 에이전트를 안전하게 돌리기 위한 보안 노트

작성일: 2026-08-05 (레포 실제 구성 확인 후 작성 — `docker-compose.yml`, `Dockerfile`,
`script/dind-entrypoint.sh`, `docs/tailscale.md`, `docs/security-login.md`,
`example-env` 직접 확인함)

## 전제 (threat model)

이 문서가 상정하는 위협은 "외부 침입자"가 아니라, **code-docker 컨테이너 안에서 실행되는
AI 코딩 에이전트(Claude Code 등)가 프롬프트 인젝션, 버그, 혹은 과도한 자율성으로 인해
의도치 않은/악의적인 명령을 실행하는 경우**다. 에이전트는 컨테이너 안에서 임의 셸 명령을
실행할 수 있는 것이 기본 전제이므로, 목표는 "그 셸 명령이 컨테이너를 벗어나 호스트까지
닿는 경로를 최대한 줄이는 것"(blast radius 최소화)이다. 완전 차단보다 **다층 방어**에
초점을 둔다.

이미 이 레포 자체가 상당히 신경 써서 설계돼 있다 (`code-docker-internal`의
`internal: true`, dind를 내부망에만 바인드하는 `dind-entrypoint.sh`, tailscale 자동
노출 차단용 `private`/`forward` alias 등). 아래는 그 위에서 "에이전트가 컨테이너
안에서 돌아간다"는 조건이 추가됐을 때 더 신경 써야 할 지점과, 레포 밖(호스트/운영 습관)
에서 추가해야 할 조치를 정리한 것.

## 요약 매트릭스

| # | 조치 | 중요도 | 난이도/비용 | 레포에 이미 있음? |
|---|---|---|---|---|
| 1 | dind 소켓 접근을 에이전트 세션에서 기본 차단 | 최우선 (Critical) | 쉬움 | 부분적 (망 분리는 있음, 세션 단위 차단은 없음) |
| 2 | 앞단 forward-auth 상시 유지 + webmanager authgate 이중화 | 최우선 (Critical) | 쉬움 | 있음 (권장 사항으로, 강제는 아님) |
| 3 | 아웃바운드 LAN(사설망) 격리 | 높음 (High) | 보통 | **구현됨** (`.claude/backlog/egress-netgate-plan.md`, `docs/egress-netgate.md` - 레포 내부(순수 docker-compose)로 구현, 호스트 조작 불필요) |
| 4 | 에이전트 전용 git 계정 + fork 워크플로우 | 높음 (High) | 쉬움 | 없음 (운영 습관) |
| 5 | cap_add 최소화 재검토 (`SYS_PTRACE`, `IPC_LOCK`) | 중간 (Medium) | 쉬움 | 이미 켜져 있음, 재검토 필요 |
| 6 | 시크릿 노출 경로 주의 (`code-patch/`, `.git-credentials`, `.env*`) | 중간 (Medium) | 쉬움 | 부분 경고만 있음 |
| 7 | 호스트 Docker Engine/runc/containerd 최신 유지 | 중간 (Medium) | 쉬움~보통 | 해당 없음 (호스트 관리) |
| 8 | 리소스 제한 (`deploy.resources`) 추가 | 낮음 (Low) | 쉬움 | 없음 |
| 9 | 런타임 강화 (gVisor/Kata, userns-remap) | 낮음 (Low) | 어려움 | 없음, dind와 상충 |
| 10| VM 단위 격리 | 최하위 (참고용) | 비쌈 | 해당 없음 |

---

## 1. dind 소켓 접근을 에이전트 세션에서 기본 차단 — 최우선

**왜 최우선인가:** `code-docker-dind`는 `privileged: true` + `DOCKER_TLS_CERTDIR: ""`
(인증/TLS 전혀 없음)로 뜬다. `dind-entrypoint.sh`가 이 소켓을 `code-docker-internal`
네트워크의 자기 IP에만 바인드하도록 잘 막아뒀지만 (`docker-compose.yml`의 주석도 직접
"anyone who can reach it can create privileged containers and effectively gain root
on the host"라고 명시), **`code-docker` 컨테이너 자신은 정확히 그 내부망에 있고
기본 `DOCKER_HOST=tcp://dind:2375`로 이미 연결돼 있다.** 즉 에이전트가 실행하는 셸
명령이 이 컨테이너 안에서 도는 이상, 이 소켓은 기본적으로 항상 손 닿는 거리에 있다.

privileged 컨테이너는 호스트와 같은 커널을 공유하므로, dind 안에서
`docker run --privileged -v /:/host ubuntu chroot /host` 같은 한 줄이면 사실상
호스트 루트 셸을 딴 것과 동일하다. "컨테이너 안의 컨테이너"가 아니라 **한 홉 거친
호스트 루트 획득**으로 취급해야 한다.

**완화책:**
- dind가 당장 필요한 작업(로컬 postgres/redis 띄우기 등)이 아니라면 에이전트 작업
  세션에서는 `docker compose stop code-docker-dind`로 아예 내려두는 걸 기본값으로.
- 에이전트에게 셸을 넘길 때 `DOCKER_HOST`를 unset한 별도 프로필/서브셸을 쓰는 것도
  고려해볼 만함 (완벽한 차단은 아니지만 "실수로" 건드리는 경우는 줄여줌 — 의도적으로
  우회하려는 에이전트를 막지는 못함, defense-in-depth 성격).
- CLAUDE.md/시스템 프롬프트 등 에이전트가 실제로 읽는 문서에 "이 안에서 privileged
  컨테이너 실행 = 호스트 루트"라는 문장을 명시해서, 에이전트 스스로도 이걸 가볍게
  여기지 않도록.
- webmanager의 Docker/dind 관리 탭도 이 소켓을 조작할 수 있는 UI이므로, 아래 2번
  (앞단 인증)이 뚫리면 이 경로도 같이 뚫린다는 점 인지.

---

## 2. 앞단 forward-auth 상시 유지 + webmanager authgate 이중화 — 최우선

`code-config.default.yaml`은 `auth: none`이 기본이고, webmanager도 자체 로그인이
없다 (`docs/security-login.md`에 이미 명시: 리버스 프록시의 forward-auth에 전적으로
의존). 이 앞단이 뚫리거나(설정 실수로 직접 80 포트 노출, Authentik 우회 등) 우회되면:

- webmanager Terminal 탭 = 인증 없는 웹 셸
- File Manager 탭 = 인증 없는 임의 파일 읽기/쓰기
- Docker/dind 탭 = 위 1번과 결합 시 인증 없는 호스트 루트

즉 이 레이어가 뚫리는 순간 "에이전트가 안전한가"는 무의미해진다 — 누구나 에이전트
없이도 같은 걸 할 수 있다.

**완화책 (레포에 이미 있는 것 위주로 확인/강제):**
- `docs/security-login.md`의 forward-auth 예시(Authentik+Caddy/nginx)를 실제로
  적용, 포트 80을 리버스 프록시 없이 직접 인터넷에 노출하지 않기.
- `NGINX_BLOCK_LOOPBACK=true`(기본값), `ALLOWED_HOSTS`/`ALLOWED_EXPORT_HOSTS`
  설정 — 최소한 우발적 노출(스캐너 등)에 대한 보조 방어선.
- `docs/tailscale.md` "보안: tailnet ACL 설정" 절의 예시 그대로 tailnet ACL에
  `tag:code-docker`를 태그해서 `autogroup:admin`만 접근 가능하게 — sshd(22)는
  구조상 이 백스톱 말고는 다른 방어선이 없다고 문서에도 명시돼 있음.
- 웹매니저의 opt-in authgate(`internal/authgate`)를 켜서 Terminal/File Manager를
  이중으로 잠그는 것도 고려 — forward-auth가 우회됐을 때의 두 번째 방어선.

---

## 3. 아웃바운드 LAN(사설망) 격리 — 구현됨

**2026-08-05, `netgate` Phase 1+2 구현으로 해소됨.** 이 항목의 원안(아래 옛 내용 참고)은
"호스트에서 직접 해야 함"이라고 적었지만, 논의 끝에 `network_mode: service:code-docker`
(netns 공유) + 별도 라우터 컨테이너(`code-docker-netgate`) 조합으로 **순수
docker-compose만으로**(호스트 iptables/eBPF 등 손대지 않고) 구현 가능함을 확인하고 실제로
구현/실측 검증까지 완료했다. 전체 설계와 검토했다가 기각한 대안(호스트 방화벽 `DOCKER-USER`
체인 접근 포함)은 `.claude/backlog/egress-netgate-plan.md`, 사용자 문서는
`docs/egress-netgate.md` 참고. 요약:

- code-docker/dind는 `code-docker-external`(인터넷 방향 네트워크)에 더 이상 직접 붙지
  않고, `code-docker-netinit`(및 dind 자신)이 지속적으로 심어주는 라우트를 통해서만
  `code-docker-netgate`를 거쳐 나갈 수 있다 — code-docker 자신은 `NET_ADMIN`이 없어
  이 경로를 스스로 바꿀 수 없다(요구사항 1 충족, "호스트에서 직접"이 아니라 컨테이너
  네임스페이스 공유로 달성).
- `code-docker-netgate`가 RFC1918 등 사설 대역을 차단하고(요구사항 2), squid로
  HTTP(S) 도메인 블록리스트를 적용한다(요구사항 4, best-effort).
- 아래 완화책의 옵션 2(화이트리스트 프록시)는 채택하지 않고 blocklist 방향으로
  통일했다(`egress-netgate-plan.md`의 "결정됨" 참고) — 원하는 사용자는 규칙을 뒤집어
  whitelist처럼 쓸 수 있다.

<details>
<summary>옛 내용 (구현 전 초안 - 참고용, 더 이상 최신 권고 아님)</summary>

`code-docker-external`은 `internal: false`라서, 도커 기본 브리지 동작상 **컨테이너가
호스트가 라우팅 가능한 어디로든(인터넷 + 호스트가 속한 사설 LAN 전부) 아웃바운드로
나갈 수 있다.** 별도 조치가 없으면 에이전트가 `curl http://192.168.0.1/` 같은 명령으로
같은 네트워크 위 NAS, 공유기 관리 페이지, 다른 서버에 접근을 시도할 수 있다는 뜻 —
이건 레포 자체 설계 범위 밖이라 **호스트에서 직접 막아야 하는 부분**.

**완화책 (비용/난이도 낮은 순):**
1. **호스트 방화벽에 `DOCKER-USER` 체인 규칙 추가** — RFC1918 대역(예:
   `192.168.0.0/16`, `10.0.0.0/8`, `172.16.0.0/12`) 중 실제로 필요한 것(라우터 등)만
   예외로 허용하고 나머지는 이 컨테이너의 소스 IP/인터페이스 기준으로 거부. (docker는
   `iptables -I FORWARD`가 아니라 `DOCKER-USER` 체인에 규칙을 넣어야 도커가 재시작할
   때 규칙이 안 날아감 — 이 점이 흔한 실수 포인트.) 난이도 보통, 효과 큼, 비용 없음.
2. **아웃바운드 화이트리스트 프록시** — Squid/tinyproxy 등으로 나가는 트래픽을
   허용된 도메인(github.com, 패키지 레지스트리, anthropic API 등)만 지나가게 강제하고,
   호스트 방화벽으로 프록시 우회 직접 접속은 차단. 설정은 더 들지만 "인터넷 검색/패키지
   설치는 허용, LAN 전체는 차단"이라는 사용자가 원한 그림에 가장 가까움.
3. **별도 VLAN/서브넷으로 물리적 분리** — 가장 근본적이지만 홈랩 규모에서는 라우터/
   스위치 설정까지 손대야 해서 비용이 크다. 여러 신뢰 안 되는 워크로드를 계속 돌릴
   계획이 아니면 우선순위 낮음.

</details>

---

## 4. 에이전트 전용 git 계정 + fork 워크플로우 — 높음, 쉬움

사용자가 이미 언급한 내용과 동일한 방향, 구체화:

- **에이전트가 쓰는 git identity(SSH 키 또는 PAT)는 사용자 본인 계정/키와 분리.**
  webmanager의 Git Config 탭이 관리하는 `~/.git-credentials`는 **평문 저장**이라,
  파일시스템 접근 권한이 있는 무엇이든(에이전트 포함) 읽을 수 있다 — 여기 넣는 토큰은
  반드시 "털려도 괜찮은" 최소 스코프여야 한다.
- **메인 저장소에 direct push 권한을 주지 말 것.** 에이전트 계정은 본인 fork에서만
  작업하고, 메인 레포로는 PR만 올리게. 메인 레포 쪽에 브랜치 보호 규칙(리뷰 필수,
  status check 필수)을 걸어두면 "에이전트가 뭔가 이상한 걸 커밋했다"가 곧바로
  "메인에 반영됐다"로 이어지지 않는다.
- PAT를 쓴다면 fine-grained token으로 해당 fork(또는 명시적으로 허용한 레포 목록)만
  스코프에 넣고, 조직 전체 admin/owner 권한이 있는 토큰은 절대 넣지 않기.
- `authorized_keys`/`known_hosts`도 마찬가지로 에이전트 세션용 키 페어를 따로 두면,
  나중에 그 키만 회전(revoke)해서 정리하기 쉬움.

---

## 5. cap_add 최소화 재검토 — 중간, 쉬움

현재 `docker-compose.yml`에 `cap_add: [SYS_PTRACE, IPC_LOCK]`이 기본으로 켜져 있다
(주석: gdb/btop 디버깅용, IDE의 IPC 성능용).

- `SYS_PTRACE`: 같은 PID 네임스페이스 안의 **다른 프로세스에 ptrace 가능** — 이 자체가
  컨테이너 escape는 아니지만, 컨테이너 안에 여러 프로세스/사용자 컨텍스트가 같이 돈다면
  그 프로세스들의 메모리를 들여다보거나 코드 주입이 가능해진다. gdb/btop을 실제로 쓰지
  않는다면 빼는 걸 고려. 에이전트에게 임의 셸을 준 상태에서는 이 cap이 "다른 프로세스
  공격" 표면을 넓힌다는 점만 인지하고 있으면 됨.
- `IPC_LOCK`: 상대적으로 저위험 (메모리 잠금 관련, 직접적인 escape 벡터로 알려진 사례
  없음).

두 cap 다 "호스트 escape"를 직접 만들지는 않지만, defense-in-depth 관점에서 실제로
안 쓰는 도구라면 굳이 켜둘 이유는 없다.

---

## 6. 시크릿 노출 경로 주의 — 중간, 쉬움

- `docs/security-login.md`에 이미 명시돼 있듯, `/_static/lib/vscode/out/vs/patch/*`
  (즉 `config/code-patch/`로 심어지는 모든 파일)는 **인증 없이 완전 공개**된다.
  에이전트가 여기 뭔가 쓰게 하거나, override 스크립트에 실수로 토큰을 하드코딩하지
  않도록 각별히 주의.
- `.env`, `.env.webmanager`에 실제 API 키/토큰을 넣으면 컨테이너 파일시스템 접근
  권한이 있는 모두가 평문으로 읽을 수 있다 — 이 자체는 일반적인 docker-compose 관행과
  같지만, "에이전트가 파일을 읽고 쓸 수 있다"는 전제가 추가되면 이 값들이 에이전트의
  출력(로그, 커밋 메시지, 대화 내용)에 실수로 노출될 경로가 하나 더 생기는 셈 — 가능하면
  최소 스코프 토큰만, 그리고 주기적 로테이션.

---

## 7. 호스트 Docker Engine/runc/containerd 최신 유지 — 중간, 쉬움~보통

실제 컨테이너 escape로 이어진 과거 CVE들(`runc` CVE-2019-5736, CVE-2024-21626,
cgroups `release_agent` 관련 CVE-2022-0492 등)은 대부분 **privileged 컨테이너 +
구버전 런타임** 조합에서 터졌다. 이 레포의 dind가 정확히 privileged로 뜨는 구조라
이 카테고리 리스크를 그대로 안고 있음.

구체적인 "최소 nn 버전 이상"을 못박기보다는, 실질적으로는 **"최신 유지"가 가장
현실적인 관례**로 보인다 — 특정 버전을 pin하고 그대로 두면 그 사이 나온 fix를 놓치게
되므로, 호스트 Docker Engine 자동 업데이트(또는 최소 월 1회 수동 확인) 루틴을 두는 걸
권장.

---

## 8. 리소스 제한 추가 — 낮음, 쉬움

현재 `docker-compose.yml`은 로그 파일 크기(`max-size`/`max-file`)만 제한하고
CPU/메모리 제한(`deploy.resources.limits`)은 없다. escape와는 별개로, 에이전트가
폭주하는 프로세스를 실행하거나(빌드 루프, fork bomb류) 실수로 리소스를 과다 사용하면
호스트 전체에 영향을 줄 수 있다. `mem_limit`/`cpus` 설정 추가를 고려 — 우선순위는
낮지만 비용도 거의 없음.

---

## 9. 런타임 강화 (gVisor/Kata, userns-remap) — 낮음, 어려움

- **gVisor(`runsc`)/Kata Containers**: 컨테이너 프로세스와 호스트 커널 사이에 추가
  계층을 둬서 커널 syscall 표면을 줄이는 방식. 이론적으로는 강력하지만, **dind
  (Docker-in-Docker) 자체와의 호환성이 까다롭다** — 특히 gVisor는 중첩 컨테이너
  구조에서 제약이 많아 별도 검증 없이 그대로 적용하기 어려움.
- **userns-remap**: 호스트 데몬 레벨에서 컨테이너 root를 호스트의 비특권 UID로
  매핑하는 기능. 다만 **privileged 컨테이너(dind)와는 대체로 상충** — 대부분의
  dind 셋업이 userns-remap과 함께 잘 동작하지 않아서, 켜려면 dind 쪽 구조를 다시
  설계해야 함.

두 옵션 다 이 레포의 "개인용/홈랩" 스코프에 비해 설정 난이도와 유지보수 비용이 크고,
dind라는 핵심 기능과 정면으로 부딪히는 부분이 있어 우선순위를 낮게 뒀다. 정말 신뢰
안 되는 코드(예: 출처를 모르는 서드파티 패키지를 대량으로 돌리는 워크플로우)를 계획
중이라면 그때 재검토할 것.

---

## 10. VM 단위 격리 — 참고용, 비용 큼

code-docker + dind 전체를 별도 경량 VM(Firecracker, QEMU/KVM 등) 안에서 돌리면
호스트 커널 자체를 공유하지 않으므로 이론상 가장 강력한 격리다. 하지만:

- 운영 복잡도(이미지 빌드/배포 파이프라인이 VM 레이어까지 늘어남)와 리소스 오버헤드가
  커지고,
- 이 레포가 이미 "개인 dev 환경 하나"를 전제로 설계돼 있어 VM 오버헤드 대비 얻는
  이득이 크지 않을 가능성이 높다 (1~9번 조치, 특히 1/2/3번을 제대로 하면 실질적
  리스크의 상당 부분은 이미 줄어듦).

정말로 여러 사용자/여러 신뢰도의 워크로드를 한 호스트에서 같이 돌려야 하는 상황이
아니라면, 이 항목은 우선순위 최하위로 미뤄두는 게 합리적이라고 판단.

---

## 11. 에이전트 레벨 조치 (컨테이너 밖 레이어, 참고)

컨테이너/인프라 조치는 아니지만 같은 목적(blast radius 최소화)이라 같이 적어둠:

- Claude Code 자체의 권한 시스템 활용 — `--dangerously-skip-permissions` 사용하지
  않기, bash 샌드박스 옵션 유지, 위험한 도구 호출(파일 삭제, git push, docker
  명령 등)은 자동 승인 대상에서 제외.
- 프롬프트 인젝션 가능성이 있는 외부 콘텐츠(웹페이지, 이슈/PR 코멘트, 서드파티
  MCP 도구 결과 등)를 처리하는 세션에서는 특히 1번(dind)·4번(git push) 관련 도구
  호출에 더 신중할 것 — 인젝션된 지시가 "이 명령을 실행해"로 이어지는 경로가 실제
  공격 표면.
- 감사/보안 관련 산출물(이 문서 포함)을 레포 안에 커밋하거나 에이전트가 읽는 컨텍스트에
  다시 노출시키면, 그 자체가 "여기를 공격하면 된다"는 안내서가 될 수 있음 — 이런 문서는
  레포 밖(개인 노트 등)에 두는 게 안전하다는 점도 그 자체로 하나의 완화책.

---

## 참고: 이미 잘 되어 있는 부분 (레포 내 기존 설계)

audit 목적상 "무엇을 더 해야 하는가"에 집중했지만, 아래는 이미 견고하게 돼 있어서
추가 조치가 필요 없다고 판단한 부분:

- `code-docker-internal`이 `internal: true`로 인터넷 라우트가 없음 — dind 소켓을
  이 망에만 바인드하는 설계(`dind-entrypoint.sh`)와 결합해 외부에서의 직접 접근은
  이미 차단됨.
- tailscaled의 same-port 자동 노출 문제에 대해 `private`/`forward` 전용 alias +
  `NGINX_BLOCK_LOOPBACK`으로 이미 대응돼 있음 (`docs/tailscale.md` 참고).
- `code-docker-forwards`를 `code-docker-internal`과 분리해 `forwards:`/`publish:`
  기능 간 포트 충돌을 막아둔 것도 불필요한 노출 표면을 줄이는 데 기여.
