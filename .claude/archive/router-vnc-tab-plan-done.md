# router VNC 탭 (완료 — 2026-08-25)

**2026-08-27 후속 — 뷰어가 router 안으로 들어옴 (`rfb` 백엔드)**: 이 문서가
정한 "탭은 App Routes 위의 얇은 층" 결정이 뒤집혔다. 이유는 그 결정 자체가
틀려서가 아니라(전송 경로로서는 정확히 맞았다) 그 결과로 **router의 1급
기능이 사용자가 등록한 제3자 앱과 구분이 안 되게** 됐고, 그 대가를 하나씩
우회로 갚고 있었기 때문:
`ROUTER_MANAGER_HOSTS` 전용 도메인에서 뷰어를 아예 못 띄움(→ 아래 "뷰어 origin
문제", 결국 `ROUTER_APP_ORIGIN`이라는 변수를 하나 더 만들어 막음), 접근 제어에
tinyauth forward-auth 경로 전체가 필요함, 대상 컨테이너마다 웹 VNC 스택을
따로 심어야 함, noVNC의 0x0 desktop 버그를 대상마다 각각 패치해야 함.
VNC는 앱이 아니라 **프로토콜(계층)** 이므로 클라이언트 쪽을 router가 갖는 게
맞는 모양이라는 판단(사용자 결정, 2026-08-27).

바뀐 것: `Backend`가 "누가 뷰어를 서비스하는가" 축이 되고 기본값이 `rfb`로
바뀜 — router가 noVNC를 이미지에 vendoring해서(`NOVNC_VERSION`, 0x0 패치 포함)
`/router/novnc/`에서 직접 서비스하고, `GET /api/vnc/targets/{name}/ws`가
브라우저 WebSocket을 대상의 **raw RFB 포트**로 중계한다. App Route를 안 만들고,
뷰어가 항상 SPA와 same-origin이며(전용 도메인에서 그냥 됨), 접근 제어는
router-manager 자신의 authgate다. 기존 `novnc` 백엔드는 **폐기가 아니라 유지** —
Selkies처럼 raw RFB 포트가 없는 프런트엔드는 웹 프런트엔드를 프록시하는 것
말고는 방법이 없으므로, 둘은 같은 일의 신구 버전이 아니라 서로 다른 전송
경로다. 자세한 내용은 `router/CLAUDE.md`의 VNC 항목과
`router/backend/internal/vnc`의 패키지 doc comment.

라이브 검증(2026-08-27, 이 checkout): 실제 브라우저에서 `rfb` 대상 연결
(`RFB 003.008` 배너 → security types 협상 → 화면 표시), router-manager 잠금 시
안내 표시 + 해제 후 즉시 재연결, 백엔드 전환 시 옛 App Route 삭제 확인.

**2026-08-25 완료**: 문서 제목이자 경로 B의 정의였던 "진짜 VNC 탭"까지 구현하고
라이브 검증함 — 이 문서가 backlog에서 archive로 옮겨진 이유. 이전 업데이트들이
구현한 건 전송 경로(B-1)까지였고 탭 자체는 없었음.

구현된 것:
- **router**: `backend/internal/vnc` (타겟 레지스트리 +
  `/var/lib/code-docker-router/vnc/targets.json`, App Route를 lockstep으로
  생성/수정/삭제, `List`가 매번 approutes를 다시 읽어 drift 보고),
  `backend/handlers_vnc.go` (`/api/vnc/targets[/{name}]`),
  `frontend/src/components/Vnc/` (목록 + 추가/편집 다이얼로그 + iframe 뷰어 +
  전체화면/새 탭), `docs/vnc.md`.
- **code-docker**: webmanager 사이드바에 VNC 탭 추가(`RouterFrame tab="vnc"`),
  `RouterFrame`이 자기 origin을 `?origin=`으로 전달 + `allow="fullscreen;
  clipboard-*"` (중첩 iframe 3단이라 모든 조상이 허용해야 함),
  `docs/index.md`/`docs/webmanager.md` 갱신.

설계 결정 두 가지가 이 문서에 없던 것으로, 구현 중 추가로 정해짐:
- **탭은 App Routes 위의 얇은 층** — 새 프록시 메커니즘이 아니라 App Route를
  자동으로 만들어 주는 레지스트리. 대신 반대쪽(App Routes 탭)에서 손댄 변경이
  묻히지 않도록 캐시 대신 매번 대조해 `routeMissing`/`routeDiverged`로 표시하고,
  없어진 route는 편집-저장으로 self-heal.
- **뷰어 origin 문제** — `/app/`은 공유 호스트네임에만 서비스되고
  `ROUTER_MANAGER_HOSTS` 전용 도메인에는 의도적으로 없음. 그래서 뷰어 iframe이
  `window.location.origin`을 그냥 쓸 수 없고, webmanager 임베드가 `?origin=`으로
  알려주며, 전용 도메인을 직접 연 경우엔 뷰어 대신 설명을 띄움
  (`useViewerOrigin.ts`).

라이브 검증(이 checkout, `.allow-test`): API 전 경로(생성/이름변경/삭제/
drift 4종/self-heal/allowlist·self-SSRF·잘못된 backend 거부), router `/router/`
탭에서 실제 labwc 데스크톱 임베드 + 마우스 입력 반영, webmanager `/manager/vnc`
3단 중첩 iframe에서도 동일, `ROUTER_MANAGER_HOSTS` 전용 도메인 거부 문구까지
전부 확인. **`VNC_PASSWORD` VeNCrypt 이슈는 그대로 남아 있음**(아래 e2e 절
참고) — 검증 중 재현되어, 그 값을 비운 상태에서 연결 성공을 확인했고 이후
원복함. `docs/vnc.md`의 "알려진 제약"에 사용자용으로 기록됨.

---

# (원문) router VNC 탭 (아이디어 정리 — 구현 전, 사용자 노트 + 리서치 종합)

2026-08-18, 사용자가 다른 여러 요청과 함께 남긴 노트를 정리한 문서. 조사(3개
서브에이전트: wayvnc/neatvnc 성능 실태, wlroots용 대안 스택 비교, router
아키텍처 적합성)는 끝났지만 구현 방향을 결정할 사용자 판단이 남아 있어 이번
라운드엔 착수하지 않음.

**2026-08-19 업데이트**: KasmVNC/Guacamole 추가 리서치 완료, 구현 방향
결정됨(noVNC+websockify, Selkies는 백로그) — 아래 "결정 사항" 섹션 참고.

**2026-08-19 후속 업데이트 — 코드 구현 완료, e2e 미검증**: 경로 B-1과 그
공통 후속 작업(아래 "이후 공통으로 필요한 작업")까지 코드로 구현함:
- **router (이 repo)**: `targetguard.WithExtraHosts` + `ROUTER_EXTRA_ALLOWED_TARGET_HOSTS`
  env var(`.env.router`, `ROUTER_ENV_VERSION` 5→6) 로 devproxy/approutes
  allowlist를 코드 수정 없이 확장 가능하게 일반화 — 미해결 질문 3번 해결(env
  var 방식 채택, router-manager 편집 UI는 아님 — SelfHosts류 보안 성격
  리스트라 인프라 설정 고정 쪽이 일관적이라고 판단). `docs/dev-proxy.md`/
  `docs/app-routes.md`도 갱신.
  - **아직 이 repo 쪽에 안 한 것**: App Routes 항목 자체(`vnc-only:6080` →
    `/app/studio-vnc/` 같은) 등록은 router-manager API/UI로 *런타임에* 하는
    작업이라 코드 변경 대상이 아님 — 실제 인스턴스 띄운 뒤 수동으로(또는
    다음 세션에) 등록 필요.
- **`~/Projects/roblox-studio-docker`(sibling repo)**: wayvnc는 그대로 두고
  앞단에 noVNC+websockify(`[program:novnc]`, `VNC_WEB_PORT` 기본 6080) 추가 —
  같은 `VNC_BIND_ALIAS` fail-closed 격리를 websockify의 listen/target 양쪽에
  동일 적용. 상세는 그 repo의 `CLAUDE.md`("VNC embedding" 절)/`plan.md`
  (10번)/`SETUP.md`/`code-docker-integration-plan.md` 참고.

**2026-08-19 e2e 실측 완료 (같은 날 후속)**: `.allow-test` 확인된 이 checkout에서
실제로 `docker compose build`(양쪽 repo) → `EXTRA_INCLUDE`+
`NETFILTER_FIX_EXTRA_INTERNAL_NETWORKS=roblox-studio-vnc`로 6개 컨테이너 전부
기동 → router-manager API로 `vnc-only:6080` App Routes 항목 실제 등록 →
Claude-in-Chrome으로 `/app/studio-vnc/vnc.html` 직접 열어 확인:
- 격리(코드에서 vnc-only resolve 불가, router는 가능), 서브패스 에셋 로딩,
  WebSocket 업그레이드+RFB 배너 수신, 브라우저 "Connected (unencrypted) to
  WayVNC" 상태 + 마우스 이동까지 전부 실측 확인. 경로 B-1은 **동작 확인됨**.
- **미해결로 남은 실제 이슈**: `VNC_PASSWORD` 설정 시 noVNC가
  `Unsupported security types (types: 262)`로 실패 — wayvnc가 제공하는
  VeNCrypt X509Plain 서브타입을 이 noVNC 릴리스가 구현하지 않아서 생기는
  실제 버전 호환성 문제(raw RFB 프로브로 근본원인까지 확인, 배선 버그
  아님). 임시 완화책: 웹 경로는 `VNC_PASSWORD` 대신 App Routes의
  `requireAuth`(tinyauth)로 게이팅. 상세는 roblox-studio-docker
  `CLAUDE.md`의 "VNC embedding" 절 참고. 테스트에 쓴 App Routes 항목
  (`studio-vnc`)과 `.env.router`의 `ROUTER_EXTRA_ALLOWED_TARGET_HOSTS`는
  이 테스트 checkout에 남겨둠(`.allow-test` 환경이라 정리 불필요).

## 동기

`roblox-studio-docker`(sibling 프로젝트, `~/Projects/roblox-studio-docker`,
`EXTRA_INCLUDE`로 연동)처럼 GUI 앱(Roblox Studio via Wine/X11 위 labwc)을
띄우는 컨테이너가 여러 개 있을 수 있는데, 매번 별도 클라이언트를 붙이는 건
번거로움. router가 이미 코드docker의 네트워크 경계를 담당하고 있으니, router가
"code-docker-internal(또는 EXTRA_INCLUDE로 확장된 네트워크)에 붙은 임의의
노드"에 연결해 웹에서 볼 수 있는 기능을 갖는 게 자연스러워 보임. noVNC는
반응성이 별로라 KasmVNC 등 대안이 있는지 확인이 필요했음.

## 결정이 필요한 지점 (가장 중요)

**"LAN에서 네이티브 클라이언트 없이 VNC 접속" vs "웹 대시보드 안에서 바로
보고 조작"** — 이 둘 중 뭘 원하는지에 따라 아래 경로가 완전히 갈림. 다음
세션에서 이것부터 확인.

## 리서치 결과 요약

### 1. `roblox-studio-docker`의 현재 상태 (확인 완료)

- **wayvnc**를 raw RFB/TCP 5900으로만 돌림. noVNC/websockify 없음.
- **`--gpu`/VAAPI 하드웨어 인코딩 미적용** — 소프트웨어 인코딩만 사용 중
  (`grep -rniE "\-\-gpu|vaapi|hwaccel"` 결과 0건). "이미 켜져 있을 수도"라는
  기대는 틀렸음 — 실제 갭.
- 이미 `router`와만 연결된 `internal: true` 전용 네트워크(`roblox-studio-vnc`)로
  격리돼 있고, **netgate의 기존 raw TCP `forwards:` 기능**(`/api/netgate/forwards`)으로
  이미 노출 가능 — 이 경로는 `.claude/archive/roblox-studio-vnc-isolation-plan-done.md`에서
  이미 구현·라이브 검증까지 끝남.

### 2. wayvnc/neatvnc 자체의 성능 실태

- 아키텍처는 정상적임 — full frame이 아니라 damage region 기반, 32×32 타일
  XXH3 해시 리파이너리로 컴포지터의 과잉 damage 보고를 2차 필터링, Tight/ZRLE
  병렬 압축. "무조건 풀프레임을 쏜다"류 비난은 근거 없음.
- 다만 메인테이너(any1) 본인이 "VNC는 CPU를 많이 먹을 수밖에 없다"고 여러 차례
  인정함 — 기본 30fps 상한도 이 때문. 탈출구인 하드웨어 H.264는
  `--gpu`(DMA-BUF) + 실제로 동작하는 VAAPI/v4l2m2m 인코더가 갖춰져야만
  켜지고, 이 경로는 NVIDIA/AMD dGPU에서 반복적으로 깨진 이력이 있음(이슈
  #360, #258 open, #327 fix됨).
- **정정**: noVNC는 이미 H.264(encoding 50)를 WebCodecs로 지원함(1.6.0+) —
  "브라우저라 H.264를 못 쓴다"는 틀린 전제. 진짜 병목은 서버 쪽 GPU 인코딩
  경로 활성화 여부.
- 공개된 정량 벤치마크는 존재하지 않음(Phoronix/LWN/Reddit/포럼 다 확인함).
  저자 본인의 계측: noVNC 프레임 지연(평균 10.6ms)은 네이티브 클라이언트와
  대등하고, 체감 지연은 대부분 Chromium 자체 렌더링 오버헤드(~50ms) 때문.

### 3. router 아키텍처 적합성 (핵심 결론)

- router의 App Routes/Dev Proxy는 stock Caddy(`caddy run`, layer4 빌드 아님)라
  **HTTP/WS 전용** — raw RFB(binary TCP) 프로토콜을 그대로 못 나름. wayvnc를
  안 바꾸는 한 App Routes로 VNC를 못 태움.
- `targetguard.allowedTargetHosts`가 `devproxy.go`/`approutes.go` 양쪽 모두
  **하드코딩된 Go map**(`{"code-docker", "dind"}`)이라, 프로토콜과 무관하게
  `studio` 같은 sibling 호스트를 추가하려면 코드 수정이 필요함. sibling
  연동 지점에서 이 하드코딩 벽에 부딪힌 게 이번이 두 번째(첫 번째는 netgate
  forwards) — 일반화할 가치가 있어 보임.

## 두 가지 구현 경로

### 경로 A — "클라이언트 없이 LAN에서 접속" (구현 비용 낮음)

- wayvnc를 raw TCP로 그대로 두고, 기존 netgate Forwards CRUD
  (`router/backend/internal/netgate`, `/api/netgate/forwards`) 위에 VNC 전용
  UI만 얇게 얹음 — 프리셋 라벨/기본값 정도의 "UI 전용" 작업, 백엔드 변경 없음.
  템플릿: `router/frontend/src/components/NetManagement/Forwards.tsx`.
- 단점: 여전히 TigerVNC/KRDC 같은 네이티브 VNC 클라이언트가 필요함(웹
  임베드 아님).

### 경로 B — "웹 대시보드에 라이브 임베드" (구현 비용 높음, 진짜 "VNC 탭")

전제: `roblox-studio-docker` 쪽 VNC 스택을 HTTP+WS 로 말하게 먼저 바꿔야
App Routes가 유효한 전송 경로가 됨. 두 옵션:

1. **wayvnc는 유지하고 앞단에 noVNC+websockify를 얹음** — 더 저렴한 중간
   단계, 다만 소프트웨어 인코딩/CPU 부담 문제는 그대로 남음.
2. **Selkies로 전환**(`SELKIES_WAYLAND_HOST_DISPLAY`로 기존 labwc를 외부
   compositor로 캡처) — Selkies 공식 설정 도움말에 "labwc를
   `WLR_BACKENDS=headless`로 띄운 경우"가 문자 그대로 예시로 박혀 있어 지금
   구성과 정확히 일치. `pixelflux` 확장으로 zero-copy GPU H.264, 순수
   WebSocket(WebRTC 불필요), `zwlr_virtual_pointer_manager_v1`/
   `zwp_virtual_keyboard_manager_v1`로 입력 주입(`/dev/uinput` 불필요 —
   labwc가 둘 다 이미 노출함). LinuxServer.io의 Webtop 4.0에서 프로덕션
   검증됨.
   - 먼저 시도해볼 것: 지금 wayvnc에 `--gpu`만 켜고 VAAPI가 실제로 동작하는지
     확인 — 이게 되면 최소한 CPU 부담 문제는 Selkies 전환 없이도 완화될 수
     있음(단, 여전히 raw RFB라 브라우저 임베드 자체는 안 됨 — 경로 B를
     택했다면 결국 프로토콜 자체를 바꿔야 함).

이후 공통으로 필요한 작업:
- `targetguard.allowedTargetHosts`를 하드코딩 map에서 확장 가능한 형태로
  일반화(예: `NETFILTER_FIX_EXTRA_INTERNAL_NETWORKS` 인접 호스트를 읽거나,
  router-manager에서 편집 가능한 allowlist)한 뒤 `studio`/`vnc-only` 추가.
- `roblox-studio-vnc` 네트워크의 격리 모델을 App Routes 경유 시나리오에 맞게
  재검토(Caddy가 router 컨테이너 안에서 도는 건 동일하므로 "국경은 router만"
  원칙 자체는 유지됨).

## 미해결 질문 (2026-08-19: 1, 2번 결정됨 — 아래 "결정 사항" 참고)

1. ~~위 "경로 A vs B" 선택.~~ → 경로 B, 그 중 B-1(noVNC+websockify)로 결정.
2. ~~B를 택했다면 wayvnc를 완전히 버릴지, 기존 SETUP.md의 TigerVNC/KRDC
   워크플로우(실사용자 존재)를 나란히 유지할지.~~ → wayvnc 유지, TigerVNC/KRDC
   워크플로우도 나란히 유지(raw RFB 5900은 그대로 열어둠, noVNC는 그 앞에
   추가되는 것이지 대체가 아님).
3. ~~`allowedTargetHosts`를 어떤 형태로 일반화할지(env var vs router-manager
   편집 UI)~~ → env var(`ROUTER_EXTRA_ALLOWED_TARGET_HOSTS`, targetguard.WithExtraHosts)
   로 결정 — SelfHosts와 같은 보안 성격 목록이라 라이브 편집 UI보다 인프라
   설정으로 고정하는 쪽이 기존 `ALLOWED_HOSTS`/`ALLOWED_EXPORT_HOSTS` 패턴과도
   일관됨. netgate forwards 쪽 동일 패턴 필요 여부는 별도로 미검토 상태로 남음
   (forwards는 애초에 임의 host:port를 이미 허용하는 별개 메커니즘이라 이
   allowlist 문제 자체가 없음 — 재확인 필요하면 `router/backend/internal/netgate`
   참고).

## 결정 사항 (2026-08-19)

- **지금 구현할 것**: 경로 B-1 — wayvnc는 그대로 두고 앞단에 **noVNC+websockify만
  얹는다.** Selkies 전환은 하지 않음.
- **Selkies는 백로그로 이관**: "실사용 중 실제로 성능 문제를 겪으면 그때
  처리" 트리거로 미룸. 지금 당장 구현할 근거가 부족하다는 판단(사용자
  결정, 2026-08-19).
- **스택은 타겟별로 다를 수 있다는 전제**: 이 VNC 임베드 기능이 결국
  router에 붙는 임의의 GUI 컨테이너를 겨냥하는 범용 기능이 될 것이므로,
  모든 타겟이 고효율 스택(Selkies)을 필요로 하진 않음 — 예: redis-insight
  류의 단순 웹/GUI 툴은 noVNC로 충분, Roblox Studio처럼 카메라 회전·드래그가
  잦은 3D 인터랙션은 결국 Selkies가 필요해질 가능성이 높음. **향후 방향은
  noVNC와 Selkies를 나란히(타겟별 선택 가능하게) 지원하는 것** — 지금은
  noVNC 하나만 구현하고, Selkies는 나중에 두 번째 백엔드 옵션으로 추가.
- **`wayvnc --gpu` 하드웨어 인코딩은 별개의 독립적 옵션으로 남겨둠**: noVNC
  채택 여부와 무관하게 wayvnc 자체 인코딩 단계에서 켤 수 있음(리서치 결과
  2번 항목 참고). 다만 NVIDIA는 여전히 깨짐(이슈 #360/#258 open), AMD
  dGPU는 수정됨(#327) — 호스트 GPU 벤더 확인 후 시도할 가치가 있는
  독립적인 후속 최적화로 백로그에 남김(이번 구현 스코프엔 없음).

## 추가 리서치 (2026-08-19): "noVNC 반응성이 별로라 대안 필요" 질문에 대한 답

동기 섹션에 남아있던 "noVNC는 반응성이 별로라 KasmVNC 등 대안이 있는지 확인
필요" 질문을 재조사함 (KasmVNC, Apache Guacamole 개별 검토):

- **KasmVNC**: TigerVNC(Xvnc)를 포크해 noVNC+websockify+VNC서버를 하나로
  통합한 웹 네이티브 서버. HW H.264/H.265/AV1 인코더 내장, 멀티유저·클립보드·
  오디오 지원 등 스펙만 보면 매력적이지만 **핵심적으로 X11(Xvnc) 기반이라
  Wayland/wlroots 네이티브 캡처를 지원하지 않음** — Wayland 지원 요청 이슈
  (kasmtech/KasmVNC#193)가 여전히 open. labwc(wlroots headless)를 쓰는 이
  프로젝트에 붙이려면 XWayland 브리지를 또 얹어야 해서, KasmVNC가 원래
  없애려던 "레이어 여러 개" 문제를 재도입하는 셈 — 부적합.
- **Apache Guacamole**: VNC/RDP/SSH를 하나의 브라우저 클라이언트로 통합하는
  프로토콜-어그노스틱 게이트웨이. guacd가 RFB를 받아 자체 프로토콜로
  재인코딩해 넘기는데, 실측 보고 사례 기준 guacd+VNC 처리 합산 지연이 약
  150ms까지 관측됨(wayvnc/noVNC 조합의 ~10.6ms와 자릿수 차이). 멀티프로토콜
  게이트웨이가 필요 없는 단일 VNC 타겟 하나에 guacd+톰캣 풀스택을 얹는 것도
  이 프로젝트 규모 대비 과설계.
- **결론**: KasmVNC/Guacamole 둘 다 이 스택(Wayland/wlroots, 단일 타겟)에는
  noVNC+websockify보다 못함 — **noVNC 유지가 이 셋 중에서는 여전히
  합리적**. 다만 셋 중 최선일 뿐, 카메라 회전 같은 지연시간 민감한 3D
  인터랙션을 진짜로 개선하려면 위 "경로 B-2"에 이미 적혀 있던 **Selkies
  전환**이 여전히 더 나은 답 — 이번 조사로 그 판단은 바뀌지 않음.

Sources: KasmVNC docs/wiki (Differences From TigerVNC), kasmtech/KasmVNC#193,
Guacamole architecture doc, Guacamole 메일링리스트 지연시간 스레드.

## 참고

- `~/Projects/roblox-studio-docker` — 현재 wayvnc 설정, `roblox-studio-code-docker.yml`
  오버레이(Phase 1/2 네트워크 분리).
- `.claude/archive/roblox-studio-vnc-isolation-plan-done.md` — 기존 raw
  forwards 노출 경로, 이미 완료·검증됨.
- `router/backend/internal/devproxy`, `router/backend/internal/approutes`,
  `router/backend/internal/targetguard` — App Routes/Dev Proxy 구현체.
- `router/config/caddy-adapter/` — router의 stock Caddy 인스턴스.
- 루트 `CLAUDE.md`의 "router" 절.
