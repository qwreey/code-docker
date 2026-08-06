# router를 "네트워크 경계 전담 컨테이너"로 확장하는 구상 (초기 비전 문서)

작성일: 2026-08-05 — `egress-netgate-plan.md`(아웃바운드 CIDR 차단 + 인바운드 DNAT)를
설계/1단계 구현하는 과정에서, "이 router가 네트워크 경계에 이미 앉아 있으니 tailscale/
Caddy/외부 노출 인증까지 다 여기로 모으면 어떤가"라는 아이디어가 나와서 별도로 정리한
문서. **아직 설계 확정 전 — 방향성과 트레이드오프를 정리한 비전 문서에 가깝고, 상당
부분이 "결정 필요"로 열려 있음.** egress-netgate-plan.md의 netgate 구현에 영향을 주는
부분이 있어 그쪽에서도 상호 참조함.

## 핵심 아이디어

netgate(router)는 이미 `code-docker-internal` + `code-docker-external` 양쪽에 다리를
걸친, code-docker보다 신뢰 수준이 높은 유일한 국경 통과 지점이다. 그렇다면 "네트워크
경계와 관련된 모든 것"을 여기로 모으는 게 자연스럽지 않은가:

1. **tailscale을 code-docker가 아니라 router에서 실행.** 지금 code-docker 안의
   `tailscaled`가 0.0.0.0/loopback 바인드를 자동으로 tailnet 전체에 노출시키는 문제 때문에
   `private`/`forward` 전용 alias로 우회하고 있는데(CLAUDE.md tailscale 절), tailscaled가
   router로 옮겨가면 이 문제 자체가 code-docker 쪽에서 사라진다. router가 tailnet의 어떤
   범위(포트 단위든 IP 단위든)를 code-docker에 통과시킬지를 직접 결정 — tailscale ACL을
   안 건드리고도 해결됨.
2. **Caddy(현재 code-docker 안, Dev Proxy 기능)도 router로.** 외부 노출을 다루는 것도
   router의 본업과 같은 카테고리 — code-docker는 `private:80`같은 곡예 없이 그냥
   `0.0.0.0`에 바인드해도 됨(코드docker-internal은 이미 외부에서 도달 불가능하므로,
   router가 명시적으로 포트포워딩해주지 않는 한 노출 없음).
3. **router가 자체 forward-auth(비밀번호 게이트)를 가질 수 있음.** router 설정 API로
   임의 라우트에 비밀번호를 걸 수 있게 하면, code-docker(에이전트 포함)가 뭘 하든 그
   라우트 설정 자체를 못 바꿈 — dind-authz/netgate와 동일한 "정책은 더 신뢰된 컨테이너
   안에" 원칙의 연장.
4. **동기: 팀원에게 개발 서버를 빠르게 공유하는 워크플로우.** 빌드/배포/마이그레이션
   기다릴 필요 없이 `npm run dev` 옆에서 바로 라이브로 보여주고 싶은데, 그러자면 뭔가
   가벼운 접근 제어가 필요함. Authentik은 이 목적엔 너무 무겁고(멀티테넌시 불필요, 설정
   진입 장벽 큼) — router 안에 작은 auth 프로세스를 두고 `/router`(가칭, `/manager`와
   나란히)에서 설정하는 쪽이 훨씬 가벼움.

## 왜 이게 그럴듯한가 (검증된 부분)

- **신뢰 경계가 더 명확해짐.** Dev Proxy/외부 노출 관련 정책이 지금은 code-docker
  안에서 도는 webmanager 프로세스가 들고 있는데, router로 옮기면 code-docker(오염
  가능성이 있는 컨테이너) 자체가 그 정책 파일에 손도 못 대게 됨 — dind-authz의
  `/etc/dind-authz.d`, netgate의 CIDR 설정과 정확히 같은 패턴.
- **code-docker 쪽 네트워크 관련 코드/설정이 실질적으로 줄어듦.** tailscale
  private/forward 곡예, Dev Proxy의 nginx 경유 라우팅 등 여러 우회 장치가 필요 없어짐 —
  "네트워크는 전부 router가 안다"로 단순화.
- **위협 카테고리는 늘지 않음.** "관문 프로세스가 죽으면 못 들어온다"는 지금 nginx나
  옮긴 뒤 router나 동일한 종류의 리스크.

## 짚어야 할 트레이드오프 (2026-08-05 논의)

- **위협이 사라지는 게 아니라 한 곳에 응축된다.** 지금은 nginx가 죽어도 아웃바운드/
  tailscale/dev-proxy는 각자 영향이 제한적인데, router가 다 들고 있으면 router 장애
  하나가 인바운드+아웃바운드+tailscale+dev-proxy 전체를 같이 끌고 내려간다. 카테고리는
  같아도 blast radius는 커짐 — `restart: unless-stopped` + 이 레포의 tailscale 절이
  이미 쓰는 "의도적으로 분리된 단일 책임 supervisord 프로그램" 패턴을 router 안에서도
  반복해 개별 기능 하나의 버그가 다른 기능까지 끌고 내려가지 않게 해야 함.
- **router 자체가 webmanager의 전철을 밟을 위험.** webmanager도 처음엔 작았는데 지금은
  스스로 "원래 스코프를 훨씬 넘어섰다"고 문서화할 정도로 커졌음(CLAUDE.md webmanager
  절). router에 기능을 계속 추가하면 같은 일이 반복될 수 있음 — 처음부터 supervisord +
  단일 책임 프로그램 분리 규율을 지킬 것.
- **authgate와의 관계 — 결정됨(2026-08-05).** webmanager의 기존 authgate(Terminal/
  File Manager 보호용, `internal/authgate`)는 **그대로 유지, 변경 없음** — "자기
  자신만 건드리는 것"의 보호 수단으로 계속 씀. router 쪽 forward-auth는 완전히 별개의,
  더 가벼운 도구를 새로 둔다 — 아래 참고.

### router 전용 forward-auth — tinyauth로 결정

대안으로 tinyauth, (사용자가 언급한 다른 forward-auth 프로젝트들)을 검토했고,
**tinyauth로 결정**. 이유(사용자 판단): 목적(가벼운 개발 서버 공유용 게이트)에
비해 크지 않으면서도 OpenID Connect™ Certified라 향후 확장 여지가 있고, 이보다 나은
대안이 뚜렷하게 보이지 않음. router가 Caddy(또는 향후 결정될 리버스 프록시)의
forward-auth 대상으로 tinyauth를 세우는 구조가 될 것 — 세부 배선(compose 서비스 추가
방식, 설정 override 패턴 적용 등)은 실제 구현 시점에 확정.

### tailscale 전체(데몬+forward/publish) router 이관 — 결정됨 (2026-08-06)

`tailscaled` 데몬 자체를 포함해 로그인 세션, `forwards:`/`publish:` 풀링·포워딩까지
**전부** router로 옮긴다. code-docker 쪽에는 tailscale 관련 프로세스가 하나도 남지
않는다.

- userspace netstack이라 code-docker 쪽에 실제 네트워크 인터페이스를 추가로 물려
  tailscale IP를 온전히 부여하는 방법이 없다는 제약은 그대로다 — 그래서 forward류
  포워딩 메커니즘 자체가 없어지는 게 아니라, 그 로직을 누가 들고 있느냐만 router로
  바뀐다(지금 code-docker 안 `forward`/`private` alias + socat 조합이 하던 일을
  router가 대신 함).
- **오히려 더 안전해지는 이유**: code-docker(에이전트가 코드를 실행하는 컨테이너)
  자체는 이제 tailnet 기기에 붙을 수단이 아예 없다 — router가 명시적으로
  forward/publish 하지 않은 건 애초에 접근 불가능. tailnet의 오너가 아니라서 tailscale
  ACL을 직접 못 바꾸는 상황에서도, router 레벨의 **default-deny, 필요한 것만 explicit
  allow** 구조로 동등한 효과를 낸다.
- tailscale 피어 IP 필터: **기본은 완전 허용**(피어 IP를 안다는 것 자체로는 아무 것도
  할 수 없으므로 굳이 막을 이유가 없다는 판단) — 옵션으로 hostname/IPv4/IPv6·포트
  단위 필터링을 켤 수 있게 한다. 안 켜도 보안적으로 위협이 되진 않는다는 게 전제.
  포트 forward 시 원격지 표기는 **MagicDNS 이름을 아예 쓰지 않는다 — 결정됨
  (2026-08-06)**. 이유: MagicDNS는 동적 요소라 이름이 바뀔 수 있고(특히 Headscale에서는
  직접 바인드로 마구 재할당됨), 심지어 외부 요소를 가리키게 될 수도 있어 필터/forward
  대상으로 신뢰하기 어렵다. forward에서 애초에 외부 IP를 가져오는 것 자체가 허용
  대상이 아니므로, **확실한 tailscale hostname과 IP만으로 충분**하다는 결론.

### nginx는 code-docker에 잔류 + `/tailscale` 프록시 역할 추가 — 결정됨 (2026-08-06)

`egress-netgate-plan.md`에서 이미 "nginx는 유지"로 거의 결정됐던 것을, 이번에 이유까지
명확히 함: code-docker 안 nginx의 본래 역할은 `/`(code-server)와 `/manager`
(webmanager)를 크로스오리진 문제 없이 한 origin처럼 합치는 것이다. 이 역할을 router로
옮기면 router가 code-docker 앱 내부 구조(어떤 경로가 어떤 백엔드로 가는지)를 알아야
하는, 원치 않는 결합이 생긴다 — 그래서 nginx는 code-docker 쪽에 남는다.

"하나의 포트만 expose하자"는 예전 이유는 이제 무의미하다: netgate 이후로는 localhost가
더 이상 expose 대역이 아니고, 상위(router)가 포트포워딩을 명시적으로 처리하므로
code-docker가 스스로 Caddy/외부 접근용 포트를 열 필요조차 없다.

여기에 **`/tailscale` 경로를 nginx가 새로 맡아서**, router가 제공하는 tailscale
readonly API를 `code-docker-internal` 내부망으로 프록시한다. router 자체는 이 API를
외부(자신의 external 다리)로 노출할 필요가 없고 forward 포트만 잘 내보내면 된다 — 이
경로가 안전한 이유는 최상위(코드-docker 인프라 바깥) Caddy+Authentik이 이미 `/`
진입점부터 forward-auth를 걸기 때문.

### tailscale readonly API 노출 정책 — 결정됨 (2026-08-06)

router manager(Go 백엔드)가 대부분의 API를 갖되, tailscale 관련 API는:

- **기본값: private(위 nginx `/tailscale` 프록시 경유, 즉 `code-docker-internal`
  내부망)만 허용.**
- 전체(= router의 external 다리 포함) 허용은 env flag로 옵트인.
- router manager 자체를 독립적으로 직접 쓰는 경로(즉 router 컨테이너에 직접 접근하는
  UI/API)는 router 자체 인증(tinyauth) 뒤에 있어야 한다.
- 단, **저위험 상태 조회**(`backendState`, `authUrl` 같은 로그인 대기 상태)는 유저
  편의를 위해 인증 없이도 노출 가능 — 기존 결정 유지. 로그인 URL 자체는 opt-in이고
  유저 동의 전까지 컨테이너가 아무 권한도 갖지 않으므로 악용 소지가 없고, 로그인 후
  노출 범위는 위 IP/hostname/포트 필터로 대응 가능하다는 논리.

### Dev Proxy Caddy도 router로 이관 — 결정됨 (2026-08-06)

`egress-netgate-plan.md` 단계에서는 미확정이었던 항목(위 "결정 필요" 2번 참고)이 이번에
확정됨: Dev Proxy 기능(내부 개발 서버를 wildcard subdomain으로 노출하는 Caddy)도
router로 옮긴다. 이유(사용자 판단):

- **노출 범위 결정권의 집약.** 무엇을 얼마나 노출할지 결정하는 지점이 더 큰 맥락(router)
  안에 있어야, code-docker 쪽 코드/설정이 실수로 노출 범위를 넓히는 경로 자체가 없어진다.
- **재사용성.** router가 "현실의 라우터"처럼 egress+tailscale+Dev-Proxy 같은 복합
  네트워크 기능을 하나의 패키지로 묶으면, code-docker 전용이 아니라 다른 프로젝트에도
  붙일 수 있는 모듈이 된다 — code-docker는 이 컨테이너의 첫 사용처일 뿐, 유일한
  사용처로 설계하지 않는다.
- **보안감사 범위 축소.** "중요한 net 처리가 어디 있는지"가 router 하나로 집약되면,
  감사자가 들여다봐야 할 범위가 그만큼 좁아진다 — Rust의 `unsafe` 블록처럼, 위험이
  사라지는 게 아니라 검토해야 할 표면이 명시적으로 한 곳에 국한된다는 비유.
- **역할 경계가 더 명확해짐.** Caddy가 router로 가면 webmanager는 "통합을 위해 router의
  UI를 가져와 같이 보여줄 뿐, 기능 구현 자체는 거의 갖지 않는" 얇은 계층으로 남는다 —
  두 코드베이스가 더 뚜렷이 분리되어 관리가 쉬워지고, 그만큼 실수/보안 허점이 생길
  표면도 줄어든다.
- **opt-out이 쉬워짐.** webmanager 쪽에서는 그 페이지 컴포넌트를 import하지 않으면 그냥
  안 그려지고, code-docker 쪽에는 tailscale/Caddy 관련 패키지 자체를 설치하지 않는
  선택도 가능해진다.
- router가 "컨테이너 net을 통합 관리하는 도구"로서 매력적이라 채택률이 자연히 높아질
  것이라는 전망도 있음(비유: systemd를 개인적으로 선호하지 않는 사람도 결국 대부분
  채택하는 것과 비슷한 종류의 "더 편한 디자인이 이긴다" 논리) — 이건 근거라기보다는
  방향에 대한 확신에 가까움.

이로써 위 "결정 필요" 2번 항목은 닫힘 — router로 이관하는 것으로 확정.

### router ↔ webmanager 프론트 통합 방식 — 결정됨(구체화) (2026-08-06)

router가 자기 API와 자기 페이지 컴포넌트를 온전히 소유하고, webmanager는 router의
페이지 컴포넌트를 그대로 **import**해서 `/manager` 안에 얹어 그린다(iframe 아님 —
기존 비전과 동일, 이번엔 "누가 뭘 소유하는지"가 명확해졌다는 점이 구체화). shared
레이아웃(사이드바/페이지 골격 공유)은 코드량을 줄이는 소프트 제안일 뿐 — 안 따라도
문제없다.

authgate(webmanager의 Terminal/File Manager 보호용)는 이 통합으로 쿠키 배치 등이 조금
복잡해질 수 있지만, 쿠키 이름(namespace)만 router 쪽과 겹치지 않게 잘 피하면 충돌 없이
갈 수 있다는 판단 — 별도 재설계 불필요.

프론트엔드 자체는 컴포넌트 분화/재사용 패턴(사용자의
[qwreey-js/react-web-component](https://github.com/qwreey/qwreey-js/tree/main/packages/react-web-component)
경험 등)으로 기술적 난이도가 낮다고 판단 — 엔지니어링 결정에서 막히는 부분 없음.

- **webmanager 자체의 스코프 축소는 감수.** tailscale 프록시 관련 백엔드 축, Dev Proxy
  관련 프론트/백엔드 축이 router로 넘어가면 `webmanager/plan.md`/`webmanager/CLAUDE.md`도
  갱신 대상이 됨 — 이건 이 문서(code-docker 루트)가 아니라 webmanager 서브트리 쪽에서
  별도로 다뤄야 할 후속 작업. 얻는 게 더 크다는 게 사용자 판단.

## 프론트엔드 구조 (사용자가 "크리티컬하지 않으니 알아서 결정해도 됨"이라 명시함)

공유 UI 킷을 만들고, 다음 의존 관계로 구성하는 안:

```
shared → router     (router 자체의 /router UI가 shared 컴포넌트 사용)
shared → webmanager (webmanager도 같은 shared 컴포넌트 사용)
router → webmanager (webmanager가 router의 페이지 컴포넌트를 그대로 import해서
                      /manager 안에 통합 — iframe 안 씀, 진짜 컴포넌트 임포트)
```

`/manager`를 통합 UI 진입점으로 유지하되, `/router`도 router 컨테이너 자체에서 독립
접근 가능하게 두는 방향. 실제 구현 시점에 세부 조정 가능 — 지금 확정할 필요 없음.

## router 서브트리/빌드 구조 — 결정됨 (2026-08-06)

- **`router/` 폴더를 새로 만들어 그 안에서 작업.** webmanager와 같은 패턴으로, 자체
  `.claude/`를 이 폴더 안에 둔다(webmanager가 자기 `CLAUDE.md`/`plan.md`를 서브트리에
  갖는 것과 동일한 선례). 이번 작업에서 나올 보안 감사 결과 문서(`.md`)도 대부분 이
  `router/.claude/` 아래에 쌓일 전망 — 작업 공간을 `router/` 폴더로 적절히 스코프한다.
- **Dockerfile도 분리하는 게 낫다는 판단.** router가 별도 서브트리로 커지는 만큼,
  루트 `Dockerfile`의 `dind`/`netgate` 스테이지처럼 한 파일에 스테이지로 얹기보다
  `router/Dockerfile` 같은 자체 파일로 분리. docker-compose의 `build:`에서 서비스별로
  `dockerfile:`을 지정할 수 있는 것으로 알고 있음(확인 필요) — 다만 **`.dockerignore`가
  빌드 컨텍스트 루트 기준으로 하나만 적용되는 점을 유의해야 함**(compose가 서비스별로
  다른 컨텍스트를 쓰지 않는 한, 여러 `Dockerfile`이 있어도 `.dockerignore`는 보통
  하나로 공유됨) — 실제 구현 시점에 `context:`를 `router/`로 분리할지, 루트 컨텍스트를
  유지하며 `dockerfile: router/Dockerfile`만 가리킬지 확인 후 결정.

## netgate(egress-netgate-plan.md)에 대한 영향 — 지금 당장 반영해야 할 것

이 비전이 아직 확정 전이라도, **지금 만드는 netgate(2단계) 자체가 나중에 이 방향으로
확장 가능한 구조여야 한다.** 구체적으로:

- netgate의 Dockerfile/entrypoint를 **처음부터 supervisord 기반으로 구성** — 지금은
  squid + iptables 설정 스크립트 하나뿐이더라도, 나중에 tailscaled/Caddy/auth 프로세스가
  추가될 걸 감안해 "여러 개의 독립 프로그램을 관리하는 컨테이너" 구조로 시작. code-docker
  자신의 `config/supervisord.default.conf` + `config/supervisord/*.conf` 자동 include
  패턴을 그대로 재사용.
- 이미 결정된 "포트포워딩 설정을 yml로 선언"(egress-netgate-plan.md의 "포트포워딩
  일반화" 절)이 정확히 이 방향과 맞아떨어짐 — 지금 그대로 유지.
- netgate의 이름/역할을 "egress 전용"으로 문서상 너무 좁게 못박지 않기 — 나중에 이
  컨테이너가 "router"로 통칭될 수 있음을 염두에 두고 문서/변수명을 짓기(예:
  `NETGATE_ENABLED`는 이미 옵트아웃 변수로 확정됐으니 유지, 다만 향후 문서에서
  "netgate = router의 egress/DNAT 담당 부분"이라는 식으로 포지셔닝 여지를 남길 것).

## 결정 필요 (구현 착수 전)

1. ~~router에 tailscaled를 실제로 옮길지~~ — **결정됨(2026-08-06)**: 데몬+forward/
   publish 전부 이관. 위 "tailscale 전체(데몬+forward/publish) router 이관" 절 참고.
   남은 디테일: 기존 `config.yaml`/private·forward alias/code-patch 알림 설정을 실제로
   어떻게 마이그레이션할지는 구현 시점에 확정.
2. ~~Caddy(Dev Proxy)를 router로 옮길지~~ — **결정됨(2026-08-06)**: router로 이관.
   위 "Dev Proxy Caddy도 router로 이관" 절 참고. cross-origin 병합용 nginx(잔류 확정,
   위 참고)와는 별개 사안이었음.
3. ~~router 전용 경량 auth-gate~~ — **결정됨**: tinyauth, webmanager authgate는
   그대로 유지(위 "router 전용 forward-auth" 절 참고). 남은 건 배선 디테일뿐.
4. ~~`/router` UI와 `/manager` UI의 정확한 통합 방식~~ — **결정됨(구체화,
   2026-08-06)**: 위 "router ↔ webmanager 프론트 통합 방식" 절 참고.
5. webmanager 쪽 plan.md/CLAUDE.md 갱신 범위 — **여전히 별도 후속 작업으로 분리**
   (2026-08-06 재확인). 그 자체로도 범위가 커서 이번 설계 확정 범위에 포함하지 않음.
6. ~~읽기 전용 tailscale 상태 API의 정확한 필터링 스펙~~ — **결정됨(2026-08-06)**: 위
   "tailscale readonly API 노출 정책" 절 참고. MagicDNS는 필터/forward 대상에서 완전히
   제외(위 "tailscale 전체 이관" 절 참고) — hostname/IP만 사용.

## 참고

- `.claude/backlog/egress-netgate-plan.md` (레포 루트) — 이 문서의 전제가 되는 netgate
  설계/1단계 구현 완료 기록.
- 레포 루트 CLAUDE.md의 tailscale 절 — "의도적으로 분리된 단일 책임 supervisord 프로그램"
  패턴의 기존 선례, router 안에서도 반복할 모델.
- `.claude/backlog/dind-authz-plan.md` (레포 루트), `webmanager/.claude/archive/authgate-plan-done.md`
  — "정책은 더 신뢰된 컨테이너/프로세스 안에" 원칙의 기존 적용 사례들, 이번 아이디어도
  같은 계열.
- (이 문서 자체는 원래 레포 루트 `.claude/backlog/functional-router-plan.md`였다가,
  마이그레이션이 끝난 뒤 `router/.claude/functional-router-plan.md`로 이동함 —
  아래 "router 서브트리/빌드 구조" 절이 예견했던 배치 그대로.)
