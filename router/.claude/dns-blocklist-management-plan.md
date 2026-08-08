# DNS 관리(블록리스트/추가 호스트/리졸버) + firewall 재동기화 설계

2026-08-08, 사용자 요청으로 시작. router의 DNS(`config/dns/`, dnsmasq)와
netgate 방화벽(`config/netgate/`)은 지금까지 순수 파일(default/override) 기반이라
웹에서 아무것도 건드릴 수 없었다 (root `CLAUDE.md` 갱신 이전 조사 결과 참고). 이
문서는 그걸 tailscale/Dev Proxy처럼 router-manager API + 웹 UI로 관리 가능하게
만드는 설계다.

## 핵심 아이디어: "심고, 해시로 추적하고, 갈리면 물어본다"

기존 `config/code/code-patch.default.sh`의 해시 추적 패턴(디폴트가 바뀌어도 라이브
파일이 "손대지 않은 상태"면 조용히 재적용, 손댔으면 영원히 방치)을 그대로 가져오되
한 가지를 바꾼다: **라이브 파일이 이미 갈린 상태에서 디폴트가 또 바뀌면, code-patch처럼
영원히 무시하지 않고 웹 UI에 "새 기본값 있음" 배지 + 가져오기/무시/비교(diff) 3버튼을
띄운다.** 이제 이 파일들은 웹 UI로도 편집 가능해졌으니 "손댐"의 의미가 바뀌었기 때문 —
사용자가 그냥 정보를 얻고 결정할 기회를 갖는 게 낫다.

세 가지 해시:
- `shippedHash` — 이미지에 들어있는 `*.default.*`(있으면 `*.override.*` 우선, 기존
  code-patch/override 우선순위 그대로) 파일의 sha1.
- `liveHash` — `/var/lib/code-docker-router/...`에 실제로 떠 있는 라이브 파일의 sha1.
- `seededHash` — manifest에 저장된, "라이브 파일이 마지막으로 동기화됐던 시점의
  shippedHash" 값.

로직 (매 dns 프로그램 기동 시 셸에서, code-patch와 100% 동일한 알고리즘):
1. 라이브 파일이 없으면 → 그냥 복사, `seededHash = shippedHash`.
2. `shippedHash == seededHash` → 아무 것도 안 바뀜, 아무것도 안 함.
3. `shippedHash != seededHash` (이미지가 업데이트됨):
   - `liveHash == seededHash` (사용자가 안 건드림) → **조용히 재복사**,
     `seededHash = shippedHash`.
   - `liveHash != seededHash` (사용자가 웹 UI로든 직접이든 건드림) → **아무것도
     안 건드리고 manifest도 그대로 둠**. 다음에 router-manager API를 호출하면
     `shippedHash != seededHash`가 그대로 보이므로 "업데이트 있음"으로 잡힘.

부트스트랩(1번, 2/3번의 "조용히 재복사" 분기)은 **셸 스크립트**(`dns.default.sh`
상단, dnsmasq 실행 전)가 담당 — 컨테이너/프로그램이 뜰 때마다 자동으로 일어나야
하고 웹 UI가 열리길 기다릴 필요가 없는 부분이라 그렇다. "사용자에게 물어보기"
분기(3번의 갈린 경우)는 **router-manager Go 백엔드**가 GET 요청 시점에 두 해시를
비교해서 계산 — 별도 폴링/크론 없이 탭을 열 때마다 최신 상태가 보인다.

manifest 포맷은 code-patch와 동일하게 `<name>\t<hash>` 한 줄씩(셸에서 파싱하기
쉽고, Go에서도 tab split이면 끝). jq 의존성 없음 — netgate가 이미 `yq`를 쓰므로
resolver 설정 등 YAML은 yq로, 이 manifest만 code-patch 포맷 그대로 유지.

## DNS: 세 가지 관리 대상

파일 위치는 모두 `${ROUTER_VOLUME:-./data/router}` 아래
(`/var/lib/code-docker-router/dns/`) — tailscale config.yaml과 같은 볼륨.

### 1. 블록리스트 소스 (멀티 리스트, Caddy 스타일)

`dns/blocklist-sources/*.hosts` — 파일 하나 = 소스 하나. dnsmasq 실행 시 이
디렉토리의 모든 파일에 `--addn-hosts=`를 반복해서 붙인다 (dnsmasq는 원래
`--addn-hosts=`를 여러 번 줄 수 있게 설계되어 있고, 지금도
`blocklist.override.hosts` 하나를 추가로 붙이는 데 이미 이 방식을 쓰고 있음 —
그냥 N개로 일반화하는 것뿐).

- **builtin** (`builtin.hosts`) — `blocklist.default.hosts`(또는
  `blocklist.override.hosts`, 기존 우선순위 그대로)에서 시딩됨. 위의 해시 추적
  대상. UI에서는 내용을 줄 단위로 편집하게 하지 않음 (StevenBlack 리스트가
  10만 줄 단위라 줄 단위 CRUD는 의미가 없고 무겁다) — 대신 활성/비활성 토글,
  "업데이트 있음" 배지, 가져오기/무시/비교(추가/제거된 호스트 이름 샘플 + 개수)만
  제공.
- **custom** (`<name>.hosts`, 사용자가 웹에서 생성) — 완전히 사용자 소유, 해시
  추적 없음. 이름 + 줄바꿈으로 구분된 호스트 이름 목록(주석 `#` 허용)을 받아서
  `0.0.0.0 <host>` 형식으로 렌더링. 생성/수정/삭제 자유.

**여러 블록리스트를 허용해도 되나?** 됨 — 블록리스트끼리는 순서가 의미 없다
(어느 파일에서 왔든 "차단"이라는 결론은 같음, 겹쳐도 충돌 없음). 그래서 이번엔
소스 간 순서(order) UI는 만들지 않음 — 필요해지면 나중에 추가.

### 2. 추가 호스트 (MagicDNS 스타일, 진짜 IP 매핑)

`dns/custom-hosts.yaml`(구조화된 저장, `{entries:[{host,ip}]}`) →
`dns/custom-hosts.hosts`로 렌더링(`<ip> <host>` 줄들). 블록리스트와 별개 개념 —
0.0.0.0이 아니라 사용자가 지정한 실제 IP로 응답. 해시 추적 대상 아님(이미지에
디폴트가 없음, 순수 사용자 데이터).

**블록리스트와 추가 호스트가 같은 호스트 이름을 가리키면?** 애매하다 — dnsmasq가
hosts 파일 여러 개에서 같은 이름을 만나면 정확히 어느 쪽이 "이긴다"인지 확정하지
않고 의존하기로 함(구현 문서마다 설명이 조금씩 다름). 정밀하게 승부를 가리는 대신:
1. **고정 순서**를 하나 정한다 — `custom-hosts.hosts`를 블록리스트 소스들보다
   먼저 `--addn-hosts=`에 넣는다 (사용자가 명시적으로 IP를 지정했다면 블록보다
   그 의도가 우선이어야 한다는 게 더 자연스러운 기본값).
2. 그래도 **충돌 감지**는 한다 — `GET /api/dns/blocklist-sources` 응답에
   `duplicateHosts: []string` 필드로, 블록리스트/추가 호스트 전체에서 두 번 이상
   등장하는 호스트 이름을 얹어서 웹 UI에 경고로 보여준다. 정답을 강제하지 않고
   사용자에게 알려주는 쪽으로 애매함을 해소.

### 3. 리졸버(업스트림 네임서버) 오버라이드

유저스페이스에서 가능하다고 확인됨(dnsmasq `no-resolv` + `server=`). `dns/config.yaml`
(`{resolver: {mode: "auto"|"custom", servers: [...]}}`). `mode: auto`(기본, 지금
동작 그대로 컨테이너 자체 `/etc/resolv.conf` 사용) vs `mode: custom`(예:
`1.1.1.1`, `8.8.8.8` 등 사용자가 지정한 서버 목록 — `--no-resolv --server=X`를
dnsmasq 실행 인자에 추가). 해시 추적 대상 아님(순수 사용자 설정).

## API (router-manager, `/api/dns/*`)

읽기는 열려 있고 쓰기는 `gate.RequirePassword`로 감싸는 기존 관례 그대로
(tailscale/dev-proxy와 동일). 모든 mutating 라우트는 `dns` supervisord 프로그램을
재시작(`restartSupervisorProgram(ctx, "dns")`, `handlers_tailscale.go`의
헬퍼 재사용) — 단 "무시" 액션은 라이브 파일 내용이 안 바뀌므로 재시작 불필요.

```
GET    /api/dns/blocklist-sources                     -> {sources:[...], duplicateHosts:[...]}
POST   /api/dns/blocklist-sources                     -> custom 소스 생성 {name, content}
PUT    /api/dns/blocklist-sources/{name}               -> custom 소스 내용 수정
DELETE /api/dns/blocklist-sources/{name}               -> custom 소스 삭제 (builtin은 삭제 불가, 400)
GET    /api/dns/blocklist-sources/builtin/status       -> {updateAvailable, addedCount, removedCount, addedSample, removedSample}
POST   /api/dns/blocklist-sources/builtin/pull         -> 새 기본값으로 덮어씀
POST   /api/dns/blocklist-sources/builtin/ignore       -> 라이브는 그대로, seededHash만 갱신(다시 안 물어봄)

GET    /api/dns/custom-hosts                           -> {entries:[{host,ip}]}
PUT    /api/dns/custom-hosts                           -> 전체 교체 (엔트리 몇 개 안 될 거라 개별 CRUD 대신 통짜 교체)

GET    /api/dns/resolver                               -> {mode, servers}
PUT    /api/dns/resolver                               -> 갱신
```

## dns.default.sh 변경

`dnsmasq.default.conf`의 정적 `addn-hosts=` 줄은 제거(빌드 시점에 박히던 방식이라
해시 추적/웹 관리와 안 맞음). 대신 `dns.default.sh`가:

1. builtin 소스 부트스트랩(위 알고리즘 1/2/3-조용히 분기, code-patch 스타일 셸).
2. `dns/config.yaml`의 resolver 모드 읽어서(yq) `--no-resolv --server=X...` 인자 구성.
3. `dns/custom-hosts.hosts`가 있으면 `--addn-hosts=`로 먼저 추가.
4. `dns/blocklist-sources/*.hosts` 전부 글롭해서 `--addn-hosts=`로 추가.
5. `exec dnsmasq --conf-file="$CONF" $extra_args`.

기존 `blocklist.override.hosts`(파일 직접 편집) 지원은 그대로 유지되지만, 이제
"소스 오브 트루스 선택"(override 있으면 override, 없으면 default) 역할만 하고
런타임에 별도 `--addn-hosts=`를 얹는 방식은 없어짐 — builtin 소스 부트스트랩 시
그 선택 로직을 그대로 재사용하기 때문.

## firewall(netgate)에도 같은 재동기화 패턴 적용 — 시도해보고 백로그로 되돌림

처음엔 "단일 파일 재동기화 상태 조회 + pull/ignore API + 설정 탭 카드" 정도는
이번 세션에 곁들일 수 있는 스트레치라고 봤는데, 실제로 설계해보니 **DNS
블록리스트만큼 간단하지 않다는 게 드러났다** — 스트레치가 아니라 그 자체로
선행 작업이 필요한 별도 기능이라 이번엔 하지 않고 이유를 남긴다.

DNS 쪽 재동기화가 성립하는 이유는 "라이브 카피"가 실제로 존재하기 때문이다 —
`blocklist-sources/builtin.hosts`는 처음엔 shipped 기본값과 **완전히 동일한
내용으로 시작**하고, 이후 웹 UI(또는 직접 편집)로만 갈라진다. 그래서
"라이브 == 마지막 시딩 해시"면 "안 건드림"이라고 확실히 말할 수 있다.

netgate에는 이 "라이브 카피" 개념이 아예 없다 — `firewall.default.sh`가
`config.override.yaml`이 있으면 그걸, 없으면 `config.default.yaml`을 직접
읽는다 (root `CLAUDE.md`의 override 패턴 그대로, 시딩되는 별도 사본이 아님).
그래서 "라이브"를 정의하려면:

- override 파일이 없으면 → 라이브는 언제나 shipped 기본값과 같다 → 재동기화가
  의미 있는 경우가 아예 없음(항상 "최신").
- override 파일이 있으면 → 라이브는 "사용자가 손으로 쓴, 기본값과 원래부터
  다른 파일" → shipped 기본값이 바뀔 때마다 매번 "업데이트 있음"이 뜨는데,
  "가져오기"를 누르면 사용자의 override 전체를 통짜로 날리고 기본값으로
  덮어쓴다는 뜻이 됨 — DNS의 "가져오기"(안전하게 최신 차단 목록으로 갱신)와
  전혀 다른, 훨씬 위험한 동작이 되어버린다.

즉 이 패턴을 netgate에 정직하게 적용하려면 **먼저 netgate도 DNS 블록리스트와
같은 "시딩된 라이브 카피" 모델로 옮겨야 한다** — `/var/lib/code-docker-router/netgate/config.yaml`
같은 걸 만들어서 `firewall.default.sh`가 `config.default.yaml`/`.override.yaml`
직접 읽기 대신 이 시딩된 카피를 읽게 바꾸는 작업. 이건 위에서 이미 백로그로 미룬
"outbound 멀티 리스트 CRUD" 작업과 사실상 겹친다(둘 다 netgate 설정 로딩 방식
자체를 바꿔야 함) — 그래서 어설프게 절반만 구현하는 대신, 아예 안 하고 아래
백로그 항목에 합쳐서 남긴다.

## 보류 (이번에 안 함)

- **로그 용량 문제** — 사용자가 직접 "백로그로, 더 생각해봐야함"이라고 함. vector의
  JSONL 로그 보존/로테이션 정책이 없다는 게 핵심 문제 — 별도 문서/세션에서 다룸.
- **netgate 설정을 시딩된 라이브 카피 모델로 전환 + 해시 재동기화 + 멀티 리스트
  CRUD** — 세 가지가 사실 한 덩어리 작업이라는 게 이번에 드러났다(바로 위 섹션).
  순서: (1) `config.yaml` 시딩 도입 + `firewall.default.sh`가 그걸 읽게 전환
  (2) 그 위에 DNS와 같은 해시 재동기화(pull/ignore/compare) (3) 그 위에
  이름 붙은 순서 배열 기반 멀티 리스트. (1)이 안 되어 있으면 (2)도 (3)도
  의미가 없다.
- **블록리스트/추가 호스트 소스 순서 재배치 UI** — 지금은 고정 순서(추가
  호스트 → 블록리스트)로 충분, 필요해지면 추가.

## 왜 웹 관리가 지금까지 없었나 (배경)

`CLAUDE.md`의 "netgate/dns" 섹션이 설명하듯 DNS/방화벽 둘 다 순수
`*.default.*`/`*.override.*` 파일 기반으로 시작했고(재빌드 필요), router-manager가
생긴 뒤에도 tailscale/Dev Proxy/tinyauth만 API로 옮겨졌을 뿐 이 둘은 옮겨진 적이
없었음 — 사용자가 직접 확인 요청해서 발견됨(2026-08-08).
