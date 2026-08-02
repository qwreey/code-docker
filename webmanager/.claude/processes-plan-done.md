# 프로세스/포트 뷰어 + 컨테이너 리소스 추적 — 완료 (btop 대체용)

## 업데이트 (2026-08-02, 두 번째 라운드) — 큰 개편, 탭 이름도 변경됨

사이드바 라벨이 "Processes" → **"작업 관리자"**로 바뀜(성능 모니터링과 프로세스
목록을 둘 다 포괄하는 이름 필요). 실사용 피드백 대응:

- **"성능"/"프로세스" 서브탭으로 분리**(Task Manager/KDE System Monitor 스타일,
  타이틀과 같은 줄 우측에 스위처) — 기존엔 리소스 카드+그래프가 프로세스
  목록 위에 항상 떠 있어서 어수선했음.
- **"성능" 서브탭 재설계**: 중복되던 "현재 값 카드"를 없애고 그래프 자체(범례/
  라벨)로 통합. **CPU는 호스트 전체 코어별 히트맵**(작업 관리자 스타일,
  `internal/cgroup/host.go`의 `HostCPUSampler` — **호스트 전체 기준**이지
  컨테이너 cgroup 스코프가 아님, cgroup v2엔 코어별 통계 자체가 없어서 `/proc/
  stat`으로 읽음, UI에도 명확히 라벨링됨). **메모리는 스택형 막대**(호스트 물리
  메모리의 used/cache/buffer/free를 cgroup used/limit과 나란히 — cgroup에 제한이
  없을 때도 호스트 물리 총량을 볼 수 있음). 클럭/온도는 best-effort로 읽혀지면
  표시(`/sys` 접근 안 되는 컨테이너에서는 자연스럽게 안 보임).
- **재사용 가능한 프로세스 트리 유틸리티**: `src/utils/processTree.ts`의
  `buildProcessTree(processes, rootPid?)` — 순수 프론트, 기존 `ppid` 필드만
  씀(백엔드 변경 없음). "프로세스" 서브탭에 트리/리스트 뷰 토글로 반영, Supervisor
  탭의 프로그램별 PID 트리 펼침 기능(피드백 4번)이 이걸 그대로 가져다 쓸 예정 —
  **아직 Supervisor 쪽엔 안 붙임**, `question.md` 참고.
- **필터/검색**: 상태(running/sleeping 등) 필터 + 이름/커맨드 퍼지 서치(일치
  글자 하이라이트, `src/utils/fuzzyMatch.ts` — 새 의존성 없이 직접 구현) —
  전부 프론트에서 처리(백엔드는 이미 전체 목록을 보내고 있어서 서버 필터링은
  이 컨테이너 환경 규모엔 과설계라고 판단, 백엔드 변경 없음 확인 완료).
- **DOM 페이지네이션**(25/50/100/전체 선택 가능) — 필터링 이후 적용, 리스트
  뷰에만 적용(트리 뷰는 부모-자식 맥락이 깨지지 않게 페이지네이션 안 함).
- **확인 완료**: Processes 탭(및 리소스 히스토리)은 파일에 아무것도 안 씀 —
  전부 인메모리(`internal/procinfo` 매 요청마다 새로 읽음, `internal/cgroup`의
  히스토리는 고정 크기 링 버퍼) — 컨테이너 재시작하면 히스토리 그냥 날아감,
  의도된 동작.
- **알려진 제약**: 코어별 히트맵에 마우스 올렸을 때 "그 코어의 최근 히스토리
  그래프"까지는 아직 안 됨(순간값만 툴팁으로 표시) — 백엔드 히스토리 엔드포인트
  (`GET /api/system/resources/history`)가 실제로는 `points[].hostPerCorePercent`
  로 코어별 시계열을 이미 제공하고 있어서(구현 완료, 프론트가 아직 안 씀), 나중에
  필요하면 저비용으로 추가 가능.

## 동기

컨테이너 안에서 node 등을 띄워놓고 까먹어서 포트가 점유된 채로 남는 경우가 잦음 —
지금까지는 `btop`을 열어서 찾아 죽였는데, 이걸 웹 UI로 옮김. 별개로 `btop`은
컨테이너 자신의 cgroup 한도 대비 사용량(`docker stats`가 보여주는 값)은 애초에 못
보여주는데, 이것도 같은 페이지에 얹음.

## 프로세스/포트 뷰어

- `internal/procinfo`(`github.com/shirou/gopsutil/v4` — v3는 사실상 구버전 고정이라
  v4가 현재 stable): `process` 패키지가 `/proc` 파싱, `net` 패키지의
  `Connections`가 리스닝 포트 + 점유 PID를 이미 매칭해서 리턴함(직접 구현할 필요
  없음). webmanager가 root로 도니까 다른 프로세스의 `/proc/<pid>/fd` 읽기 권한
  문제도 없음.
- **CPU%는 자체 delta 샘플러가 필요했음**: gopsutil이 프로세스당 순간값만 주고
  요청마다 새 Process 핸들을 만들면 내부 캐시가 리셋되므로, `Server`에 pid별
  이전 CPU 시간 샘플을 mutex로 저장해뒀다가 요청 시각 차이로 델타를 계산(`top`/
  `htop`/`btop`과 동일한 기법). 코어 수로 정규화(0-100% 범위, htop의 normalized
  view와 동일 컨벤션).
- kill: `syscall.Kill` 직접 사용(gopsutil의 `SendSignal` 대신) — `ESRCH`→404,
  `EPERM`→403 매핑을 정확히 하기 위해.
- API: `GET /api/processes`, `GET /api/ports`, `POST /api/processes/{pid}/signal`
  (body `{signal: "TERM"|"KILL"}`).

## 컨테이너 전체 cpu/mem/disk 추적

- `internal/cgroup`: `/proc/self/cgroup`로 실제 cgroup v2 디렉토리를 resolve(하드
  코딩된 `/sys/fs/cgroup` 대신 — 컨테이너 안에선 보통 `0::/`라 결과적으로 같지만,
  중첩된 cgroup 환경에서도 정확히 동작하도록). `memory.current`/`memory.max`,
  `cpu.stat`의 `usage_usec`(델타 샘플링, procinfo와 동일 패턴이지만 락 범위는 더
  좁게 처음부터 잘 짬), `cpu.max`(quota/period)로 제한 코어 수 계산.
- 디스크: `syscall.Statfs`를 `/code`(바인드 마운트 볼륨)에 적용 — `df`와 동일한
  컨벤션(used = Blocks-Bfree, free = Bavail, 총합이 total과 안 맞는 건 파일시스템
  예약 마진 때문, 의도된 것).
- API: `GET /api/system/resources` →
  `{memory:{usedBytes,limitBytes,available}, cpu:{percent,limitCores,numCpu,
  available}, disk:{path,totalBytes,usedBytes,freeBytes,available}}`.
  `available: false`는 해당 섹션 읽기 실패(값은 0으로 채워짐, 진짜 0이 아님) —
  review.md에서 이 구분이 없어서 프론트가 "못 읽음"과 "진짜 0"을 구별 못하는 문제가
  발견돼 나중에 추가된 필드.

## 프론트

`src/components/Processes/` — `Processes.tsx`(탭 전환) 위에 `SystemSummary.tsx`
(메모리/CPU/디스크 요약 카드, `available: false`면 "확인 불가" 표시), 아래
`ProcessTable.tsx`(정렬 가능, 종료/강제종료 버튼)와 `PortTable.tsx`(점유 프로세스
표시, 여기서도 바로 kill 가능 — "포트 찾아서 바로 끄기"가 원래 동기라 탭 전환 없이
가능하게 함).

## 참고

기존 `webmanager/ideas.md`의 "컨테이너 전체 cpu/mem/disk 리소스 추적" 조사(초기
타당성 검토)가 이 기능의 출발점 — 지금은 구현 완료라 ideas.md에서 이 항목은 제거됨.
