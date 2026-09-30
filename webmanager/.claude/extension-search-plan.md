# 익스텐션 검색/URL 설치 (URL 붙여넣기 설치 구현 완료, 검색은 미착수)

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

**상태**: URL 붙여넣기 설치(URL 파싱 + open-vsx 교차 조회 + vsix 폴백)는 구현
완료 — 아래 "구현된 API"를 볼 것. 자유 텍스트 검색은 미착수(설계만 남아 있음).

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

## 구현된 API (URL 붙여넣기 설치)

```
GET /api/code-extensions/lookup?text=<붙여넣은 텍스트 전체>          (게이트 없음, 읽기)
  → {matched, source?: "marketplace"|"open-vsx"|"id", id?,
     openVsx?: {found, label?, description?, homepage?, version?},
     vsixFallback?: {host, maxBytes}}       // open-vsx에 없을 때만
  인식 못 하면 matched=false(200), id 형식이 깨졌으면 400, open-vsx에
  못 닿으면 502(= "없음"과 구분, 폴백을 권하지 않기 위해)

POST /api/code-extensions/install-vsix   body {id}                   (RequirePassword)
  → 마켓플레이스에서 최신 .vsix를 받아 검증 후 설치
```

- 파싱은 `internal/extensions/lookup.go`의 `ParseInput`. 통짜 텍스트가 bare id면
  그대로, 아니면 텍스트 안의 첫 마켓플레이스/open-vsx 아이템 URL. 호스트는
  정확 일치(`net/url`)만 인정하고, 어떤 경로든 최종 id는 `ValidateID`를 통과해야
  exec/URL에 닿음. 문장 속 bare id(`install foo.bar please`)는 일부러 안 집음.
- open-vsx에 있으면 기존 `POST /api/code-extensions`(같은 설치 버튼/진행 상태/재시작
  배너)로 설치 — 새 설치 경로 없음.
- vsix 폴백은 사용자가 확인 다이얼로그에서 동의한 뒤에만 프론트가 호출(출처
  호스트, 크기 상한, 라이선스 회색지대 문구 표시). 게이트는 이 계획 초안의
  "필요 없어 보임" 판단을 뒤집어 걸었음 — 임의 URL은 아니지만 서버가 외부 파일을
  받아 설치하는 쓰기 동작이라 일반 설치와 같은 등급으로 통일.
- **다운로드 URL 재확인 결과(2026-09-30)**: `https://marketplace.visualstudio.com/
  _apis/public/gallery/publishers/<pub>/vsextensions/<name>/latest/vspackage`가
  버전 조회 없이 최신본을 바로 줌(리다이렉트 없음). 응답은
  `Content-Encoding: gzip`이라 Go의 transport가 풀어주고, 헤더가 빠진 채 gzip
  본문만 오는 경우도 매직 바이트로 처리. 없으면 404. 상한 200MB(해제 후 기준),
  zip 여부 + `extension.vsixmanifest`/`extension/package.json` 존재 + package.json의
  publisher.name이 요청한 id와 같은지(대소문자 무시) 확인한 뒤 설치.
- 설치는 `--install-extension=<절대경로>` 형태. `--` 뒤에 경로를 두면 옵션 파싱이
  거기서 끝나 플래그 값이 비고 경로가 "열 파일"이 될 수 있어서 `=`로 붙임(경로는
  임시 디렉터리의 절대경로라 플래그로 오해될 수도 없음). 실제 code-server 바이너리로는
  확인하지 못함 — fake 바이너리로 인자 형태만 테스트.
- vsix로 설치한 익스텐션은 open-vsx에 없으니 code-server가 업데이트를 못 찾음.

## 남은 질문 (착수 시 정하면 됨)

- 검색(자유 텍스트로 open-vsx 전체 검색) UI를 URL 붙여넣기와 같은 화면에 둘지,
  별도 탭/모달로 분리할지. (URL 붙여넣기는 Extensions 탭 상단 "URL로 설치" 입력칸에
  들어가 있음 — 검색을 같은 입력칸에 붙일지 결정 필요.)
- 마켓플레이스 vspackage URL은 비공식이라 바뀔 수 있음 — 깨지면 `vsix.go`의
  `downloadVSIX` 한 곳만 고치면 됨.

## 참고

- `.claude/archive/extensions-plan-done.md` — 기존 구현(설치, open-vsx "더 보기"
  링크).
- `.claude/archive/mise-plan-done.md` — mise 쪽에도 같은 "더 보기" 링크
  아이디어가 계획만 되어 있음(`mise registry --json` 홈페이지 필드 지원 여부
  미확인).
