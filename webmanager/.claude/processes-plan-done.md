# 프로세스/포트 뷰어 + 컨테이너 리소스 추적 — 완료 (btop 대체용)

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
