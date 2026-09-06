# authgate의 per-IP 백오프가 클라이언트를 구분하지 못한다 (router / webmanager 둘 다)

발견 2026-09-06, VNC 연결 클라이언트 기능을 만들다가 곁가지로 확인됨. **고치지 않았고,
별개 결정이라 여기에 남긴다.**

## 사실관계

`router/backend/handlers_auth.go`의 `clientKey(r)`는 `r.RemoteAddr`에서 host만
떼어낸다. 그런데 router-manager는 **유닉스 소켓으로만 listen**한다
(`backend/main.go`의 `listen()`, 기본 `/run/router-manager.sock`; `ROUTER_MANAGER_ADDR`를
주면 TCP). nginx는 `proxy_pass http://unix:/run/router-manager.sock:/`로 붙는다.

즉 `r.RemoteAddr`는 **모든 호출자에 대해 동일한 유닉스 소켓 피어 주소**다. 그 값을
키로 쓰는 `internal/authgate`의 per-IP 실패 백오프는 사실상 **전역 버킷 하나**로
동작한다 — 누구 하나가 비밀번호를 5번 틀리면 그 백오프가 모두에게 걸린다.

2026-09-06에 nginx의 router-manager location 3곳에 `X-Real-IP`/`X-Forwarded-For`를
추가하고 `realClientIP(r)`를 새로 뒀지만, **`clientKey`는 일부러 안 건드렸다** —
VNC 패널/kick 창만 새 헬퍼를 쓴다. 백오프 버킷팅을 바꾸는 건 인증 동작 변경이라
별도 판단이 필요하다고 봤다.

## webmanager 쪽도 같은지 확인 필요

webmanager의 `internal/authgate`도 같은 패키지 계보이고, webmanager 역시 nginx 뒤에
있다(`WEBMANAGER_ADDR`, 내부 포트). 이쪽은 TCP라 `r.RemoteAddr`가 nginx의 주소가
될 뿐 "모두 동일"인 건 마찬가지다. **아직 실제로 확인 안 했다** — 착수하면 여기부터.

## 고칠 때 고려할 것

- 헤더를 믿는 건 **리스너가 nginx만 닿을 수 있는 경우에 한해** 안전하다. router는
  유닉스 소켓이라 성립하고, nginx가 두 헤더를 무조건 덮어쓴다. `ROUTER_MANAGER_ADDR`로
  TCP를 열면 이 전제가 깨진다 — `realClientIP`의 doc comment에 그렇게 적어뒀다.
- `X-Forwarded-For`의 첫 항목은 바깥 프록시가 스푸핑할 수 있다. `X-Real-IP`가 항상
  세팅되므로 실사용에선 폴백이 안 타지만, 백오프 키로 쓸 거면 신뢰 경계를 명시적으로
  정해야 한다(`TRUSTED_PROXIES`와 연결지을지 포함).
- 그냥 두는 선택지도 정당하다: 이 배포는 바깥 forward-auth 뒤에 있고, 전역 백오프의
  실패 모드는 "가끔 다 같이 잠깐 막힘"이지 인증 우회가 아니다.
