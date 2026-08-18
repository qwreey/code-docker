# router VNC 탭 (아이디어 정리 — 구현 전, 사용자 노트 + 리서치 종합)

2026-08-18, 사용자가 다른 여러 요청과 함께 남긴 노트를 정리한 문서. 조사(3개
서브에이전트: wayvnc/neatvnc 성능 실태, wlroots용 대안 스택 비교, router
아키텍처 적합성)는 끝났지만 구현 방향을 결정할 사용자 판단이 남아 있어 이번
라운드엔 착수하지 않음.

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
  일반화(예: `CODE_DOCKER_EXTRA_INTERNAL_NETWORKS` 인접 호스트를 읽거나,
  router-manager에서 편집 가능한 allowlist)한 뒤 `studio`/`vnc-only` 추가.
- `roblox-studio-vnc` 네트워크의 격리 모델을 App Routes 경유 시나리오에 맞게
  재검토(Caddy가 router 컨테이너 안에서 도는 건 동일하므로 "국경은 router만"
  원칙 자체는 유지됨).

## 미해결 질문

1. 위 "경로 A vs B" 선택.
2. B를 택했다면 wayvnc를 완전히 버릴지, 기존 SETUP.md의 TigerVNC/KRDC
   워크플로우(실사용자 존재)를 나란히 유지할지.
3. `allowedTargetHosts`를 어떤 형태로 일반화할지(env var vs router-manager
   편집 UI) — netgate forwards 쪽에도 같은 패턴이 필요한지 함께 검토.

## 참고

- `~/Projects/roblox-studio-docker` — 현재 wayvnc 설정, `roblox-studio-code-docker.yml`
  오버레이(Phase 1/2 네트워크 분리).
- `.claude/archive/roblox-studio-vnc-isolation-plan-done.md` — 기존 raw
  forwards 노출 경로, 이미 완료·검증됨.
- `router/backend/internal/devproxy`, `router/backend/internal/approutes`,
  `router/backend/internal/targetguard` — App Routes/Dev Proxy 구현체.
- `router/config/caddy-adapter/` — router의 stock Caddy 인스턴스.
- 루트 `CLAUDE.md`의 "router" 절.
