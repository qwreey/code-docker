# Caddy 기반 dev 서버 expose 어댑터 조사 (설계 조사, 미구현 — 우선순위 낮음)

> **이 문서는 구현 전 설계 조사 문서임.** `../../.claude/archive/tailscale-design.md` 와
> 동일한 성격(구현 전 조사 기록) — 구현 착수 시 이 파일을 참고해서 실제 구현 계획으로
> 전환하면 됨. 대부분의 설계 결정은 이 문서 안에서 이미 확정됐지만(아래 "남은 질문"
> 참고), 남은 소소한 결정(`preserve_host` 기본값 등)이 있는 데다 다른 큐(dind/웹쉘)
> 대비 우선순위가 낮게 재조정됨 — `webmanager/plan.md`/`CLAUDE.md` 우선순위 목록 참고.

> 이 저장소의 일반적인 구조/컨벤션(override 패턴, supervisord 프로세스 모델, docker-compose 토폴로지 등)은 저장소 루트의 `CLAUDE.md` 를 참고. `webmanager/` 관련 컨벤션은 `webmanager/CLAUDE.md`, `webmanager/plan.md` 참고.

## 문제 정의

code-docker 안에서 dev 서버(예: `npm run dev` → `localhost:5173`)를 띄울 때마다, 바깥의 공개 도메인(`*.dev.yaeji.moe`)에서 접근 가능하게 하려면 지금은 바깥 리버스 프록시(Caddy 등)의 Caddyfile을 매번 손으로 고쳐야 함. 이걸 없애고, code-docker 쪽에서 "이 포트를 이 이름으로 노출하겠다"고 선언만 하면 바깥은 한 번 설정한 wildcard 규칙 그대로 두고 자동으로 반영되게 만들고 싶음.

## 결정된 방향 (사용자와 논의 후 확정)

1. **라우팅: 서브도메인 우선, 경로 라우팅도 내부적으로 병행 지원.** `*.dev.yaeji.moe` 전체를 바깥 프록시가 code-docker 컨테이너의 단일 포트로 통째로 넘기고, 그 안에서 Caddy가 유연하게 분배함. 서브도메인 하나 안에서 `/`(프론트)와 `/api`(백엔드)를 분리하는 흔한 패턴도 지원 대상.
2. **기존 Tailscale forwards/publish 기능과는 완전히 별개의 서브시스템.** 설정 파일, webmanager 페이지, CLI 모두 새로 만듦. Tailscale publish는 tailnet 전용 경로(`tailscaled` netstack)라 네트워크 경로 자체가 다름.
3. **재구현 없이 컨테이너 내부에 Caddy 인스턴스를 하나 추가.** 커스텀 Caddy 플러그인을 만들어 바깥 Caddy에 물리는 방식은 채택하지 않음 (아래 "왜 플러그인이 아닌가" 참고). 설정 반영은 Caddyfile을 재작성하고 `caddy reload`를 호출하는 방식 — 사용자 자신의 바깥 Caddyfile처럼 관리 영역(managed)과 사용자 자유 영역(snippets/custom)을 import로 분리.
4. **인증은 바깥 리버스 프록시(Authentik forward-auth)에 전적으로 위임.** 내부 Caddy와 webmanager는 인증을 신경쓰지 않음 — 루트 `CLAUDE.md`에 이미 명시된 신뢰 모델과 동일.

## 왜 커스텀 플러그인이 아닌가

처음 아이디어(`code-docker-adapter` 같은 Caddy 플러그인을 바깥 Caddy에 심어서 code-docker와 통신)를 검토했으나 기각함:

- 플러그인은 바깥이 **Caddy여야만** 동작함 — 사용자가 나중에 다른 웹서버(nginx, Traefik 등)로 바꾸면 이 기능 전체가 무의미해짐. 컨테이너 내부에 Caddy를 두면 바깥이 뭐든 상관없이 "와일드카드 도메인을 이 포트 하나로 리버스 프록시" 규칙 한 줄만 있으면 됨.
- Caddy 플러그인은 Go로 작성하고 **Caddy 바이너리 자체를 다시 빌드**해야 함(`xcaddy`) — 바깥 인프라의 Caddy 이미지/빌드 파이프라인까지 이 프로젝트에 종속시키는 셈이라 유지보수 비용이 큼.
- 내부에 Caddy를 놓는 방식은 사실상 "동적 리버스 프록시 라우팅 테이블"을 원하는 것뿐이고, Caddy 자체가 이미 이걸 아주 잘함(Caddyfile 하나로 host/path 매칭 + reverse_proxy). 재발명할 이유가 없음.
- Caddy는 단일 정적 바이너리라 컨테이너에 얹기 쉽고, 이 프로젝트의 "override 패턴 + supervisord program" 구조에 프로세스 하나 추가하는 것과 동일한 작업으로 끝남 (Arch `extra` 저장소에 `caddy` 패키지가 존재 — AUR 불필요, `pacman -S caddy`로 바로 설치 가능. ([Official repositories - ArchWiki](https://wiki.archlinux.org/title/Official_repositories)))

## 라우팅 설계

### 핵심 패턴: 와일드카드 사이트 블록 + host 매처

Caddy의 사이트 주소(site address)에서 `*`는 호스트네임의 정확히 한 레이블만 대응함 (`*.dev.yaeji.moe`처럼). 이 wildcard 블록 안에서 `@name host name.dev.yaeji.moe` 형태의 매처로 서브도메인별 분기가 가능함 — 즉 expose 항목마다 사이트 블록을 따로 만들 필요 없이, **바깥 껍데기(wildcard 사이트 블록) 하나 + 항목별 매처/handle 조각을 `import`로 이어붙이는** 식으로 구성할 수 있음. host 매처는 여러 개를 OR로 묶을 수도 있음. (실제로 이 조각들을 파일 단위로 어떻게 나눌지는 뒤의 "Caddyfile 구성"/"`.caddy` 파일 예시" 절 참고 — 여기서는 메커니즘만 설명.)

```caddyfile
# 개념 예시 - 항목이 늘어날 때마다 @name/handle 쌍이 하나씩 추가되는 구조
http://*.dev.yaeji.moe:8082 {
	@myapp host myapp.dev.yaeji.moe
	handle @myapp {
		handle /api/* {
			reverse_proxy 127.0.0.1:5174
		}
		handle {
			reverse_proxy 127.0.0.1:5173
		}
	}

	@otherapp host otherapp.dev.yaeji.moe
	handle @otherapp {
		reverse_proxy 127.0.0.1:9000
	}

	# 매칭되는 expose가 없는 서브도메인
	handle {
		respond 404
	}
}
```

- 주소를 `http://...`로 명시하면(또는 전역 옵션 `auto_https off`) Caddy가 자체 TLS/ACME를 시도하지 않음 — 이 인스턴스는 HTTPS를 절대 신경쓰지 않아야 하므로(바깥이 전담) 둘 중 하나는 반드시 필요. 전역 옵션 쪽이 실수로 `http://`를 빠뜨릴 걱정이 없어 더 안전 — 최상위 `Caddyfile` 맨 위에 `{ auto_https off }` 를 고정으로 넣는 쪽을 권장.
- 경로 기반(순수 `dev.yaeji.moe/myapp/*` 같은 base-path 노출)도 기술적으로는 `handle_path`로 지원 가능하지만, 사용자가 지적한 대로 대부분의 dev 서버(Vite 등)가 절대경로로 asset을 서빙해서 base path를 앱마다 맞춰줘야 하는 문제가 있음 — **1순위는 서브도메인, 경로 분리는 "한 서브도메인 안에서 `/`와 `/api`를 나누는" 용도로만 default 지원**하고, 순수 경로 기반 노출은 필요해지면 그때 추가하는 쪽으로 남겨둠 (YAGNI).

### 알려진 함정: `reverse_proxy`는 기본적으로 upstream에 보내는 `Host` 헤더를 업스트림 주소로 바꿈

`reverse_proxy`는 클라이언트가 보낸 헤더를 대부분 그대로 전달하지만, 예외가 있음: **`Host` 헤더는 업스트림의 `host:port`로 재작성됨** (원본 값은 `X-Forwarded-Host`로 별도 전달). 대부분의 경우 문제 없지만, **Vite dev 서버는 기본적으로 `Host` 헤더 검증(`server.allowedHosts`)을 함** — 프록시 뒤에서 낯선 Host로 오는 요청을 거부할 수 있음. 두 가지 대응 옵션:
1. `reverse_proxy` 블록에 `header_up Host {host}`를 추가해서 원본 Host를 그대로 전달 (Caddy 쪽에서 흉내), 또는
2. 노출 대상 dev 서버 설정에서 `allowedHosts`에 해당 서브도메인을 추가하도록 안내 (Vite류 도구의 일반적 해법).

관리 Caddyfile 생성 시 `header_up Host {host}`를 기본으로 넣어주는 쪽이 사용자 입장에서 매번 앱 설정을 손대지 않아도 되어 더 나아 보임 — 구현 시 결정.

웹소켓(HMR 등)은 Caddy `reverse_proxy`가 자동으로 처리하므로 별도 설정 불필요.

## Caddyfile 구성: 관리 영역(파일 단위) + 사용자 자유 영역

사용자의 바깥 Caddyfile이 `import snippets/*`, `import *.caddyimport domain/*` 패턴을 쓰는 것과 동일한 개념을 내부에도 적용하되, 관리 영역도 **단일 생성 파일이 아니라 expose 하나당 파일 하나**로 나눔 (이유는 아래 "방향 전환" 절 — YAML 스키마를 버리고 `.caddy` 파일 자체를 편집하는 도구로 방향을 바꿨기 때문). `import` 디렉티브는 글롭을 지원하고(`*` 하나만, 다중 와일드카드 금지), `.`으로 시작하는 파일은 자동 스킵됨. ([import (Caddyfile directive)](https://caddyserver.com/docs/caddyfile/directives/import))

```
/code/.caddy-adapter/
├── Caddyfile              # 최상위 파일, caddy가 이걸 로드 (고정, 거의 안 바뀜)
├── managed/                # expose 하나당 파일 하나 - webmanager 폼 또는 CodeEditor로 직접 편집 (아래 "방향 전환" 참고)
│   ├── myapp.caddy
│   └── legacy-app.caddy
└── custom/                 # webmanager가 관여하지 않는, 사용자가 완전히 직접 쓰는 영역 (다른 도메인의 사이트 블록 등)
    └── *.caddy
```

```caddyfile
# /code/.caddy-adapter/Caddyfile
{
	auto_https off
}

http://*.dev.yaeji.moe:8082 {
	import /code/.caddy-adapter/managed/*.caddy

	handle {
		respond 404
	}
}

import /code/.caddy-adapter/custom/*.caddy
```

- `managed/*.caddy` 각 파일의 내용은 아래 "`.caddy` 파일 예시" 절 참고 — `@name host ...` 매처 + `handle` 블록 하나가 파일 하나.
- `custom/`은 `managed/`가 감당 못 하는 것 전부 — 다른 도메인용 사이트 블록을 통째로 추가하거나, rate limit 같은 wildcard 블록 밖의 고급 설정을 쓸 때.

## 설정 반영 흐름 (파일 저장 + `caddy reload`)

`caddy reload`는 파일을 다시 읽어 JSON으로 adapt한 뒤 **무중단으로** 활성 설정을 교체함 — 새 설정이 먼저 뜨고 나서 이전 설정이 내려가므로 짧은 시간 동안 둘 다 떠있는 구조이고, 새 설정에 오류가 있으면 이전 설정으로 자동 롤백됨. 즉 `managed/*.caddy` 파일 하나를 쓰고 `caddy reload` 한 번이면 충분하고, 다른 expose에 연결 중인 클라이언트가 끊기지 않음. ([caddy reload](https://caddyserver.com/docs/command-line))

관리 API(`localhost:2019`, Caddy 기본값)는 기본적으로 loopback에만 바인드되므로 별도 하드닝 없이도 컨테이너 밖에는 노출 안 됨 — `caddy reload`가 내부적으로 이 API를 사용.

### 방향 전환: YAML→생성이 아니라 "Caddyfile 자체를 편집하는 도구"

처음엔 `config.yaml`(선언적 스키마) → `managed.caddy` 자동생성이라는, tailscale의 `config.yaml`+`yq` 패턴을 그대로 가져오려 했음. 하지만 사용자가 명확히 한 방향은 다름: **YAML 스키마를 새로 설계하는 대신, webmanager가 Caddyfile 조각(`.caddy` 파일) 자체를 편집하는 도구가 되어야 함.** 즉 "선언적 설정 → Caddy 문법으로 컴파일"이 아니라 "Caddy 문법을 직접, 하지만 편하게 편집"하는 쪽. 이러면 YAML 스키마가 표현 못 하는 case를 만날 때마다 스키마를 확장해야 하는 문제 자체가 사라짐 — Caddyfile 문법이 표현 못 하는 게 없으므로.

구체적 설계:

- **expose 하나 = `.caddy` 파일 하나.** `managed.caddy`처럼 전부 합쳐진 단일 파일이 아니라, `/code/.caddy-adapter/managed/myapp.caddy`, `.../otherapp.caddy`처럼 항목별로 분리. "새 expose 추가" = 새 파일 하나 생성.
- **일반적인 설정은 webmanager UI의 구조화된 폼으로**: 이름(서브도메인), target, 경로 분리(uri strip 포함), 헤더 추가/치환 같은 흔한 패턴 — `handle`/`route`/`reverse_proxy`/`header`/`uri strip_prefix` 정도만 다루는 작은 폼. 폼이 저장하는 것도 결국 `.caddy` 텍스트 파일이라, 폼이 못 다루는 걸 만나면 그냥 아래로 내려가서 직접 고치면 됨 (폼 ↔ 텍스트 사이 벽이 없음 — 다만 폼으로 만든 걸 텍스트로 손댄 뒤 다시 폼으로 열면 그 폼이 이해 못하는 구조로 바뀌어 있을 수 있음, 이 경우 "이 파일은 더 이상 폼으로 편집 불가, 텍스트 전용" 취급하는 정도의 얕은 감지만 있으면 충분해 보임).
- **깊은/특이 케이스는 텍스트 에디터**로 직접 `.caddy` 파일을 편집 — **이제 새로
  고를 필요 없이 이미 있는 `src/components/common/{CodeEditor,LazyCodeEditor,
  ExpandableEditor}.tsx`(CodeMirror 6, 지연 로딩 청크 분리, git raw 설정 편집/
  파일 매니저가 이미 재사용 중)를 그대로 씀 — 원래 이 문서가 고민하던 "Monaco
  도입" 질문 자체가 해소됨. Caddyfile 전용 문법 하이라이팅은 아직 없음
  (`CodeEditorProps.language`가 지금은 `'ini' | 'plain'`만 지원) — 필요해지면
  Lezer 문법을 하나 추가하는 정도의 작업, CodeMirror 6가 커스텀 언어 등록을
  지원하므로 기술적으로 막히지 않음.
- **적용 전 검증**: 저장/reload 하기 전에 Caddy 자신의 admin API `POST http://localhost:2019/adapt` (`Content-Type: text/caddyfile`)로 문법 검증 — 여기서 에러가 나면 reload 하지 않고 UI에 에러 그대로 보여줌. Caddy CLI의 `caddy adapt`/`caddy validate`와 동일한 경로. ([Config Adapters — Caddy Documentation](https://caddyserver.com/docs/config-adapters))
- **적용**: 파일 저장 후 `caddy reload` 한 번 — 위 "설정 반영 흐름"과 동일, 무중단.

이 방향이면 애초에 "생성 로직을 Go가 가질지 셸이 가질지"라는 질문 자체가 사라짐 — webmanager 백엔드가 하는 일은 `.caddy` 파일 CRUD + `/adapt` 검증 + `caddy reload` 트리거뿐이고, 이건 이미 webmanager가 다른 설정 파일들(git config 등)에 쓰는 패턴과 동일함.

### 참고할 만한 기존 오픈소스 (바퀴 재발명 방지용 조사)

Caddyfile을 다루는 웹 UI를 만든 프로젝트가 이미 여럿 있음 — 그대로 가져다 쓸 필요는 없지만 UI 아이디어(문법 하이라이팅, 실시간 검증, `caddy fmt` 연동, 백업/버전 이력)는 참고할 만함:

- [Complexicon/caddyfile-editor](https://github.com/Complexicon/caddyfile-editor) — Caddyfile 전용 웹 에디터, 실시간 검증
- [zackwag/caddy-ui](https://github.com/zackwag/caddy-ui) — 문법 하이라이팅 + `caddy fmt` + 버전 이력/롤백까지 갖춘 좀 더 완성된 예시
- [makinghappen/caddy-ui](https://github.com/makinghappen/caddy-ui) — 트리 기반 구조화 편집 (Caddyfile이 아니라 JSON config를 직접 다루는 쪽에 가까움)
- [caddymanager.online](https://caddymanager.online/) — Caddy 서버 자체를 원격 관리하는 좀 더 무거운 도구

이 프로젝트의 요구사항(단일 컨테이너 내부의 dev-proxy 전용 인스턴스, 인증은 바깥에 위임, expose 단위 CRUD)에는 이런 범용 도구보다 훨씬 작은 스코프로 충분하므로 그대로 갖다 쓰기보다는 "필요한 UI 패턴만 참고"하는 쪽을 권장.

## `.caddy` 파일 예시 (스키마 대신 실제 산출물)

```caddyfile
# /code/.caddy-adapter/managed/myapp.caddy — webmanager 폼으로 생성/편집됨
@myapp host myapp.dev.yaeji.moe
handle @myapp {
	handle /api/* {
		reverse_proxy 127.0.0.1:5174 {
			header_up Host {host}
		}
	}
	handle {
		reverse_proxy 127.0.0.1:5173 {
			header_up Host {host}
		}
	}
}
```

```caddyfile
# /code/.caddy-adapter/managed/legacy-app.caddy
@legacy-app host legacy-app.dev.yaeji.moe
handle @legacy-app {
	reverse_proxy dind:9000    # dind 내부 컨테이너 - "dind" alias 사용
	                           # (루트 CLAUDE.md: dind 내부 컨테이너는 code-docker-internal에서
	                           # 이름으로 직접 안 보이고 dind:<포트>로만 접근 가능)
}
```

바깥 wildcard 사이트 블록(`http://*.dev.yaeji.moe:8082 { ... }`)이 이 `managed/*.caddy` 조각들을 감싸는 고정 껍데기 — 정확한 형태는 앞의 "Caddyfile 구성" 절의 `Caddyfile` 예시 참고.

## CLI 설계 초안 — `bin/dev-expose`

기존 `bin/forward-reload`처럼 얇은 래퍼. webmanager 로컬 API(`http://localhost:81/api/...`)를 호출 — 인증 없음(컨테이너 내부에서만 호출된다는 전제는 webmanager의 기존 신뢰 모델과 동일), 로직 중복 없이 webmanager가 가진 검증+reload 경로를 그대로 재사용:

```sh
dev-expose add myapp --target 127.0.0.1:5173 [--path /api/*=127.0.0.1:5174] [--no-preserve-host]
dev-expose edit myapp     # $EDITOR로 managed/myapp.caddy를 직접 열어 편집 (구조화 폼이 못 다루는 케이스용)
dev-expose remove myapp
dev-expose list
dev-expose reload         # 파일 변경 없이 검증 + caddy reload만 다시 트리거
```

정확한 플래그 형태는 webmanager API 스펙이 정해진 뒤 구현 시점에 확정.

## 네트워크 노출 — 사용자가 알아서 구성, README에 안내만

이건 code-docker가 강제할 일이 아니라 **사용자의 인프라 배치에 달린 문제**로 확정 — 바깥 리버스 프록시가 도커 컨테이너로 떠있어서 같은 도커 네트워크에 조인하면 바로 붙는 환경도 있고, 아니라면 다른 서비스들(code-server 80, webmanager 81)처럼 그냥 호스트 포트 하나를 퍼블리시해서 쓰면 됨 — 둘 다 이미 docker-compose가 지원하는 일반적인 방식이라 code-docker 쪽에서 특별히 뭘 결정하거나 강제할 필요가 없음.

README에는 "이 포트를 바깥 프록시에 연결하는 법" 정도의 짧은 절만 추가 — nginx/Caddy 두 가지로 대충 예시 하나씩만 언급해도 충분 (nginx `proxy_pass`, Caddy `reverse_proxy` 한 줄씩). 구현 시 정확한 포트 번호는 다른 내부 포트들(2019 admin API 등)과 안 겹치게 고르기만 하면 됨 — 그 이상의 설계 결정 없음.

### Tailscale과의 상호작용 (보안 주의사항, `../../.claude/archive/tailscale-design.md` 참고) — 호스트 포트 퍼블리시를 택할 경우에만 해당

`../../.claude/archive/tailscale-design.md`에서 확인한 대로, tailscaled의 userspace netstack은 **호스트 포트 퍼블리시를 위해 `0.0.0.0`에 바인드된 모든 포트를 조건 없이 tailnet에도 자동 재노출**함 (sshd/code-server가 이미 이 카테고리). 사용자가 위에서 호스트 포트 퍼블리시 방식을 택하면 이 새 Caddy 인스턴스도 같은 카테고리에 들어감 — 즉 tailnet에 있는 아무 기기나(ACL로 code-docker 접근이 허용된 경우) 도메인 인증 없이 이 포트로 직접 들어와 모든 expose에 접근할 수 있게 됨. (공유 도커 네트워크 방식만 쓰고 호스트 포트를 안 열면 이 문제 자체가 없음.)

**대응**: 호스트 포트를 퍼블리시하기로 한 경우, 루트 `CLAUDE.md`/README에 이미 있는 "sshd(22), code-server(80)는 tailnet ACL grant가 유일한 방어선" 목록에 이 포트도 추가해야 함 — README의 tailnet ACL grant 예시(`{ "dst": ["tag:code-docker"], "ip": ["tcp:22", "tcp:80"] }`)에 이 새 포트 번호를 넣어 문서화할 것. README의 새 "dev 서버 노출" 절에서 이 캐비앗을 명시적으로 언급.

## 빌드/설정 변경사항 초안 (구현 시 참고용, 미구현)

- `config/build.default.sh`: `caddy` 패키지 추가 (Arch `extra`, AUR 불필요)
- `script/caddy-adapter.sh` + `config/caddy-adapter.default.sh` (기존 override 패턴): 최초 부팅 시 `/code/.caddy-adapter/`에 `Caddyfile`(고정 껍데기) + `managed/`(빈 디렉터리) + `custom/` 시드, 이후 `caddy run --config /code/.caddy-adapter/Caddyfile --adapter caddyfile` 실행
- `config/supervisord.default.conf`: `[program:caddy-adapter]` 추가 (다른 program들과 동일하게 stdout/stderr 로그 경로 패턴 유지)
- `docker-compose.yml`: 필요 시 새 포트 퍼블리시 (위 "네트워크 노출" 절 참고 — 사용자가 자신의 배치에 맞게 직접 결정하는 영역이라 code-docker 기본값으로 강제하지 않음)
- webmanager 백엔드: `managed/*.caddy` 파일 CRUD API + `/adapt` 검증 호출 + `caddy reload` 트리거 (핸들러 위치는 `handlers_tailscale.go` 같은 기존 핸들러들과 동일한 패턴)
- webmanager 프론트엔드: 새 페이지 (예: "Dev Proxy" 또는 "Expose") — expose 목록, 구조화된 생성/수정 폼(이름/타겟/경로분리/헤더), 기존 `ExpandableEditor`/`CodeEditor` 기반 raw 편집 fallback, 최근 reload 결과 표시
- `bin/dev-expose`: webmanager 로컬 API를 호출하는 CLI 래퍼
- README.md: 새 "tips" 절 추가 (dev 서버 노출 방법, 바깥 프록시 연결 예시(nginx/Caddy), 호스트 포트 퍼블리시를 택했을 때 tailnet ACL grant 추가 필요성 — 기존 tailscale/ssh/adb 절과 같은 톤)
- `webmanager/plan.md`/`CLAUDE.md`: 우선순위 목록 반영 완료 — mise보다도 아래로 내려감
  (남은 결정이 많아 우선순위를 낮게 두기로 재조정, 아래 "남은 질문" 4번 참고)

## 남은 질문 / 구현 착수 전 확정 필요

1. ~~네트워크 노출 방식~~ — 해결: code-docker가 강제하지 않고 README에 안내만 (위 "네트워크 노출" 절 참고).
2. ~~생성 로직 위치~~ — 해결: YAML 생성 방식을 버리고 "`.caddy` 파일 자체를 편집하는 도구" 방향으로 전환 (위 "방향 전환" 절 참고), Go/셸 중 어디가 소유하냐는 질문 자체가 사라짐.
3. **`preserve_host`(`header_up Host {host}`) 기본값** — 급하지 않음, 나중에 결정해도 됨 (아래 "preserve_host 상세" 참고). 폼이 생성하는 템플릿의 기본 스위치 하나일 뿐이라 바꾸기 쉬움.
4. **webmanager 우선순위 배치** — 재조정됨: 애초엔 "웹 터미널 다음, mise 이전"으로 뒀으나,
   남은 결정(특히 `preserve_host` 기본값 같은 디테일)이 아직 여럿 남아있어 mise보다도
   아래로 내림 — dind/웹쉘 큐가 끝난 뒤 가장 마지막에 착수. 문서 반영 완료
   (`plan.md`/`CLAUDE.md`).
5. ~~`base_domain` 다중 지원~~ — 해결(아래 "base_domain 관련 재질문" 참고): YAML 스키마를 버렸으므로 애초에 스키마가 도메인 개수를 제한할 이유가 없어짐 — `custom/`이나 `managed/`에 다른 도메인용 wildcard 사이트 블록을 얼마든지 추가 가능. 남은 건 UI 쪽 "빠른 생성 폼이 기본으로 어떤 도메인을 붙여줄지"라는 훨씬 작은 UX 질문뿐.

### `preserve_host` 상세 설명

`reverse_proxy`가 업스트림(dev 서버)에 보내는 요청의 `Host` 헤더는 기본적으로 **업스트림 주소 자체**(`127.0.0.1:5173`)로 바뀜 — 클라이언트가 실제로 접속한 `myapp.dev.yaeji.moe`라는 값은 별도의 `X-Forwarded-Host` 헤더로만 전달됨. 대부분의 앱은 신경 안 쓰지만, **Vite 개발 서버는 기본적으로 `Host` 헤더를 검사해서 모르는 값이면 요청 자체를 막음** (`server.allowedHosts`, 흔히 프록시 뒤에서 "Blocked request. This host is not allowed" 에러로 나타남) — 이 프로젝트가 노리는 정확히 그 시나리오(리버스 프록시 뒤의 Vite dev 서버)에서 실제로 부딪힐 수 있는 문제.

두 가지 대응이 가능:
1. Caddy 쪽에서 `header_up Host {host}`를 추가해 원래 Host를 그대로 넘겨주기 (프록시가 대신 처리, 앱 설정 불필요)
2. 앱(Vite 등) 쪽 설정에서 `allowedHosts`에 서브도메인을 추가하기 (앱마다 따로 설정 필요)

**당장 결정하지 않아도 되는 이유**: 이건 생성 템플릿의 스위치 하나(폼에 체크박스 하나, 또는 생성되는 `.caddy` 조각의 한 줄)일 뿐이고, 나중에 기본값을 바꾸거나 expose마다 다르게 설정하는 것도 쉬움 — 지금 잘못 정해도 나중에 갈아엎는 비용이 거의 없는 종류의 결정. 다만 **기본값을 뭘로 하든** README나 UI에 "Vite 쓰면 `allowedHosts` 관련 이슈가 있을 수 있다"는 안내 한 줄은 필요해 보임.

### `base_domain` 관련 재질문에 대한 설명

원래 질문의 의도는 "Caddy가 여러 도메인을 처리할 수 있냐"가 아니라(당연히 됨), **YAML 설정 스키마에 `base_domain: dev.yaeji.moe`라는 단일 문자열 필드를 뒀을 때, 나중에 `*.dev.yaeji.moe`와 `*.staging.yaeji.moe`를 동시에 이 인스턴스로 처리하고 싶어지면 스키마를 고쳐야 하는가**였음. 그런데 위 "방향 전환"에서 YAML 스키마 자체를 버리고 Caddyfile 조각을 직접 다루는 쪽으로 정리했기 때문에, 이 질문은 자동으로 해소됨 — 새 도메인이 필요해지면 그냥 `custom/`(또는 향후 `managed/`)에 `*.staging.yaeji.moe:8082 { ... }` 같은 사이트 블록을 하나 더 추가하면 끝. 스키마가 없으니 스키마 확장 문제도 없음.

## 참고 자료

- [Automatic HTTPS — Caddy Documentation](https://caddyserver.com/docs/automatic-https)
- [Global options (Caddyfile) — Caddy Documentation](https://caddyserver.com/docs/caddyfile/options)
- [Caddyfile Concepts — Caddy Documentation](https://caddyserver.com/docs/caddyfile/concepts)
- [Common Caddyfile Patterns — Caddy Documentation](https://caddyserver.com/docs/caddyfile/patterns)
- [Request matchers (Caddyfile) — Caddy Documentation](https://caddyserver.com/docs/caddyfile/matchers)
- [import (Caddyfile directive) — Caddy Documentation](https://caddyserver.com/docs/caddyfile/directives/import)
- [reverse_proxy (Caddyfile directive) — Caddy Documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
- [caddy reload — Caddy Documentation](https://caddyserver.com/docs/command-line)
- [Config Adapters — Caddy Documentation](https://caddyserver.com/docs/config-adapters) (`/adapt` 엔드포인트, `caddy adapt`)
- [Official repositories - ArchWiki](https://wiki.archlinux.org/title/Official_repositories) (Arch `extra`의 `caddy` 패키지 확인)
- [Configuring Caddy with Wildcard Subdomains](https://sirfitz.medium.com/configuring-caddy-with-wildcard-subdomains-eadcd7ad9cff)
- [Complexicon/caddyfile-editor](https://github.com/Complexicon/caddyfile-editor), [zackwag/caddy-ui](https://github.com/zackwag/caddy-ui), [makinghappen/caddy-ui](https://github.com/makinghappen/caddy-ui), [Caddy Manager](https://caddymanager.online/) — 기존 Caddyfile 웹 에디터 프로젝트 (UI 패턴 참고용)
- `../../.claude/archive/tailscale-design.md` (레포 루트) — tailnet 자동 포워딩/ACL grant 배경
