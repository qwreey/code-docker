# webmanager에서 @code-docker/router-frontend 의존 제거 (완료됨 — 아래 "결론"은 낡은 내용)

> **완료됨 (2026-08-08 데카플링으로 실제 실행됨)**: 이 문서의 "지금 당장은
> 못 뗀다"/"결론: 지금은 실행하지 않고"는 이 문서를 쓴 시점의 조사 결과일
> 뿐, 실제로는 이후 바로 두 가지 다 처리됐다 — `RouterFrame.tsx`의 `Direct`
> fallback이 제거되어 항상 iframe으로만 렌더링하고(`ROUTER_MANAGER_HOSTS`
> 유무는 iframe이 same-origin이냐 cross-origin이냐만 가름), `ErrorBanner`/
> `Sheet`/`Skeleton`은 webmanager 자체 코드로 복제됐다. 현재
> `webmanager/frontend/src`에는 `@code-docker/router-frontend` import가
> 전혀 없고, `webmanager/frontend/package.json`도 그 의존성을 갖지 않는다
> (직접 grep으로 확인, 2026-08-10). 최신 설계는 `router/CLAUDE.md`와
> `webmanager/CLAUDE.md`의 Tailscale/DNS 탭 절 참고 — 아래 본문은 역사적
> 기록으로만 남겨둔다.

## 배경

나중에 `router/`와 `webmanager/`가 각자 별도 git 저장소로 분리될 가능성이
있는데, 지금은 루트 `package.json`의 npm workspaces(`router/frontend`,
`webmanager/frontend`)로 호이스팅되어 있고 `webmanager/frontend`가
`@code-docker/router-frontend`(`router/frontend`)를 정식 의존성으로 갖고
있음. 분리 전에 이 결합을 없애고 각 프로젝트가 자기 안에서 완결되게
정리하고 싶다는 문제 제기(2026-08-08)에서 시작.

## 조사 결과 — 지금 당장은 못 뗀다

`webmanager/frontend/src` 전체에서 `@code-docker/router-frontend` import를
grep한 결과, 두 가지 서로 다른 이유로 여전히 필요함:

1. **router 전용 컴포넌트** (`DevProxy`/`AppRoutes`/`Tailscale`/
   `RouterUnlockModalHost`/`RouterAuthSetupBanner`) — `App.tsx`에서 직접
   import. `RouterFrame.tsx`(`webmanager/frontend/src/components/RouterEmbed/`)가
   `ROUTER_MANAGER_HOSTS`(전용 도메인)가 설정된 경우에만 cross-origin
   iframe으로 전환하고, **미설정 시 기본값은 여전히 이 컴포넌트들을 같은
   origin에서 직접 렌더링**하는 `Direct` fallback 경로임
   (`RouterFrame.tsx:45-51`). 즉 iframe은 옵션이지 항상 경로가 아님.

2. **더 큰 이유 — 공용 UI 프리미티브** (`ErrorBanner`/`Sheet`/`Skeleton`) —
   `router/frontend/src/components/common/`에 정의돼 있지만, router 기능과
   무관하게 webmanager 전역 **40여 개 파일**(GitConfig, FileManager,
   Terminal, Processes, Dind, Supervisor, Sessions, Mise, Extensions,
   RestartNeededBanner 등)에서 공용 컴포넌트로 쓰이고 있음. 사실상
   router-frontend가 webmanager의 공용 컴포넌트 라이브러리 역할을 겸하고
   있는 상태.

## 완전히 떼려면 필요한 작업 (미착수)

- **iframe 강제 여부 결정** — `Direct` fallback을 없애고 항상 iframe으로
  렌더링할지, 아니면 router 전용 컴포넌트 자체를 webmanager 쪽에 별도
  구현/복제할지. 전자를 택하면 `ROUTER_MANAGER_HOSTS` 미설정 환경의 UX가
  바뀜(같은 origin 직접 렌더링이 사라짐).
- **`ErrorBanner`/`Sheet`/`Skeleton`을 webmanager 자체 코드로 복제 또는
  재작성** — 40여 곳의 import를 전부 webmanager 자체 경로로 바꿔야 함.
  단순 파일 복사로 끝날 수도 있지만, 두 프로젝트가 분리된 뒤 각자
  독립적으로 진화하면서 다시 벌어질 여지가 있음(중복 유지 비용).
- 위 두 가지가 끝나야 루트 `package.json`의 workspaces 항목과
  `webmanager/frontend/package.json`의 `@code-docker/router-frontend`
  의존성을 실제로 지울 수 있음.

## 결론

지금은 실행하지 않고 기록만 남김. router/webmanager를 실제로 분리 저장소로
쪼개는 시점에 맞춰 재검토.
