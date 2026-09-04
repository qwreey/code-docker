# File share (WebDAV)

다른 기기에서 code-docker의 파일을 올리고 내리기 위한 WebDAV 공유입니다. sftp와
달리 전용 클라이언트가 필요 없고, 윈도우 탐색기·macOS Finder·안드로이드 파일
관리자에서 **네트워크 드라이브처럼 마운트**해서 그냥 끌어다 놓으면 됩니다.

webmanager의 **File share** 탭에서 켜고 끕니다. 기본은 꺼짐이고, 비밀번호를
만들기 전에는 켜도 아무것도 서빙하지 않습니다(fail-closed — 이 상태에서 공유
주소는 그냥 404입니다).

> webmanager의 **Files** 탭(브라우저 안 파일 관리자)을 대체하는 게 아닙니다.
> 브라우저는 WebDAV를 마운트할 수 없어서 Files 탭은 계속 자기 API를 씁니다.
> 둘은 같은 폴더를 서로 다른 방식으로 보여주는 것뿐입니다 — WebDAV는 "OS에서
> 드래그 앤 드롭", Files 탭은 "브라우저 안에서 관리".

---

## ⚠️ 먼저 읽어야 할 것: forward-auth에서 제외해야 합니다

code-docker는 바깥 리버스 프록시가 forward-auth(Authentik, tinyauth 등)로 앞을
막아준다는 전제로 되어 있습니다([security-login.md](../security-login.md) 참고).
**WebDAV 클라이언트는 브라우저 SSO 리다이렉트를 못 탑니다** — 탐색기/Finder/Solid
Explorer가 아는 건 Basic auth뿐이라, 로그인 페이지로 리다이렉트되는 순간 그냥
실패합니다.

그래서 이 경로는 바깥 forward-auth에서 **반드시 제외해야** 하고, 제외하는 순간
File share 탭에서 만든 비밀번호가 그 경로를 지키는 **유일한** 수단이 됩니다.
비밀번호를 webmanager 게이트와 분리해 둔 건 취향이 아니라 이 때문입니다.

경로 단위 예외(`/webdav/`만 빼기)보다 **호스트 단위 예외**가 실수가 훨씬 적으므로,
아래 "전용 호스트네임" 방식을 권장합니다.

---

## 전용 호스트네임으로 내보내기 (권장)

code-docker의 in-container nginx는 WebDAV 전용 리스너를 하나 더 띄웁니다
(`NGINX_WEBDAV_PORT`, 기본 82). 이 포트에서는 `/webdav` 외의 모든 경로가 404라서,
router vhost로 호스트네임 하나를 통째로 줘도 code-server가 같이 노출되지 않습니다.

`.env.router`에 한 줄:

```sh
ROUTER_VHOST_WEBDAV="dav.example.com=code-docker:82"
```

(`PREFIX`를 쓰는 다중 인스턴스라면 컨테이너 이름도 `myprefix-code-docker:82`처럼
접두사가 붙습니다.)

그리고 바깥 리버스 프록시에서 이 호스트네임만 forward-auth 없이 router로
보냅니다. Caddy 예시:

```caddyfile
dav.example.com {
    reverse_proxy 10.0.0.5:80 {
        # forward_auth 없음 — 인증은 code-docker의 WebDAV 비밀번호가 담당합니다.
    }
    request_body {
        max_size 0
    }
}
```

마운트 주소는 `https://dav.example.com/webdav/` 입니다. 경로 부분(`/webdav/`)은
전용 호스트네임을 쓰든 아니든 **항상 같습니다** — WebDAV 응답의 `<D:href>`가 그
경로를 그대로 담기 때문에, 프록시에서 경로를 바꿔 쓰면 클라이언트가 따라가지
못합니다.

## 기존 호스트네임의 경로로 내보내기

포트 80(code-server와 같은 origin)에도 같은 `/webdav/` 경로가 열려 있습니다.
전용 호스트네임을 못 쓸 때만 쓰세요 — 바깥 프록시에서 그 경로 하나만 골라
forward-auth를 빼야 하는데, 경로 예외는 빠뜨리거나 잘못 쓰기 쉽습니다.

```caddyfile
code.example.com {
    @dav path /webdav /webdav/*
    handle @dav {
        reverse_proxy 10.0.0.5:80
    }
    handle {
        forward_auth ... # 나머지는 평소대로
        reverse_proxy 10.0.0.5:80
    }
}
```

---

## 켜기

1. webmanager → **File share** 탭
2. **무작위 비밀번호 생성** — 만들어진 비밀번호는 **이 화면에서 한 번만** 보입니다
   (서버에는 argon2id 해시만 저장됩니다). 바로 복사해 두세요.
3. **WebDAV 공유 사용** 체크 → 저장

사용자명은 기본 `webdav`이고 같은 탭에서 바꿀 수 있습니다.

호스트 쪽에서 값을 고정하고 싶다면 `.env.webmanager`의
`WEBMANAGER_WEBDAV_ENABLED` / `WEBMANAGER_WEBDAV_USER` /
`WEBMANAGER_WEBDAV_PASSWORD_HASH`를 쓰세요. 비어 있지 않은 값을 넣으면 그 항목은
탭에서 잠기고, 잠긴 이유가 화면에 표시됩니다.

### 공유 범위 좁히기

기본 공유 폴더는 Files 탭과 같은 `/code` 전체입니다. 파일을 주고받는 용도로만
쓴다면 `WEBMANAGER_WEBDAV_ROOT`로 하위 폴더 하나로 좁히는 편이 낫습니다:

```sh
WEBMANAGER_WEBDAV_ROOT=/code/Shared
```

`/code` 전체를 공유하면 WebDAV로 붙은 쪽이 `/code/.bashrc`나 공유 설정 파일
자체를 포함해 **홈 디렉터리 전부를 쓸 수 있다**는 뜻입니다. 이 컨테이너 안에서는
어차피 전부 root로 도니 그 자체가 권한 상승은 아니지만, 비밀번호 하나가 그만큼을
지고 있다는 건 알고 쓰는 게 좋습니다.

---

## 기기별 마운트 방법

**Windows 탐색기** — 탐색기 → 내 PC → "네트워크 드라이브 연결" →
`https://dav.example.com/webdav/`. Windows 기본 WebDAV 클라이언트는 HTTPS가
아니면 Basic auth를 거부하고, 큰 파일에 제약이 있습니다. 잘 안 되면
[WinSCP](https://winscp.net)나 [RaiDrive](https://www.raidrive.com)를 쓰세요.

**macOS Finder** — Finder → 이동 → 서버에 연결(⌘K) →
`https://dav.example.com/webdav/`

**Android** — [Solid Explorer](https://play.google.com/store/apps/details?id=pl.solidexplorer2)
나 Material Files에서 WebDAV 연결 추가. 주소/사용자명/비밀번호만 넣으면 됩니다.

**rclone** (CLI, 어느 OS든)

```sh
rclone config create codedav webdav \
    url=https://dav.example.com/webdav/ \
    vendor=other user=webdav pass="$(rclone obscure '비밀번호')"
rclone ls codedav:
rclone mount codedav: ~/mnt/code-docker  # FUSE 마운트
```

---

## 잘 안 될 때

- **404가 온다** → 공유가 꺼져 있거나 비밀번호가 없습니다(둘 다 fail-closed로
  404입니다). File share 탭의 "상태" 카드가 이유를 그대로 알려줍니다.
- **로그인 페이지로 튕긴다 / 인증이 반복된다** → 바깥 forward-auth를 아직 안
  뺐습니다. 위의 "먼저 읽어야 할 것" 참고.
- **비밀번호가 맞는데 401** → 사용자명도 확인하세요(기본 `webdav`). 틀린 시도가
  연속 5번을 넘으면 IP별로 잠시 잠깁니다 — 이때는 401이 아니라 429가 옵니다.
- **큰 파일 업로드가 끊긴다** → 바깥 프록시의 요청 본문 크기 제한을 확인하세요.
  code-docker 쪽 nginx는 이미 무제한(`client_max_body_size 0`)에 버퍼링을 끈
  상태로 스트리밍합니다.
- **폴더는 보이는데 파일이 안 열린다** → 공유 폴더 밖을 가리키는 심볼릭 링크는
  일부러 막혀 있습니다(Files 탭과 같은 규칙).

## 알아둘 제약

- 잠금(WebDAV LOCK)은 메모리에만 있습니다. webmanager가 재시작하면 잠금이 사라지므로,
  여러 기기에서 같은 파일을 동시에 편집하는 용도로는 적합하지 않습니다.
- 읽기 전용 공유 옵션은 아직 없습니다. 붙을 수 있는 쪽은 쓰기도 할 수 있습니다.
