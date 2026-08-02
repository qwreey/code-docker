# mise 관리 계획 (구현 전 설계 문서, 최후순위)

`webmanager/CLAUDE.md`에서 mise는 "범위가 넓어서 최후순위"로 미뤄져 있음. 이 문서는
그 mise 관리 기능을 실제로 만들 때 참고할 카테고리별 도구 추천 목록 + 설정 파일
설계를 미리 정리해둔 것. **지금 구현하지 않음** — 다른 기능들이 대체로 다 갖춰진
마무리 단계에서 진행.

익스텐션(code-server) 추천/설치는 별도 문서(`extensions-plan.md`)로 분리됨 — mise를
안 기다리고 더 일찍 만들어도 되는 독립적인 기능이라 우선순위도 다름(중간).

## 배경

두 가지 요청:

1. mise로 설치할 만한 도구들을 카테고리별로 정리해서 "이런 거 설치하시겠어요?" 하는
   추천 UI
2. 기업에서 유저별로 컨테이너를 나눠주는 경우를 위해, 이 추천 목록을 배포하는 쪽이
   직접 추가/조정할 수 있게 override 가능한 설정 파일로 만들기

## 카테고리별 mise 도구 추천 목록 (초안)

**mise 짧은 이름/백엔드는 mise 버전에 따라 바뀔 수 있어서, 실제 구현 시점에
컨테이너 안에서 `mise registry`로 재확인 필요** — 아래는 2026-08 기준 조사 결과
(정확도 보장 안 됨).

### 언어 런타임/툴체인
- `node` — Node.js
- `deno` — Deno
- `bun` — Bun
- `go` — Go
- `rust` — Rust
- `zig` — Zig
- `java` — Java (버전 뒤에 벤더 지정 가능, 예 `java@temurin-21`)
- `haskell` — GHC/Haskell (mise core로 편입됐는지, asdf 플러그인 경유인지 재확인)

### CLI 유틸리티
- `gh` — GitHub CLI
- `fzf` — 퍼지 파인더
- `ripgrep`(`rg`) — grep 대체
- `fd` — find 대체
- `bat` — cat 대체(신택스 하이라이트, 백엔드가 여러 개일 수 있어 자동 선택되는지
  확인 필요)
- `jq` — JSON 처리
- `direnv` — 디렉토리별 환경변수
- `lazygit` — 터미널 git UI

### 확장 후보 (아직 요청 안 됐지만 자연스러운 카테고리)
- **인프라/클라우드 CLI**: `terraform`, `kubectl`, `helm`, `awscli` 등
- **패키지 매니저(언어별 보조)**: `pnpm`/`yarn` 등 — 별도 카테고리보다 해당 언어
  런타임 옆에 나열하는 편이 자연스러움

## `recommendations.default.yaml` 설계 (초안, mise 부분)

기존 override 패턴 그대로 — 단 이건 스크립트가 아니라 순수 데이터 파일이라 디스패처
자체는 필요 없고 webmanager 백엔드가 override 유무만 확인하고 읽으면 됨
(`code-config.*.yaml`이 이미 "디스패처 없는 데이터형 override"의 선례).

```yaml
mise:
  - category: "언어 런타임/툴체인"
    tools:
      - id: node
        label: Node.js
        description: JavaScript/TypeScript 런타임
      - id: go
        label: Go
      - id: rust
        label: Rust
      - id: deno
        label: Deno
      - id: bun
        label: Bun
      - id: zig
        label: Zig
      - id: java
        label: Java
      - id: haskell
        label: GHC (Haskell)
  - category: "CLI 유틸리티"
    tools:
      - id: gh
        label: GitHub CLI
      - id: fzf
        label: fzf
      - id: ripgrep
        label: ripgrep
      - id: fd
        label: fd
      - id: bat
        label: bat
      - id: jq
        label: jq
      - id: direnv
        label: direnv
      - id: lazygit
        label: lazygit
```

(`extensions:` 최상위 키는 같은 파일에 같이 두되, 그 부분의 설계/우선순위는
`extensions-plan.md` 참고 — 파일 자체는 하나로 공유하는 게 자연스러움.)

- `config/recommendations.default.yaml` (레포에 기본값으로 커밋)
- `config/recommendations.override.yaml` (gitignore 대상, 기업/조직이 자기 이미지
  빌드할 때 이 파일만 새로 써서 완전히 다른 추천 목록으로 교체 가능)
- webmanager 백엔드가 override 있으면 override, 없으면 default를 읽어서
  `GET /api/recommendations`로 노출 (mise/extensions 공용 엔드포인트)
- 프론트에서 카테고리별로 나열, 체크박스로 여러 개 골라서 "설치" 누르면
  `mise use -g <id>...`를 백엔드가 실행 — mise 관리 기능 자체의 일부라 mise CRUD
  구현과 같이 감

## 순서/타이밍

1. **지금**: 이 문서로 설계만. mise 관리 기능 구현 시작할 때 `GET/POST /api/mise/
   tools` 등 mise 자체 CRUD와 같이, `recommendations.yaml`의 `mise` 목록을
   카테고리별로 보여주고 체크박스로 설치하는 UI를 같이 만듦.
2. 구현 시점에 `mise registry` 명령으로 위 카테고리 목록의 실제 짧은 이름/백엔드를
   재확인할 것 — 이 문서의 목록은 초안일 뿐 확정 스펙 아님.

## 참고

- 전체 우선순위/현재 상태는 `webmanager/plan.md`, `webmanager/CLAUDE.md` 참고.
- 익스텐션 추천/설치는 `extensions-plan.md`.
