# code-server/mise 버전 관리 패널 (아이디어 단계 — 구현 안 함, 질문 정리용, 우선순위 최하)

> **이 문서는 구현하지 않는다.** `guide-plan.md`와 동일한 성격(아이디어 스케치 +
> 착수 전 결정 필요한 질문 목록) — 사용자가 "결정할 게 많으니 plan만 만들고
> 질문을 많이 달아두라"고 명시적으로 요청함. 우선순위는 `guide-plan.md`와 같은
> 최하 티어.

## 동기

mise로 설치한 도구들, code-server 자체, 그리고 이 이미지의 설치 스크립트
(`code-server-autoinstall`)가 각각 최신 상태인지 한눈에 보고 싶음. 백그라운드로
가끔 확인해두고, 탭에 들어가면 수동 새로고침도 가능하게. 추가로 "컨테이너 자체를
리빌드해야 하는 상황인가"까지 신호를 주고 싶은데, 그 판단 기준을 뭘로 잡아야
할지 사용자 본인도 확신이 없는 상태 — 이 부분이 이 문서의 핵심 미해결 질문.

## 조사 결과 (구현 전에 이미 확인해둔 사실 — 착수 시 재조사 불필요)

### code-server 바이너리는 이미 자동 업데이트되고 있음 — git pull 개념이 아님

`code-server-autoinstall/install.sh`를 직접 읽어 확인함: code-service가 시작될
때마다(1시간 쿨다운, `last-check` 파일로 스팸 방지) GitHub의
`coder/code-server` 최신 릴리즈 태그를 `curl`로 확인하고, 설치된 버전
(`installed-version` 파일)과 다르면 새 버전을 통째로 다운로드해서 교체함 —
**이미 자동 업데이트 메커니즘이 존재하고, 매 재시작마다 실행됨**. 즉 "code-server
업데이트 확인" 패널이 할 일은:
- `code-server-autoinstall/installed-version`(현재 설치된 버전)과 `last-check`
  (마지막 확인 시각)를 그냥 읽어서 보여주는 것 — 새로 구현할 로직 없음.
- "지금 확인" 버튼은 `last-check` 파일을 지우거나 과거로 되돌린 뒤
  `restart code-server`(기존 `restart` 명령과 동일 경로)를 트리거하는 정도로
  충분해 보임 — `install.sh`가 알아서 GitHub를 다시 확인하고 필요하면
  교체함. **재구현이 아니라 기존 스크립트를 다시 트리거하는 것**이라는 점이
  중요 — 이 패널이 자체적으로 "최신 릴리즈"를 다시 조회하는 로직을 만들
  필요가 없음.

### `code-server-autoinstall`은 git submodule — code-server 바이너리와는 별개 개념

이 디렉토리 자체(`qwreey/code-server-autoinstall`)는 루트 `CLAUDE.md`가 이미
"vendored dependency, treat as vendored 취급"이라고 명시한 별도 저장소를 가리키는
git submodule. 위에서 말한 "code-server 바이너리 자동 업데이트"는 이 스크립트
*안의* 로직이 하는 일이고, 스크립트 *자체*(install.sh, patch 시스템 등)의 새
버전을 받으려면 `git submodule update --remote` + **이미지 리빌드**가 필요함 —
webmanager가 실행 중인 컨테이너 안에서 자기 자신을 담은 이미지를 리빌드할 방법은
없음(아래 "컨테이너 리빌드 필요성" 절 참고). 즉 이 패널이 할 수 있는 최선은
"서브모듈에 새 커밋이 있다"는 사실을 알려주는 것까지고, 실제 갱신은 사용자가
호스트에서 `git submodule update --remote && docker compose build && up`을
직접 해야 함.

### mise 자체는 이 레포가 설치하지 않음

`config/build.default.sh`(pacman 패키지 목록), `Dockerfile`, `user-init.default.sh`
전부 확인했지만 `mise` 설치 로직이 없음 — 최초 부팅 시 `user-init.default.sh`가
실행하는 `qwreey-fish`의 `qs_setup` fish 함수가 설치하는 것으로 추정됨(그
저장소는 이 레포 범위 밖이라 직접 확인 안 함). mise 자신의 최신 버전 확인/자체
업데이트는 `mise self-update`(mise 공식 서브커맨드로 알려져 있음 — 정확한 플래그/
동작은 구현 시점에 재확인 필요, `mise-plan-done.md`가 이미 확립한 "CLI 서브커맨드
실행 + 결과 파싱" 패턴을 그대로 재사용하면 될 것으로 보임, `internal/mise`
패키지에 자연스럽게 추가 가능).

### 컨테이너 리빌드는 webmanager 프로세스 내부에서 트리거 불가

중요한 제약: webmanager는 자기 자신이 실행 중인 바로 그 컨테이너 안에서 도는
프로세스라, `docker compose build && up`을 실행하려면 **호스트의 Docker
데몬**(`code-docker-dind`가 아니라 호스트 자체)에 접근해야 함 — 이건 지금까지
webmanager가 다루는 어떤 것과도 다른 권한 레벨(`dind-plan.md`가 다루는
`code-docker-dind`는 격리된 별도 데몬이라 호스트 데몬과 무관). 즉 이 패널이
할 수 있는 최대치는 "리빌드가 필요해 보인다"는 **알림**까지고, 리빌드 실행
자체는 항상 사용자가 호스트에서 직접 해야 하는 범위 밖 액션으로 못박아야 함
(webmanager가 원격으로 자기 자신을 재빌드하려는 시도는 만들지 않음).

## 미해결 질문 (사용자가 답할 차례 — 최대한 많이 적어둠)

1. **"컨테이너 리빌드가 필요하다"를 뭘 기준으로 판단할지 — 근본적으로 불확실함.**
   사용자가 직접 제기한 딜레마 그대로 옮김:
   - Arch Linux 베이스 이미지 자체의 변경(새 `archlinux` 이미지 태그/다이제스트)을
     볼지 — 그런데 이건 "베이스 이미지가 바뀌었다"는 사실만 알 뿐, 실제로 이
     프로젝트의 리빌드가 *필요한* 이유(보안 패치, 깨진 패키지 등)와는 느슨하게만
     연관됨.
   - `pacman` 패키지들의 최신 상태를 볼지 — 그런데 사용자 본인이 지적한 대로,
     빌드 시점에 pacman 캐시가 마운트된 상태로 도니(`build.*.sh` 참고) 실제
     설치되는 패키지 버전이 "지금 pacman이 보고하는 최신 버전"과 다를 수 있음
     (레이어 캐시가 최신화 안 됐을 수 있음) — 즉 이 신호 자체가 신뢰하기
     애매함.
   - 두 방법 다 "리빌드해야 함"을 안정적으로 알려주는 신호가 아닐 수 있음 —
     차라리 신호를 아예 안 만들고 "정기적으로 그냥 리빌드하세요" 안내만 하는
     쪽이 더 정직할 수도 있음. 이 항목은 이 문서가 대신 결정하지 않음.
2. **`code-server-autoinstall` 서브모듈 업데이트를 뭘 기준으로 "지금 갱신할
   때"라고 판단할지.** 모든 새 커밋마다 알림을 띄우면 너무 시끄러울 수 있고,
   릴리즈/태그가 있어야 의미 있는 신호가 될 텐데 — 사용자 본인도 "사람들이
   업데이트가 필요하다고 느낄 정도가 됐을 때 뭔가 태그를 릴리즈해야 할 것
   같다"는 정도로만 생각 중, 구체적 기준 없음. 이 저장소(`qwreey/code-server-
   autoinstall`)에 릴리즈/태그 관례가 실제로 있는지부터 확인이 필요해 보임
   (착수 시점에 `git ls-remote --tags`로 확인 가능).
3. **백그라운드 확인 주기**: 몇 시간/며칠 간격으로 할지 — code-server 자체는
   이미 1시간 쿨다운으로 도는 별개 메커니즘이니, 이 패널의 "백그라운드 확인"은
   그것과 별개로 mise self-update 확인/서브모듈 확인 주기를 얼마로 잡을지의
   문제.
4. **업데이트가 감지됐을 때 UI가 뭘 할지**: 그냥 배지/알림만 띄울지, "지금
   적용" 버튼까지 둘지 — mise self-update는 webmanager가 직접 트리거해도
   안전해 보이지만(이미 mise 탭이 비슷한 잡 실행 패턴을 갖고 있음), code-server
   서브모듈/베이스 이미지 쪽은 위에서 정리했듯 실제 적용(리빌드)은 항상 사용자
   범위 밖 액션이라 "알림까지만" 하는 게 맞아 보임 — 이 구분을 그대로 확정할지
   재검토 필요.

## 참고

- `code-server-autoinstall/install.sh` — code-server 자동 업데이트 로직 원본.
- `.claude/mise-plan-done.md` — `mise self-update` 추가 시 재사용할 CLI
  shell-out 패턴.
- 우선순위는 `guide-plan.md`와 동일하게 최하 — `webmanager/plan.md`/`CLAUDE.md`
  반영 완료.
