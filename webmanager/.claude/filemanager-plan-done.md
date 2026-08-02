# 파일 매니저 (File Manager) — 구현 완료

## 구현 완료 (2026-08-02)

이 문서의 설계대로 build-custom 방향으로 구현 완료. 백엔드: `internal/files`
(`ResolvePath` 등 경로 검증, 심볼릭 링크 재검증, `unix.Statx` best-effort
생성 시각, 텍스트/바이너리 판별, 스트리밍 업로드/다운로드, `os.Rename`+`EXDEV`
폴백) + `handlers_files.go`(문서의 API 설계 절 그대로: list/stat/download/
content(GET·PUT)/upload/mkdir/rename/move/copy/delete). `internal/authgate`
(argon2id + ENV 전용 저장 + `/etc/environment` 교차검증, 세션 쿠키) 신규 —
`terminal-plan.md`가 설계해둔 메커니즘을 일반화, 터미널과 파일 매니저가
공유(`WEBMANAGER_AUTH_PASSWORD_HASH` 하나). `server.go`의 `limitRequestBody`가
업로드 라우트만 예외 처리하도록 수정. 프론트: `src/components/FileManager/`
(브레드크럼, 멀티선택, 정보 패널, `LazyCodeEditor` 재사용 편집), `common/
RequiresUnlock.tsx`(범용 잠금 래퍼, 나중에 터미널 탭에도 씌울 수 있게 설계).

**아래 "사용자 확인 필요" 항목은 구현 시점에 기본값으로 처리함**(전부
`attention-needed.md`에 기록): 루트 `/code`(전체 `/` 아님), 업로드 상한 2GiB,
zip 디렉토리 다운로드는 이번 라운드에 미포함(파일 단위만), 비밀번호는 터미널과
공유.

실컨테이너(`docker compose build && up`) 검증은 아직 안 했으나, 로컬 스모크
테스트(경로 탈출 차단/게이트 on-off/CRUD 전부)는 실제 서버 프로세스로 완료.
`go build`/`go vet`/`gofmt`, `npm run build`/`npm run lint` 전부 클린.

---

# 원 리서치 문서 (구현 전 작성)

이번 라운드는 사용자 요청으로 **리서치 + 설계만** 진행(구현은 backend/frontend 둘 다
전혀 손대지 않음). 목표: 컨테이너 파일시스템을 code-server가 지금 열어둔 프로젝트
폴더 하나에 국한되지 않고 브라우징(업로드/다운로드/삭제/이동/복사/이름변경/폴더
생성, 멀티선택, 텍스트 편집, 권한/시각 정보 패널)할 수 있는 새 탭 — `/code` 바깥,
프로젝트에 안 속한 임의 경로까지 닿는 게 핵심 요구사항. **이 기능은 webmanager
전체에서 가장 큰 단일 위험 표면(임의 파일시스템 read/write/delete)이라 다른 모든
탭과 달리 자체 비밀번호 게이트가 필수 전제조건**(아래 "비밀번호 게이트" 절).

## 결론 요약: Build Custom 권장 (filebrowser 계열 채택 비권장)

리서치 전엔 "괜찮게 모듈화된 기성품이 있으면 그걸 쓰자"는 게 출발점이었는데,
실제로 조사해보니 **유일하게 성숙한 후보(filebrowser/filebrowser)가 하필 지금
이 시점에 사실상 폐기 수순 + 미패치 RCE를 안고 있어서 채택이 명백히 기각됨**,
활발히 유지되는 포크(gtsteffaniak/filebrowser, "Quantum")는 기술적으로는
가능하지만 이 저장소의 최소 의존성/일관된 커스텀 빌드 원칙과 스코프가 크게
어긋나고 통합 비용도 실재함. 아래 "리서치" 절에 근거, "API 설계"/"보안" 절에
build-custom을 택했을 때의 구체안이 있음.

## 알려진 것 (전제)

- 이미 있는 관련 인프라:
  - `webmanager/.claude/terminal-plan.md`의 **argon2id + ENV 전용 저장 +
    `/etc/environment` 교차검증** 비밀번호 게이트 — 방향은 확정, 아직 구현 전.
    이 문서가 쓰인 시점에 "이걸 재사용 가능한 `RequirePassword` 미들웨어로
    일반화하는" 병행 작업이 별도로 진행 중이라고 전달받음 — 파일 매니저는 그
    미들웨어가 나오는 대로 라우트에 그대로 감싸면 됨(직접 짜지 않음).
  - `src/components/common/LazyCodeEditor.tsx` — CodeMirror 기반 텍스트 에디터가
    이번 세션 병행 작업으로 이미 만들어지는 중(`lazy(() => import('./CodeEditor'))`,
    `CodeEditorProps`/`CodeEditorLanguage` 타입 export). 파일 매니저는 이 컴포넌트를
    그대로 가져다 쓰면 됨 — 에디터 자체를 새로 설계할 필요 없음, "파일 선택 →
    텍스트로 판단되면 `LazyCodeEditor` 패널/다이얼로그 렌더 → 저장 시
    `PUT /api/files/content` 호출"만 붙이면 됨.
  - `src/components/Layout/sections.ts` — 탭 등록 지점(`SectionId`에 `'files'` 추가,
    `SECTIONS` 배열에 `{ id: 'files', label: '파일', implemented: false }` 형태로
    시작하는 게 기존 dind/terminal 항목과 같은 패턴).
  - `backend/server.go`의 `limitRequestBody` 미들웨어가 **모든 요청 바디를 1MiB로
    캡**하고 있음 — 업로드 엔드포인트는 이 제한을 그대로 받으면 안 됨(아래 "스트리밍"
    절), 라우팅 시점에 이 미들웨어를 우회하거나 별도 큰 상한을 적용해야 함.
  - `webmanager/review.md`의 기존 경로검증 사고 이력: git SSH host의 `filepath.Join`
    미검증 path traversal(critical, 이미 고침), GPG keyId 플래그 인젝션 등 — 이
    저장소가 "임의 문자열이 파일 경로/exec 인자에 들어가기 전엔 반드시 검증"이라는
    원칙을 이미 실제 사고로 학습한 상태. 파일 매니저는 그 원칙이 가장 직접적으로
    적용되는 기능.
  - 기존 경로검증 관례 두 가지가 있는데 **둘 다 파일 매니저엔 그대로 안 맞음**(아래
    "경로 검증" 절에서 왜 새 패턴이 필요한지 설명):
    - `internal/gitconfig/sshhosts.go`류: 고정 포맷 식별자를 정규식으로 화이트리스트
      (`^[A-Za-z0-9._-]+$`) — 파일 매니저의 경로는 임의 깊이의 실제 디렉토리 트리라
      단순 정규식으로 못 막음.
    - `handlers_projects.go`의 `path` 파라미터: Projects 캐시에 이미 들어있는
      **정확히 일치하는 경로만** 허용(사전에 스캔된 유한 목록과 대조) — 파일
      매니저는 애초에 "사전에 알 수 없는 임의 경로를 브라우징"하는 게 목적이라
      이 패턴 자체를 못 씀.

## 리서치: 기성 파일매니저 프로젝트 채택 검토

### filebrowser/filebrowser (canonical) — 채택 불가

- Go 백엔드 + Vue 프런트, 단일 정적 바이너리(+ Docker 이미지) 배포, Apache-2.0,
  35.7k star. 리버스 프록시 서브패스 지원(`FB_BASEURL` env)까지 갖춘, 기능만
  보면 요구사항(업로드/다운로드/이름변경/이동/복사/멀티선택/텍스트편집/권한표시)을
  정확히 커버하는 성숙한 프로젝트였음.
- **그런데 리서치 시점 기준 2026-09-01부로 저장소 자체가 아카이브 예정이라고 이미
  공지됨**("no further releases, bug fixes, or security fixes") — 사실상
  단종/미유지보수 소프트웨어가 되는 게 확정된 상태.
- **미패치 취약점이 이미 공개돼 있음**: `CVE-2026-32759`(TUS 재개형 업로드
  핸들러가 `Upload-Length`를 부호 있는 64비트로 파싱하면서 음수값 검증을 안 해
  업로드 완료 조건을 즉시 만족시켜버리는 RCE 경로, 수정 버전 없음),
  `CVE-2026-54096`(존재하지 않는 경로에 대해서도 공개 공유 링크를 미리 만들 수
  있어서 나중에 그 경로에 파일이 생기면 그 공유가 즉시 유효해지는 접근제어
  결함, 1.11.0까지 미해결). 프로젝트 자체가 "command execution/runner/hooks"
  이슈 클래스는 **아예 고치지 않겠다**고 명시.
- 자체 README의 보안 안내조차 "직접 인터넷에 노출하지 말고 리버스 프록시 뒤에서
  자체 인증까지 갖춰 써라"는 톤이라, 애초에 "공유 비밀번호 하나로 충분"한 단순
  신뢰 모델을 상정하지 않음(내장 인증은 유저 계정 + JWT 세션 기반, 세션
  무효화/로그아웃 처리에도 알려진 결함이 있음 — 로그아웃/비밀번호 변경 후에도
  기존 토큰이 만료 전까지 계속 유효).
- **결론**: 이 기능이 굳이 자체 비밀번호 게이트까지 요구하는 이유가 "블라스트
  반경을 최소화하기 위해서"인데, 그 자리에 EOL + 미패치 RCE 소프트웨어를 앉히는
  건 그 목적과 정면으로 배치됨. 기각.

### gtsteffaniak/filebrowser ("FileBrowser Quantum") — 기술적으론 가능하나 비권장

- filebrowser/filebrowser의 활발한 포크. Apache-2.0, 단일 바이너리 + Docker 이미지
  (`gtstef/filebrowser`), `config.yaml` 기반 설정으로 재구성됨. 커밋 이력/스타 수로
  보면 실제로 활발히 유지되는 프로젝트.
- 인증: OIDC, LDAP, password+2FA(TOTP), **proxy 인증**(업스트림 리버스 프록시가
  준 헤더, 예 `X-Forwarded-User`를 신뢰), JWT 검증 등 — proxy 모드를 쓰면
  이론적으로 webmanager의 (앞으로 나올) `RequirePassword` 미들웨어가 비밀번호
  검증을 통과시킨 뒤 해당 헤더를 주입하는 식으로 얹을 순 있음.
- 기능은 요구사항을 초과함: 썸네일/오피스 미리보기(이번 요구사항엔 **명시적으로
  스코프 밖**), 공유 링크, 실시간 검색 인덱싱, 멀티유저 디렉토리별 권한 — 개인
  단일 사용자 devbox엔 과한 표면적.
- **통합 비용이 실재함**: 별도 프로세스로 붙이려면 (1) 새 supervisord program +
  Dockerfile 스테이지 + 자기 포트, (2) webmanager 쪽에 `httputil.ReverseProxy`
  핸들러를 새로 짜서 `RequirePassword`로 감싸고 그 안쪽에서 Quantum의 자체 로그인은
  끄거나(예: `noauth`/`proxy` 모드로 전환) 우회, (3) 그 프런트를 webmanager 탭
  안에 iframe으로 얹기(X-Frame-Options/CSP `frame-ancestors` 설정을 Quantum 쪽에서
  맞춰줘야 함) — 이 정도 글루를 다 감수해도 여전히 CodeEditor 재사용(iframe
  안쪽은 Quantum 자신의 에디터를 쓰게 됨, `LazyCodeEditor`를 못 씀), 탭 UX 일관성
  (다른 탭과 다른 룩앤필), 멀티선택/삭제 확인창 문구 스타일 등은 못 맞춤.
- 이 저장소가 이미 보여준 태도(`dind-plan.md`: 공식 Docker SDK조차 "직접 필요한
  기능(list/start/stop/remove/logs)에 비해 의존성 트리가 과하다"는 이유로 CLI
  셸아웃을 택함)에 비춰보면, 통째로 별도 웹앱 + 자체 유저DB(bbolt) + 인증 시스템을
  들이는 건 그보다 훨씬 무거운 선택.
- **결론**: 기각까지는 아니지만(진짜 채택하고 싶다면 기술적으로 막혀있진 않음),
  build-custom 대비 이점이 뚜렷하지 않아 권장하지 않음.

### 프런트엔드 전용 React 파일매니저 컴포넌트 (참고, 백엔드는 어차피 직접 구현)

`chonky`(원조, 마지막 배포가 5년 전 — 사실상 방치) / `chonky2`(개인 유지보수자의
비공식 포크, MUI 기반) 등이 있지만, 이 라이브러리들은 **백엔드 API를 전혀 제공하지
않음** — 즉 "채택"이 아니라 list/upload/download/삭제/이동/복사 API를 어차피
처음부터 다 직접 짜야 하는 채로 프런트 리스트/그리드 뷰 컴포넌트만 아끼는
선택지. 이 저장소가 지금까지 새 UI 라이브러리를 들인 유일한 선례(터미널의
`@xterm/xterm`)는 "char-cell 렌더링/ANSI 이스케이프 처리를 직접 짜는 게
비합리적"이라는 뚜렷한 이유가 있었던 예외였음 — 파일 리스트/그리드는 이미
Projects 탭 등에서 쓰는 일반 테이블/리스트 패턴으로 충분히 커버되는 난이도라 같은
예외를 정당화하기 어려움. **권장: 도입하지 않고 기존 테이블/리스트 컴포넌트
스타일로 직접 구현.** 나중에 드래그앤드롭/그리드 뷰 같은 UX가 아쉬워지면 그때
재검토.

## API 설계 (구현 전 상상, `dind-plan.md`/`mise-plan-done.md` 형식 참고, 재검토 필요)

루트 설정: `WEBMANAGER_FILES_ROOT`(기본값은 "사용자 확인 필요" 참고 — 컨테이너
전체(`/`) vs `/code`로 좁히는 선택 자체가 스코프 판단). 아래 모든 `path`는 이
루트 기준 절대경로 문자열.

```
GET  /api/files/list?path=<dir>
  → [{name, path, isDir, isSymlink, symlinkTarget?, size, mode: "-rw-r--r--",
      modTime}] — 디렉토리 목록 한 단계(재귀 아님), path 생략 시 루트

GET  /api/files/stat?path=<file-or-dir>
  → {name, path, isDir, isSymlink, size, mode, modeOctal, uid, gid,
     owner?, group?, modTime, changeTime,
     createdTime?: string, createdTimeAvailable: bool}
  정보 패널(권한/생성·수정 시각) 전용 — "생성 시각" 필드가 왜 optional/available
  플래그를 갖는지는 아래 "info 패널: 생성 시각" 절 참고 (review.md #9의
  `available: bool` 패턴 재사용).

GET  /api/files/download?path=<file>
  → Content-Disposition: attachment 스트리밍(아래 "스트리밍" 절). 디렉토리
  다운로드(zip)는 v1 포함 여부가 "사용자 확인 필요" 항목.

GET  /api/files/content?path=<file>
  → {content: string, truncated: bool} — 텍스트 판단/크기 상한 실패 시 400
  (아래 "텍스트 판별" 절). LazyCodeEditor 프리로드용.

PUT  /api/files/content   body {path, content}
  → 텍스트 파일 저장. 임시파일에 쓰고 `os.Rename`으로 교체(원자적 쓰기,
  저장 중 프로세스가 죽어도 원본이 반쯤 잘린 상태로 남지 않게).

POST /api/files/upload   multipart/form-data, fields: dir=<대상 디렉토리>,
                          files=<하나 이상의 파트>
  → 스트리밍 업로드(아래 "스트리밍" 절). 응답 {results: [{name, ok, error?}]}
  (부분 실패 시에도 나머지는 계속 진행 — CLAUDE.md ground rule의 "부분 실패는
  전체 요청 실패보다 열화"를 그대로 따름).

POST /api/files/mkdir   body {path}

POST /api/files/rename   body {path, newName}
  → 같은 디렉토리 안에서 이름만 변경(`os.Rename`)

POST /api/files/move   body {items: [srcPath...], destDir}
POST /api/files/copy   body {items: [srcPath...], destDir}
  → 멀티선택 대상 벌크 처리. 응답 {results: [{path, ok, error?}]}(부분 실패 허용,
  위와 동일 패턴). move는 `os.Rename` 우선 시도, `EXDEV`(cross-device)면 copy+
  delete로 폴백(아래 "원자적 이동" 절). copy는 디렉토리면 재귀 복사.

POST /api/files/delete   body {items: [path...]}
  → 재귀 삭제(`os.RemoveAll`). **프런트: 예외 없이 confirm 다이얼로그**
  (CLAUDE.md ground rule — Supervisor 탭 사고 전례 반복 금지). 응답은 위와
  동일한 부분 실패 허용 패턴.
```

인증: 위 전 라우트는 `RequirePassword` 미들웨어(terminal-plan.md에서 나올 예정)로
감싼다 — 이 문서에서 새로 설계하지 않음, 그게 나오는 시점에 그대로 wrap.

## 경로 검증 (가장 보안이 중요한 부분)

**결론**: `filepath.Clean` 정규화 후 `filepath.Rel`로 설정된 루트 기준 상대경로를
구하고, 그 결과가 `".."`이거나 `".."+구분자`로 시작하면 거부 — 이 저장소의
"임의 문자열이 파일 경로에 들어가기 전엔 반드시 검증, escape보다 reject 우선"
원칙(review.md)을 그대로 따르되, Projects의 "사전 목록과 정확히 일치"나
gitconfig의 "고정 포맷 정규식" 패턴은 임의 트리 브라우징엔 못 쓰므로 **이 기능
전용의 새 검증 헬퍼(`internal/files/path.go`류, 가칭 `ResolvePath(root, userPath)
(string, error)`)가 필요**함을 명시해둠. 의사코드:

```go
func ResolvePath(root, userPath string) (string, error) {
    cleaned := filepath.Clean(userPath)
    if !filepath.IsAbs(cleaned) {
        return "", errInvalidPath
    }
    rel, err := filepath.Rel(root, cleaned)
    if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
        return "", errInvalidPath
    }
    return cleaned, nil
}
```

단순 `strings.HasPrefix(cleaned, root)` 문자열 비교는 흔한 함정(`/code-evil`이
`/code`로 시작한다고 오판)이라 쓰지 않고, `filepath.Rel` 기반 비교로 구분자 경계를
정확히 맞춘다. 삭제/이름변경/이동의 **source가 루트 자기 자신(`rel == "."`)인
경우는 별도로 명시 거부**(설정된 루트 자체를 삭제/이동하는 걸 막는 가드).

## 심볼릭 링크

- 목록(`list`)에서는 심볼릭 링크를 있는 그대로 보여주되(`isSymlink: true`,
  `symlinkTarget`은 `os.Readlink`로 채움) 자동으로 따라 들어가지 않음 — 링크
  엔트리 자체를 보여주고, 사용자가 그 안으로 "들어가기"를 시도하는 순간(다음
  `list` 호출의 `path`가 그 링크 경로가 되는 순간)에만 실제로 열림.
- 링크를 열거나(`stat`/`list`/`content`/`download`) 그 안에 쓰기 작업을 할 때는
  `filepath.EvalSymlinks`로 실제 경로를 구한 뒤, **그 결과에 대해서도 위
  `ResolvePath`와 동일한 루트 검증을 다시 수행**한다 — 링크가 설정된 루트
  바깥을 가리키면 거부.
- 루트가 `/`(컨테이너 전체)로 설정된 기본값(아래 "사용자 확인 필요" 참고)에서는
  이 검증이 사실상 항상 통과(전체가 이미 스코프 안)라 실질적 영향이 없지만,
  운영자가 나중에 루트를 `/code`처럼 좁히면 바로 의미가 생기는 방어 조건이므로
  처음부터 넣어두는 걸 권장(YAGNI로 미루면 나중에 빠뜨리기 쉬운 종류의 검증).

## 스트리밍 업로드/다운로드 (메모리 버퍼링 회피)

- **다운로드**: `os.Open` + `http.ServeContent`(Range 요청/If-Modified-Since를
  공짜로 얻음) 또는 수동으로 `io.Copy(w, f)` — 파일 전체를 메모리에 올리지 않음.
  `Content-Disposition: attachment; filename="..."`은 파일명에 개행/따옴표가
  섞이지 않도록 이스케이프 필요(`mime.QEncoding`류 또는 `net/http`의
  `ServeContent`가 처리 못 하는 부분은 직접 sanitize).
- **업로드**: `r.ParseMultipartForm`(전체를 메모리/임시파일에 먼저 파싱)이 아니라
  **`r.MultipartReader()`로 파트 단위 스트리밍**을 써서, 각 파트를 `io.Copy(dst,
  part)`로 목적 파일에 직접 흘려보낸다 — 큰 파일이어도 힙에 안 올라감.
- **`server.go`의 `limitRequestBody`(전체 요청 1MiB 캡) 회피 필요**: 이 캡은
  SSH 키 붙여넣기 같은 작은 JSON 바디를 전제로 만들어진 기존 미들웨어라 업로드
  라우트엔 그대로 적용하면 안 됨. 업로드 라우트는 이 미들웨어를 건너뛰거나
  (라우팅 시점에 미적용), 별도의 훨씬 큰 상한(`WEBMANAGER_FILES_MAX_UPLOAD_BYTES`,
  기본값은 "사용자 확인 필요")을 `http.MaxBytesReader`로 새로 씌운다.

## 원자적 이동/이름변경, 재귀 복사, cross-device 주의

- 이름변경/같은 파일시스템 안에서의 이동은 `os.Rename` 하나로 원자적(디렉토리
  트리 전체가 통째로 옮겨짐, 재귀 복사 불필요).
- `os.Rename`은 **다른 파일시스템/디바이스 사이에서는 실패**(`EXDEV`) — 이
  컨테이너는 `/code`가 별도 바인드 마운트(`./code:/code`, 루트 `docker-compose.yml`)
  이고 나머지는 이미지 자신의 오버레이 파일시스템이라, **`/code` 안에서의 이동/
  `/code` 바깥 어딘가 안에서의 이동은 각각 문제 없지만 `/code` ↔ 컨테이너의
  나머지 부분 사이를 이동하면 `EXDEV`가 날 가능성이 실재함**(예: 루트를 `/`로
  설정한 뒤 `/code/foo`를 `/tmp/foo`로 옮기는 경우). 흔한 경로는 아니지만 공짜로
  막을 수 있는 문제이므로, `os.Rename`이 `EXDEV`를 반환하면 재귀 복사 + 원본
  삭제로 폴백하는 방어 코드를 처음부터 넣는 걸 권장.
- 디렉토리 복사(`copy` 엔드포인트)는 애초에 `os.Rename` 대상이 아니라 처음부터
  `filepath.WalkDir` + 파일마다 `io.Copy` + `os.Chmod`(원본 권한 보존)로 구현.

## info 패널: 권한/생성·수정 시각

- 권한: `os.FileInfo.Mode()`의 문자열 표현(`-rw-r--r--`)과 8진수 둘 다 노출.
- uid/gid: Linux 전용이라 `info.Sys().(*syscall.Stat_t)`로 꺼냄(다른 셸아웃
  기반 기능들과 달리 이건 순수 stdlib syscall — 이 저장소가 Linux 전용
  컨테이너라는 전제와 일치). 사용자명/그룹명으로 보여주고 싶으면 `os/user.
  LookupId`/`LookupGroupId`(둘 다 stdlib, 새 의존성 없음) — 다만 컨테이너 안엔
  root 하나뿐이라 실질 가치는 낮음, 굳이 안 해도 됨.
- **"생성 시각"은 Linux에서 신뢰하기 까다로운 필드**: `os.FileInfo.ModTime()`은
  수정 시각(mtime)뿐이고, 진짜 "파일이 최초로 만들어진 시각"(birth time/`btime`)은
  파일시스템이 지원해야만(`statx()`의 `STATX_BTIME`, ext4/btrfs 등 최신
  파일시스템 + 커널 4.11+에서 조건부 지원) 얻을 수 있음 — `/code`가 실제로 어떤
  호스트 파일시스템에 마운트되는지는 운영자 환경마다 다르고, 컨테이너 자신의
  오버레이 파일시스템(`overlay2` 등)에 있는 경로는 이 필드를 아예 못 주는 경우가
  흔함. **권장**: `golang.org/x/sys/unix`의 `Statx`로 `STATX_BTIME`을
  best-effort로 시도(이 패키지는 `gopsutil`을 통해 이미 `go.sum`에 간접
  의존성으로 들어와 있어서, 직접 의존으로 승격해도 **새 의존성 추가가 아님**),
  실패/미지원이면 `createdTimeAvailable: false` + `changeTime`(ctime, "메타데이터가
  마지막으로 바뀐 시각" — 진짜 생성 시각은 아니지만 최소한 존재하는 값)으로
  대체 노출 — `review.md` #9(`/api/system/resources`의 "못 읽음"과 "진짜 0"을
  구분 못 했던 버그, `available: bool` 필드로 고침)와 정확히 같은 패턴 재사용.

## 텍스트 판별 (LazyCodeEditor로 넘기기 전)

`GET /api/files/content`는 파일이 "텍스트로 보여줘도 안전한지"부터 판별해야
함 — 바이너리 파일을 그대로 문자열로 보내면 프런트가 깨진 내용을 보여주거나
JSON 인코딩이 깨짐. 권장: 앞부분 N바이트(예 512바이트, `http.DetectContentType`과
동일한 관례)를 읽어 NUL 바이트 포함 여부로 1차 판별(`net/http`의
`DetectContentType` 자체를 참고용으로 같이 써도 됨) + 크기 상한(예 5MB, 초과 시
400 "파일이 너무 큼" — 에디터에 통째로 올리기엔 비합리적인 크기). 새 의존성 없이
stdlib만으로 충분.

## 프런트엔드 통합 지점

- `src/components/Layout/sections.ts`에 `'files'` 섹션 추가(`implemented: false`로
  시작).
- 새 `src/components/FileManager/` — 다른 탭들과 동일하게 리스트/테이블 뷰(디렉토리
  브라우징 + 브레드크럼), 멀티선택 체크박스, 사이드바/패널에 `stat` 응답 표시.
  그리드/썸네일 뷰는 요구사항에서 명시적으로 스코프 밖.
- 텍스트 파일 선택 시 `src/components/common/LazyCodeEditor.tsx`의
  `LazyCodeEditor`(`CodeEditorProps`)를 그대로 렌더 — 새 에디터를 만들지 않음,
  로드(`GET /api/files/content`)/저장(`PUT /api/files/content`) 콜백만 이 기능이
  붙임.
- 삭제/이동/덮어쓰기 등 파괴적 액션 전부 `window.confirm` 필수(ground rule,
  예외 없음) — 특히 벌크 삭제는 "N개 항목을 삭제하시겠습니까" 같은 개수 명시 문구
  권장.
- `attention-needed.md`에 이미 기록된 "프런트 번들 500KB 청크 경고" 항목과 직결됨
  — 파일 매니저 탭도 다른 무거운 탭들처럼 `React.lazy` 동적 import로 시작하는 걸
  권장(터미널/CodeEditor가 이미 그 패턴을 씀).

## 비밀번호 게이트 의존성 (필수 — 이 게이트 없이는 출시하지 않음)

이 기능은 **`terminal-plan.md`가 설계해둔 argon2id + ENV 전용 저장 +
`/etc/environment` 교차검증 메커니즘을 일반화한 `RequirePassword`(가칭) 미들웨어가
먼저 존재해야 착수 가능**함을 이 문서에서 다시 한번 명시함. 파일 매니저 전용으로
새 인증 메커니즘을 따로 설계하지 않음 — 그 미들웨어가 나오는 시점에 위 API 설계
절의 모든 `/api/files/*` 라우트를 그대로 감싸는 것으로 끝나야 함. 터미널 문서가
이미 "이 게이트를 터미널 전용으로 할지 webmanager 전체로 넓힐지"를 열린 질문으로
남겨뒀는데, 파일 매니저가 두 번째로 같은 급의 게이트를 필요로 하는 기능이 됨에
따라 **웹쉘 전용이 아니라 처음부터 여러 라우트 그룹에 재사용 가능한 일반
미들웨어로 설계하는 쪽의 근거가 하나 더 늘어난 셈** — 다만 실제로 두 기능이
비밀번호를 공유할지(같은 env var 하나) 아니면 각자 별도 해시를 가질지는 여전히
사용자 판단(아래 "사용자 확인 필요").

README/`webmanager/CLAUDE.md`의 보안 각주(dind/터미널을 "webmanager에서 가장
강력한 권한"으로 명시한 부분)에 파일 매니저도 동급으로 추가해야 함 — 구현
착수 시 반영.

## 구현 시 확인할 것 (착수 시점에 정하면 됨, 지금 안 막힘)

- 정확한 `internal/files` 패키지 분할(list/stat/upload/download/mutate를 파일
  몇 개로 나눌지) — 다른 `internal/*` 패키지들과 비슷한 크기가 될 걸로 예상.
- `mode`를 `os.FileMode.String()` 그대로 노출할지, chmod 변경 기능까지 v1에
  넣을지(요구사항에 명시적으로 없었음 — 이 문서 스코프 밖으로 가정, 필요하면
  별도 라운드).
- 업로드 중 진행률 표시 여부(현재 다른 기능들의 폴링 패턴처럼 "잡 상태 조회"로
  갈지, 아니면 단순 스피너로 v1을 끝낼지) — mise 잡 스트리밍과 달리 업로드는
  브라우저가 이미 진행률 이벤트(`XMLHttpRequest.upload.onprogress`)를 표준으로
  주므로 백엔드에 별도 잡 스토어가 필요 없을 가능성이 높음, 착수 시 확인.
- 디렉토리 목록에 숨김 파일(`.`으로 시작) 기본 표시 여부/토글 UI.

## 사용자 확인 필요

- **`WEBMANAGER_FILES_ROOT` 기본값: 컨테이너 전체(`/`) vs `/code`로 좁힐지.**
  요구사항 자체가 "code-server가 연 프로젝트 폴더 하나에 국한되지 않고, `/code`나
  그 바깥까지 닿아야 한다"고 명시했으므로 이 문서는 기본값을 **`/`(전체)**로
  가정하고 설계했음(webmanager가 이미 root로 돌고 있어 권한상 새로운 노출은
  아님) — 그래도 "전체 컨테이너 파일시스템을 브라우징 가능하게 만든다"는 건
  체감 임팩트가 커서 순수 스코프 판단으로 남겨둠. env var 자체는 넣어두므로
  운영자가 언제든 좁혀 쓸 수 있음.
- **업로드 용량 상한(`WEBMANAGER_FILES_MAX_UPLOAD_BYTES`) 기본값**: 스트리밍
  구현이라 상한 자체가 안전을 위한 것(디스크 고갈 방지 defense-in-depth)이지
  기술적 제약은 아님 — 몇 GB로 잡을지는 취향.
- **디렉토리 다운로드(zip) 지원을 v1에 포함할지**: `archive/zip`(stdlib, 새
  의존성 없음)으로 구현 가능하지만, 스트리밍 중 압축이라 진행률 표시가 파일
  단일 다운로드보다 복잡해짐 — v1에서 뺴고 파일 단위 다운로드만 먼저 낼지 판단
  필요.
- **비밀번호 게이트를 터미널과 공유할지, 파일 매니저 전용 별도 해시로 할지**:
  terminal-plan.md가 이미 열어둔 질문("터미널 전용 vs webmanager 전체")이 이
  문서로 두 번째 후보가 생기면서 더 구체화됨 — 공유하면 env var 하나로 두 기능
  다 게이트되고(운영 단순), 분리하면 각 기능을 독립적으로 열고 닫을 수 있음
  (예: 터미널은 신뢰하지만 파일 매니저는 당분간 꺼두고 싶은 경우).
- **"생성 시각" 필드를 UI에 어떻게 보여줄지**: `createdTimeAvailable: false`인
  경우(흔할 걸로 예상, 위 "info 패널" 절 참고) 필드 자체를 숨길지, "확인 불가"로
  표시할지, ctime을 대체값으로 보여주며 "정확한 생성 시각 아님"이라고 라벨링할지는
  UX 판단.
- **심볼릭 링크를 브라우징 UI에서 어떻게 표시할지**: 보안 검증(루트 이탈 재확인)은
  이 문서가 이미 확정했지만, 링크 아이콘/타겟 경로 표시 방식, 깨진 링크(타겟이
  없는 심볼릭 링크) 처리 UX는 취향 판단.
