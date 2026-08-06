# router가 DNS 리졸버 역할까지 맡는 구상

작성일: 2026-08-06 — netgate→router 마이그레이션(`functional-router-plan.md`) 완료 후,
실제 사용 검증 중 발견한 문제를 계기로 정리.

## 문제

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
`script/netinit-entrypoint.sh`/`script/dind-entrypoint.sh`가 라우트를 위해 하는 것과
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

## 참고

- `.claude/backlog/functional-router-plan.md`, `.claude/backlog/egress-netgate-plan.md` —
  router의 기존 설계/구현 이력.
- 이 문제를 처음 발견한 세션의 검증 로그: netgate→router 마이그레이션 Phase 1 커밋
  메시지(`refactor(router): promote netgate to its own router/ subtree`)에 "이미 알려진
  샌드박스 제약"으로 잘못 기록되어 있음 — 실제로는 일반적인 Docker `internal: true`
  네트워크 동작이었음이 이후 재확인됨, 이 문서가 정정된 이해임.
