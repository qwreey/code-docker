# router가 DNS 리졸버 역할까지 맡는 구상

작성일: 2026-08-06 — netgate→router 마이그레이션(`functional-router-plan.md`) 완료 후,
실제 사용 검증 중 발견한 문제를 계기로 정리.

## 상태 (2026-08-06 기준)

- **1부(DNS 포워딩 자체) — 구현 완료, 커밋됨** (`feat(router): router runs DNS
  forwarding for code-docker/dind`, 커밋 `00bba1a`). 아래 "결정된 방향"/"풀어야 할
  문제"/"부팅 순서" 절은 이미 구현되고 실제 컨테이너로 검증까지 끝난 내용 — 새 세션이
  다시 만들 필요 없음, 그대로 동작함.
- **2부(squid 제거 + DNS 레벨 블록리스트로 교체) — 구현 완료, 실제 컨테이너로 검증까지
  끝남 (미커밋).** 아래 "파일별 변경 체크리스트"의 삭제/수정 전부 적용됨, "검증 절차"의
  1~6번 전부 통과 확인:
  - `docker compose build code-docker-router` 성공.
  - `supervisorctl status`에 `squid` 없음, `dns`/`netgate-firewall` 등 나머지 전부
    RUNNING.
  - `iptables -t nat -L NETGATE-PREROUTING -n`에 3129/3130 REDIRECT 없음 (80 DNAT만
    남음).
  - code-docker 안에서 `getent ahostsv4 doubleclick.net`(StevenBlack/hosts 도메인)이
    `0.0.0.0`으로 떨어짐(차단 확인). `getent hosts`(AAAA 포함)는 실제 IPv6 주소를
    반환하지만 - dnsmasq의 `addn-hosts`가 A 레코드만 막고 AAAA는 그대로 포워딩하기
    때문 - 이 레포의 `code-docker-internal`/`code-docker-external` 네트워크는
    `EnableIPv6: false`라 IPv6 라우트 자체가 없음(`curl`로 실측: "Network is
    unreachable") - 실질적 우회는 안 됨, 알려진 한계로만 기록.
  - `docker pull hello-world`가 code-docker 안에서 정상 성공 - 이번 작업의 핵심 검증
    지점(원래 버그였던 `registry-1.docker.io` 계열 CDN 도메인 pull 실패)이 실제로
    해결됨.
  - `github.com` 등 블록되지 않은 일반 도메인은 정상 resolve/접속 (회귀 없음).
  - 문서 갱신 완료: `router/CLAUDE.md`, `router/plan.md`, `docs/router.md`,
    `docs/egress-netgate.md`, `docs/index.md`, 루트 `CLAUDE.md`, `docker-compose.yml`
    주석.
  - 남은 판단 포인트 중 "`internal_iface` 죽은 코드 제거"는 실제로 REDIRECT 두 줄이
    유일한 사용처였음을 확인 후 `firewall.default.sh`에서 함께 제거함. blocklist
    override 파일명은 `*.hosts`로 결정(`blocklist.override.hosts`). `openssl`은
    squid ssl-bump 인증서 생성 외 다른 용도가 없었음을 확인 후 pacman 목록에서 제거함.

## 문제 (1부 — DNS 포워딩)

`code-docker-internal`은 `internal: true` 네트워크입니다. Docker의 내장 DNS
리졸버(컨테이너 안 `127.0.0.11`)는 **internal 네트워크에서는 외부로 쿼리를 전달하지
않습니다** — 이건 netgate/router의 라우팅 강제와 무관한, Docker 자체의 설계입니다
(internal 네트워크는 애초에 나갈 길이 없어야 하니 DNS 포워딩도 막아둔 것으로 보임).

실측: `code-docker`/`code-docker-dind`뿐 아니라 `internal: true` 네트워크에 붙은
아무 컨테이너나(`docker run --rm --network <internal-net> alpine getent hosts
example.com`) 전부 동일하게 실패함을 확인했습니다 — 이 세션의 테스트 샌드박스
특이사항이 아니라 일반적인 Docker 동작이고, 실사용 환경에서도 그대로 재현됩니다.

결과: code-docker/dind 안에서 호스트명 기반 작업(`git clone`, `npm install`, `curl
도메인` 등)이 **전부 실패**합니다. netgate/router의 iptables 라우팅(IP 레이어)은
정상 동작하지만, DNS 해석 자체가 별도 메커니즘이라 그 라우팅과 무관하게 막혀 있는
상태입니다.

## 결정된 방향 — router가 DNS 포워더를 직접 운영

사용자 판단: router가 code-docker의 네트워크 경계를 이미 전담하고 있으니, DNS
리졸빙(+캐싱)도 "실물 라우터가 흔히 하는 일"로 자연스럽게 같이 맡는다. 즉:

- router에 작은 DNS 포워더(dnsmasq — 캐싱 기본 지원, 가볍고 이 레포의 다른 도구들과
  같은 pacman 패키지로 설치 가능)를 추가 supervisord 프로그램으로 띄운다.
- code-docker/dind는 `127.0.0.11`(막힌 내장 리졸버) 대신 router를 자신의 DNS
  서버로 쓰도록 `/etc/resolv.conf`를 바꾼다.
- router 자신은 이미 `code-docker-external`에 붙어 있어 **자기 자신의 내장 DNS
  (`127.0.0.11`)는 정상 동작**합니다(internal 네트워크가 아니므로) — 즉 dnsmasq의
  upstream을 따로 하드코딩할 필요 없이, router 컨테이너 자신의 기존 `/etc/resolv.conf`
  (Docker가 호스트 설정을 반영해 이미 채워준 것)를 그대로 forward 대상으로 쓰면 됩니다.
  router가 "진짜 공개 DNS 서버가 어디인지"를 몰라도 되는 구조 — code-docker가 지금까지
  egress 자체를 몰라도 됐던 것과 같은 설계 원칙.

## 풀어야 할 문제: code-docker가 router의 IP를 어떻게 아는가

docker-compose의 `dns:` 필드는 **정적 IP만** 받습니다(hostname 불가 — resolv.conf
포맷 자체가 그럼, DNS 서버 주소를 DNS로 찾을 수는 없으니 당연함). router의 컨테이너 IP는
Docker가 동적으로 할당하므로, `dns: [172.x.x.x]`처럼 고정해둘 수 없습니다(재생성 시
바뀔 수 있음).

이 레포에 이미 있는 정확히 같은 문제의 기존 해법을 재사용합니다 —
`netinit/script/netinit-entrypoint.sh`/`code-dind/script/dind-entrypoint.sh`가 라우트를 위해 하는 것과
동일한 패턴(`getent hosts router`로 IP를 매 루프 다시 알아내 재적용):

- code-docker/dind 양쪽에 작은 반복 스크립트를 추가 — `getent hosts router`로 IP를
  알아내 `/etc/resolv.conf`에 `nameserver <IP>`를 써넣고, 일정 주기로 재확인(router가
  재생성되어 IP가 바뀌는 경우 대응). **NET_ADMIN 불필요** — 라우팅 테이블이 아니라 그냥
  파일 하나 쓰는 것이므로 code-docker 자신의 권한만으로 충분합니다(netinit이 필요했던
  이유와 다름 — 이건 되레 실행 권한 문제가 아니라 "정적 설정에 동적 값을 못 넣는다"는
  운영상 문제).
- code-docker에서는 새 supervisord 프로그램으로(예: `dns-resolver` 또는
  `resolv-writer`), dind에서는 `dind-entrypoint.sh`의 기존 라우트 재적용 루프 옆에 같이
  백그라운드 루프로 추가.

## 부팅 순서 고려

- `script/entrypoint.sh`는 이미 `user-init.sh`의 qwreey-fish curl 등 네트워크 관련
  작업 전에 기본 라우트가 심어질 때까지 대기하는 게이트가 있음(`ip route show default`
  폴링). DNS도 마찬가지로, resolv.conf가 router를 가리키도록 갱신되기 *전에* 무언가
  호스트명으로 curl을 시도하면 실패합니다 — 이 게이트를 "라우트 존재" 뿐 아니라
  "resolv.conf가 이미 router를 가리키는지"까지 확인하도록 넓힐지, 아니면 별도로 얼마나
  기다릴지 결정 필요.
- router 자신의 dnsmasq가 아직 안 떠 있는 상태에서 code-docker가 이미 resolv.conf를
  router IP로 갱신해버리면, 그 사이 윈도우 동안 DNS가 일시적으로 실패합니다(재시도하면
  해결 — glibc/musl 리졸버는 실패 시 즉시 재시도하는 게 일반적이므로 큰 문제는 아닐 걸로
  예상하지만, 실제 검증 필요).

## 확인 필요 (구현 전)

1. dnsmasq가 이 레포의 pacman 기반 Arch 이미지에 있는지, 설정 최소 형태(포워딩만,
   자체 도메인 서빙 없음) 확인.
2. router 자신의 `/etc/resolv.conf`(Docker가 채워준 것)를 dnsmasq가 upstream으로
   그대로 참조하는 방법(`resolv-file=/etc/resolv.conf` 옵션 등) 검증 — 이 값이 router
   컨테이너 생성 시점에 고정되어(Docker embedded DNS의 static 특성과 동일 문제) 호스트
   DNS가 바뀌면 재생성 전까지 갱신 안 될 수 있음, 감안 가능한 수준인지 판단.
3. router의 INPUT 체인은 `firewall.default.sh`가 건드리지 않아 기본 ACCEPT임을 이미
   확인(2026-08-06) — code-docker-internal에서 오는 UDP/TCP 53 쿼리가 막힐 걱정 없음.
4. code-docker/dind의 resolv.conf 갱신 스크립트를 새 supervisord 프로그램으로 둘지,
   기존 entrypoint 흐름에 인라인으로 둘지 — netinit 패턴(별도 지속 루프)이 재생성/IP
   변경에 더 강건하므로 이쪽을 기본으로 고려.
5. `NETGATE_ENABLED=false`(egress 자체를 끈 상태)일 때 이 DNS 리졸빙도 같이 꺼야
   하는지 — 아마 그래야 함(router 자체가 idle이면 DNS 포워더도 응답 안 하므로 자동으로
   맞물림, 별도 처리 불필요할 가능성 큼).

## 2부 — squid 제거, DNS 레벨 블록리스트로 교체 (다음 세션에서 구현할 부분)

### 배경 / 발견한 문제

1부(DNS 포워딩) 실사용 검증 중 별개의 실제 버그를 발견했습니다: squid의 `ssl_bump
intercept` 모드에 내장된 anti-spoofing 체크("Host header forgery" 검사 — 가로챈
목적지 IP가, squid가 클라이언트의 SNI/Host를 스스로 재해석(fresh DNS lookup)한
IP 목록과 일치하는지 비교)가, IP 풀이 로테이션되는 CDN형 도메인에서 계속
오탐합니다. 실측: `router`의 `cache.log`에 `registry-1.docker.io:443`에 대해 매번
다른 가로챈 IP로 `SECURITY ALERT: Host header forgery detected...`가 찍히고,
`docker pull`이 TLS 핸드셰이크가 깨지는 형태로 실패했습니다. 웹 리서치로 확인:
squid 공식 문서/메일링리스트 어디에도 transparent/intercepting 배포에서 이 체크를
끄는 공식 스위치가 없습니다.

### 확정된 방향 (사용자 승인 완료)

이 저장소의 squid/블록리스트 메커니즘은 **처음부터 "패시브, best-effort 리스크
완화"이지 하드 시큐리티 경계가 아님** — adblock과 같은 성격(막지 못한 광고가
있어도 보안 취약점이 아닌 것처럼, 막지 못한 도메인이 있어도 보안 취약점이 아님).
하드 경계는 `router/config/netgate/firewall.default.sh`의 RFC1918/CIDR FORWARD
규칙이 계속 담당 — **이 부분은 이번 작업과 무관, 절대 건드리지 않음.**

처음엔 "HTTPS만 squid 우회, HTTP만 블록리스트 유지"라는 좁은 수정을 시도했으나,
사용자가 지적한 대로 대부분의 트래픽이 HTTPS라 그렇게 하면 squid가 사실상
무의미해짐. 최종 결론: **squid를 통째로 제거하고, 그 블록리스트 역할을 dnsmasq의
DNS 레벨 블록킹으로 완전히 대체**한다 — 1부에서 이미 router에 dnsmasq를 추가했으므로
기능적으로 완전한 상위집합(superset)이고, 유지하는 건 오버엔지니어링이라는 게
사용자의 판단. dnsmasq는 `addn-hosts=<file>`로 hosts-format 파일을 그대로
읽어 도메인→0.0.0.0 매핑을 할 수 있고, 이 레포가 이미 빌드 타임에 받아두는
StevenBlack/hosts 원본이 정확히 그 포맷이라 변환 스크립트(`netgate-blocklist.sh`)도
같이 필요 없어진다.

이 교체로 인해 없어지는 것: intercept 리다이렉트(iptables REDIRECT 80/443→squid
포트) 자체가 필요 없어짐 — DNS 단계에서 이미 막히므로 어떤 TCP 연결도 시도되지
않음. 즉 squid의 커널 레벨 traffic interception 메커니즘 전체가 통째로 사라짐.

### 구현 전 git 상태

작업 트리는 커밋 `00bba1a` 기준으로 깨끗함. "HTTPS만 우회" 임시 수정은
`git checkout --`로 이미 되돌려져 있음 — 그 변경분은 존재하지 않음, 아래
체크리스트는 전부 `00bba1a`의 현재 파일 내용을 기준으로 함.

### 파일별 변경 체크리스트

**삭제할 파일:**
- `router/config/netgate/squid.default.conf` — squid 설정 전체(http_port/https_port
  intercept, ssl_bump peek/terminate/splice, acl blocklist/blocklist_sni 등).
- `router/config/netgate/squid.default.sh` — 기존 squid 설정 선택(default/override)
  + `NETGATE_BLOCKLIST_PATH` envsubst + exec squid 디스패처.
- `router/script/netgate-squid.sh` — 위 스크립트의 바깥 dispatcher.
- `router/script/netgate-blocklist.sh` — StevenBlack/hosts → squid dstdomain 포맷
  변환기. dnsmasq는 원본 hosts 포맷을 그대로 쓰므로 변환 자체가 불필요해짐.

**수정할 파일:**

- `router/config/netgate/firewall.default.sh`
  - 109~114줄의 squid REDIRECT 관련 두 줄과 그 위 주석 블록을 통째로 제거:
    ```sh
    iptables -t nat -A NETGATE-PREROUTING -i "$internal_iface" -p tcp --dport 80 -j REDIRECT --to-port 3129
    iptables -t nat -A NETGATE-PREROUTING -i "$internal_iface" -p tcp --dport 443 -j REDIRECT --to-port 3130
    ```
  - 이 두 줄을 지우면 `internal_iface` 변수가 이 함수 안에서 더 이상 쓰이는 곳이
    있는지 확인 필요(현재는 이 REDIRECT 두 줄이 유일한 사용처로 보임 — 만약 그렇다면
    `internal_iface` 계산 자체(43~54줄)와 "could not find the code-docker-internal
    interface" 에러 처리까지 같이 죽은 코드가 되므로 함께 제거할지 판단. 단, 향후
    "code-docker-internal에서 오는 트래픽만" 구분해야 하는 다른 기능이 생길 수도
    있으니, 정말 안 쓰이면 지우되 과감하게 지우는 쪽으로 — 이 레포는 dev 브랜치라
    안전하게 나중에 git history에서 복원 가능).

- `router/config/netgate/supervisord.default.conf`
  - `[program:squid]` 섹션 전체 제거. `[program:netgate-firewall]`은 그대로 유지.

- `router/Dockerfile`
  - pacman 설치 목록(52~54줄)에서 `squid` 제거.
  - `mkdir -p` 목록(56~60줄)에서 `/var/log/squid`, `/var/cache/squid` 제거,
    이어지는 `chown -R proxy:proxy /var/cache/squid` 줄 제거.
  - ssl-bump용 self-signed 인증서 생성 블록(76~87줄, `RUN openssl req -new
    -newkey rsa:2048 ...` ~ `chown -R proxy:proxy /etc/squid/ssl`) 전체 제거.
  - security_file_certgen cert-cache-db 초기화 블록(88~95줄, `RUN
    /usr/lib/squid/security_file_certgen ...`) 전체 제거.
  - `COPY --chown=root:root script/netgate-entrypoint.sh script/netgate-firewall.sh
    script/netgate-squid.sh script/netgate-blocklist.sh ...` (67~70줄)에서
    `script/netgate-squid.sh script/netgate-blocklist.sh` 제거.
  - StevenBlack/hosts 다운로드+변환 블록(96~104줄)을 다음과 같이 바꾼다: 지금은
    `curl ... -o /tmp/netgate-hosts-src && netgate-blocklist.sh 변환 && rm` 형태인데,
    변환 스크립트가 없어지므로 원본을 그대로 최종 목적지에 저장하도록 변경. 최종
    목적지 경로는 아래 dnsmasq 배선 방식과 짝을 맞춰 정한다(다음 항목 참고) — 예:
    `router/config/dns/blocklist.default.hosts`에 해당하는 빌드 결과 경로
    (`/etc/code-docker/dns/blocklist.default.hosts`)에 직접 저장.
    ```sh
    RUN curl -fsSL -o /etc/code-docker/dns/blocklist.default.hosts \
            https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts
    ```
    (COPY 순서상 `config/dns`가 이미 `/etc/code-docker/dns`로 COPY된 뒤에 이 RUN이
    와야 함 — 현재도 COPY들이 먼저, RUN들이 나중이라 순서는 이미 맞음.)
  - Dockerfile 맨 위 주석(1~30줄 어딘가, squid를 언급하는 부분: "a best-effort squid
    content blocklist" 같은 문구)도 dnsmasq 기반으로 갱신.

- `router/config/dns/dnsmasq.default.conf`
  - `addn-hosts=/etc/code-docker/dns/blocklist.default.hosts` 한 줄 추가(override
    파일이 있으면 그것도 추가로 읽게 할지는 아래 판단 참고). dnsmasq는
    `addn-hosts=`를 여러 번 써서 여러 파일을 합칠 수 있음 — override 지원이
    필요하면:
    ```
    addn-hosts=/etc/code-docker/dns/blocklist.default.hosts
    ```
    를 base config에 넣고, `router/config/dns/dns.default.sh`(디스패처, default/
    override 선택 로직이 이미 있는 파일)에서 override 블록리스트가 존재하면
    `--addn-hosts=` CLI 플래그를 추가로 넘겨 dnsmasq가 두 파일을 합쳐 읽게 한다
    (squid 시절 `NETGATE_BLOCKLIST_PATH`를 default/override 중 하나로 "택일"했던
    것과 달리, dnsmasq의 `addn-hosts`는 여러 개를 합치는 게 자연스러운 방식 — 즉
    override는 "대체"가 아니라 "추가 차단 목록"으로 의미가 바뀌는 게 자연스럽다.
    이 의미 변화를 문서에도 반영할 것).
  - `router/config/dns/dns.default.sh`가 이미 default/override 선택 로직을
    가지고 있는지 다시 확인 후(1부 구현에서 이미 존재), 위 CLI 플래그 추가 로직을
    그 안에 끼워 넣는다.
  - `.gitignore`에 이미 `router/config/dns/*.override.*`가 있으므로
    `router/config/dns/blocklist.override.hosts`는 별도 gitignore 추가 없이
    자동으로 커버됨 — 확인만 하면 됨.

### 남은 판단 포인트 — 전부 구현 시 확정됨

1. `internal_iface` 계산은 REDIRECT 제거 후 완전히 죽은 코드였음을 확인 →
   `firewall.default.sh`에서 계산 로직과 로그 메시지의 `internal=...` 부분까지 함께
   제거.
2. blocklist override 파일명/확장자는 `*.hosts`(`blocklist.override.hosts`)로 결정.
3. `openssl`은 squid ssl-bump 인증서 생성 외 다른 사용처가 없었음을 확인(grep 결과
   Dockerfile의 cert 생성 블록이 유일한 사용처) → pacman 목록에서 함께 제거.

### 검증 절차 (구현 후)

1. `docker compose build code-docker-router` 성공.
2. `docker compose up -d --force-recreate code-docker-router code-docker
   code-docker-dind` 후 `docker compose exec code-docker-router supervisorctl
   status` — `squid` 프로그램이 목록에서 완전히 사라졌는지, `dns`/
   `netgate-firewall` 등 나머지는 정상 RUNNING인지 확인.
3. code-docker 안에서 블록리스트에 있는 도메인(StevenBlack/hosts에 포함된 아무
   광고/트래커 도메인 하나)으로 `curl`/`getent hosts` — 해석 실패 또는
   `0.0.0.0`으로 떨어지는지 확인(차단 동작 확인).
4. code-docker 안에서 CDN형 도메인(`registry-1.docker.io` 등)으로 `docker pull`
   실제 시도 — 이번 버그가 실제로 해결됐는지 end-to-end 확인. 이게 이 작업
   전체의 핵심 검증 지점.
5. `router`의 iptables NAT 테이블(`iptables -t nat -L NETGATE-PREROUTING -n`)에
   더 이상 3129/3130 REDIRECT 규칙이 없는지 확인.
6. 블록되지 않은 일반 도메인(예: `github.com`)이 정상적으로 계속 resolve/접속
   되는지 확인(회귀 없는지).

### 후속 문서 업데이트 범위 (코드 변경 완료 후)

squid를 언급하는 모든 문서를 dnsmasq 기반 서술로 갱신:
- `router/CLAUDE.md`
- `router/plan.md`
- `docs/router.md`
- `docs/egress-netgate.md`
- 루트 `CLAUDE.md`의 "router" 섹션(`squid`, `blocklist.default.acl`,
  `netgate-blocklist.sh` 언급 부분을 dnsmasq/`addn-hosts`/원본 hosts 파일
  직접 저장 방식으로 갱신)

## 참고

- `.claude/functional-router-plan.md`(같은 디렉토리), 레포 루트
  `.claude/backlog/egress-netgate-plan.md` — router의 기존 설계/구현 이력.
- 이 문제를 처음 발견한 세션의 검증 로그: netgate→router 마이그레이션 Phase 1 커밋
  메시지(`refactor(router): promote netgate to its own router/ subtree`)에 "이미 알려진
  샌드박스 제약"으로 잘못 기록되어 있음 — 실제로는 일반적인 Docker `internal: true`
  네트워크 동작이었음이 이후 재확인됨, 이 문서가 정정된 이해임.
