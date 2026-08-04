# 익스텐션 검색/URL 설치 (구현 전 설계, 미착수)

`.claude/archive/extensions-plan-done.md`(구현 완료, 아카이브됨)의 후속 기능.
지금은 `recommendations.*.yaml`에 미리 등록된 목록만 설치 가능함 — 여기서는
임의 익스텐션을 검색해서 설치, 특히 마켓플레이스 URL을 붙여넣어서 설치하는
기능을 다룸. ("더 보기" open-vsx 정보 링크는 이미 구현 완료 —
`archive/extensions-plan-done.md` 참고. 삭제(uninstall)는 이미 구현 완료 —
아래 "삭제/비활성화 리서치 결과" 참고. 둘 다 이 문서 범위에서는 뺌.)

## 0. 삭제/비활성화 리서치 결과 (완료, 삭제는 구현도 완료)

익스텐션 설치 후 **삭제**/**비활성화**가 가능한지 리서치한 결과:

- **삭제(uninstall) — 구현 완료**: `code-server --uninstall-extension <id>`가
  `--install-extension`과 완전히 같은 형태로 존재함(VS Code CLI 표준, code-server가
  그대로 미러링 — `code.visualstudio.com/docs/configure/command-line` 문서로 확인).
  안전하게 구현 가능하다고 판단해서 바로 구현함:
  `internal/extensions.Uninstall()`(`Install()`과 거의 동일한 구조) +
  `DELETE /api/code-extensions/{id}` 핸들러 + `Extensions.tsx`의 삭제 버튼
  (`window.confirm` 확인 다이얼로그 포함, 파괴적 프론트엔드 액션 컨벤션 준수).
  게이트는 install과 동일하게 안 걸음(`archive/authgate-plan-done.md`의 "extensions
  쓰기는 범위 밖" 기존 판단과 일관).
- **비활성화(disable) — 구현 안 함, 의도적으로 보류**: `--disable-extensions`
  (복수형) 플래그는 있지만 이건 실행 시점에 **전체** 익스텐션을 끄는 launch-time
  플래그이지, 개별 익스텐션을 영속적으로 켜고 끄는 기능이 아님. 개별 활성/비활성
  상태는 VS Code가 `<user-data-dir>/User/globalStorage/state.vscdb`라는
  SQLite DB에 저장함(구버전은 `storage.json`) — 이 포맷은 공식 문서화가 안 돼
  있고 VS Code 버전에 따라 이미 한 번 바뀐 이력이 있어서(storage.json →
  state.vscdb), 여기에 직접 쓰는 코드를 만드는 건 다음 VS Code 업데이트에 깨질
  위험을 안고 가는 것. 그만큼 이득이 크지 않다고 판단해 미구현으로 결정.
  (출처: `coder/code-server` GitHub 이슈 #7601, code-server FAQ)

## 1. 검색/URL 붙여넣기로 설치

### 요구사항 (사용자 설명 그대로)

- 검색해서 설치하는 옵션 — 마일스톤(당장 안 해도 됨, 나중에 하면 편하니 설계는
  미리 해두자는 요청).
- **URL 붙여넣기 설치가 더 중요한 요청**: 앞뒤로 타이틀이나 부가 텍스트가 붙어
  있어도(즉 사용자가 "이거 설치해줘: https://marketplace.visualstudio.com/items?
  itemName=foo.bar 부탁" 같은 텍스트를 통째로 붙여넣어도) `https://` 뒤의 일반적인
  레지스트리 URL을 파싱해서 설치.
- 마이크로소프트 공식 마켓플레이스 URL이면, 같은 id를 **open-vsx**에서 찾아봄
  (code-server는 open-vsx에서만 설치 가능 — MS 마켓플레이스는 라이선스상
  code-server/VS Codium 계열에서 직접 못 씀, 이게 애초에 이 프로젝트가
  `--install-extension`으로 open-vsx를 쓰는 이유이기도 함).
- open-vsx에 없으면 사용자에게 "오픈 레지스트리에 없다"고 안내.
- **폴백(선택)**: MS 마켓플레이스에서 직접 `.vsix` 파일을 받아와서 로컬 설치하는
  방법이 있으면, 그 방법으로 설치할지 사용자에게 물어봄.

### URL 파싱

- **open-vsx**: `https://open-vsx.org/extension/<publisher>/<name>` 형태 —
  정규식으로 `publisher`/`name` 바로 추출 가능, id는 `<publisher>.<name>`.
- **MS 마켓플레이스**: `https://marketplace.visualstudio.com/items?itemName=
  <publisher>.<name>` — 쿼리스트링에서 `itemName` 파라미터가 이미 `publisher.name`
  형식 그대로임, 파싱 쉬움.
- 파싱 자체는 정규식 하나로 URL을 통짜 텍스트에서 찾아내면 됨(`https://[^\s]+`류
  매치 후 위 두 패턴 중 하나로 재매치) — 새 의존성 불필요.

### open-vsx 교차 조회

open-vsx는 공개 REST API가 있음(`GET https://open-vsx.org/api/<publisher>/<name>`
형태로 메타데이터 조회 가능, 없으면 404) — **백엔드가 이 요청을 대신 해줘야 함**
(브라우저에서 직접 호출하면 CORS 문제 가능성 + 어차피 설치 자체도 백엔드가
하므로 조회도 같은 곳에서 하는 게 자연스러움). 새 백엔드 엔드포인트 필요, 예:
`GET /api/code-extensions/lookup?url=<붙여넣은 텍스트>` → URL 파싱 + open-vsx
조회 결과(`{found: bool, id, label?, description?, homepage?}`) 반환.

### MS 마켓플레이스 vsix 직접 설치 폴백

MS 마켓플레이스는 비공식적으로 `.vsix` 직접 다운로드 URL 패턴이 알려져 있음
(예: `https://<publisher>.gallery.vsassets.io/_apis/public/gallery/publisher/
<publisher>/extension/<name>/<version>/assetbyname/Microsoft.VisualStudio.
Services.VSIXPackage` 류 — **정확한 엔드포인트/버전 조회 방법은 착수 시점에
재확인 필요**, VS Code 마켓플레이스 API가 비공식이라 바뀔 수 있음). 받은 `.vsix`는
`code-server --install-extension <path-to.vsix>`로 로컬 파일 설치 가능(이미
`--install-extension`이 id뿐 아니라 로컬 경로도 받는다는 게 VS Code CLI 표준
동작). **라이선스 회색지대**이므로 자동으로 하지 않고 반드시 사용자에게 먼저
물어보고 동의를 받아야 함(사용자 요구사항에 이미 명시됨) — 이 경로를 기본값으로
켜두지 말 것.

## API 설계 (초안)

```
GET /api/code-extensions/lookup?text=<붙여넣은 텍스트 전체>
  → {matched: bool, source: "open-vsx"|"marketplace"|null, id: string|null,
     openVsx: {found: bool, label?, description?, homepage?} | null}
  marketplace URL이 매치됐는데 open-vsx에 없으면 openVsx.found=false로 내려줌
  (여기까지는 새 의존성/설치 없이 조회만 — 안전)

POST /api/code-extensions/install-vsix   body {id, version}
  → marketplace에서 vsix 직접 다운로드 + 로컬 설치(사용자가 폴백에 명시적으로
    동의한 뒤에만 프론트가 호출) — 비밀번호 게이트는 필요 없어 보임(설치 자체는
    이미 다른 익스텐션 설치와 동일 위험도, `archive/authgate-plan-done.md`의 "extensions
    쓰기는 범위 밖" 판단과 일관되게 안 건 채로 두는 게 맞아 보이나 최종 판단은
    구현 시점에 재확인)
```

## 남은 질문 (착수 시 정하면 됨)

- 검색(자유 텍스트로 open-vsx 전체 검색) UI를 URL 붙여넣기와 같은 화면에 둘지,
  별도 탭/모달로 분리할지.
- vsix 직접 설치 폴백의 정확한 다운로드 URL 패턴 재확인(비공식 API라 변경 위험).

## 참고

- `.claude/archive/extensions-plan-done.md` — 기존 구현(설치, open-vsx "더 보기"
  링크).
- `.claude/archive/mise-plan-done.md` — mise 쪽에도 같은 "더 보기" 링크
  아이디어가 계획만 되어 있음(`mise registry --json` 홈페이지 필드 지원 여부
  미확인).
