package main

import "net/http"

// handleRouterUI serves router-manager's own minimal setup/change-password
// page - a single self-contained HTML file (inline CSS/JS, no build step)
// rather than a full Vite/React app like router/frontend. That package is
// meant to be imported into webmanager's own bundle (see router/frontend's
// doc comments), not served standalone - this page exists specifically so
// a password can be set up before webmanager/an agent ever touches
// anything, reachable at /router/ regardless of whether webmanager itself
// is even configured yet. See router/.claude/router-nginx-hardening-plan.md
// Phase 6 for the onboarding banners that link here.
func handleRouterUI(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(routerUIPage))
}

const routerUIPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>router</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         max-width: 28rem; margin: 4rem auto; padding: 0 1.5rem; }
  h1 { font-size: 1.1rem; margin-bottom: 0.25rem; }
  p.hint { color: #888; margin-top: 0; }
  form { display: flex; flex-direction: column; gap: 0.6rem; margin-top: 1.5rem; }
  input { font: inherit; padding: 0.5rem 0.6rem; border: 1px solid #999; border-radius: 4px; }
  button { font: inherit; padding: 0.55rem; border: none; border-radius: 4px;
           background: #2563eb; color: #fff; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
  .msg { padding: 0.6rem; border-radius: 4px; font-size: 0.9rem; }
  .msg.error { background: #fee2e2; color: #991b1b; }
  .msg.ok { background: #dcfce7; color: #166534; }
  .msg.info { background: #e0e7ff; color: #3730a3; }
</style>
</head>
<body>
<h1>router</h1>
<p class="hint" id="hint">불러오는 중...</p>
<div id="msg"></div>
<form id="form" style="display:none"></form>
<script>
const $hint = document.getElementById('hint');
const $msg = document.getElementById('msg');
const $form = document.getElementById('form');

function showMsg(kind, text) {
  $msg.innerHTML = text ? '<div class="msg ' + kind + '">' + text + '</div>' : '';
}

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('request failed (' + res.status + ')'));
  return data;
}

function field(name, label, placeholder) {
  const wrap = document.createElement('div');
  const l = document.createElement('label');
  l.textContent = label;
  l.style.display = 'block';
  l.style.fontSize = '0.85rem';
  l.style.marginBottom = '0.2rem';
  const i = document.createElement('input');
  i.type = 'password';
  i.name = name;
  i.placeholder = placeholder || '';
  i.required = true;
  i.style.width = '100%';
  i.style.boxSizing = 'border-box';
  wrap.appendChild(l);
  wrap.appendChild(i);
  return wrap;
}

function renderSetup() {
  $hint.textContent = '아직 비밀번호가 설정되지 않았습니다. router-manager(tailscale/Dev Proxy 관리 API)를 보호할 비밀번호를 지금 설정하세요.';
  $form.innerHTML = '';
  $form.appendChild(field('password', '새 비밀번호'));
  const btn = document.createElement('button');
  btn.textContent = '비밀번호 설정';
  $form.appendChild(btn);
  $form.style.display = '';
  $form.onsubmit = async (e) => {
    e.preventDefault();
    btn.disabled = true;
    showMsg('', '');
    try {
      await api('/router/api/auth/setup', { password: $form.password.value });
      showMsg('ok', '설정되었습니다.');
      load();
    } catch (err) {
      showMsg('error', err.message);
    } finally {
      btn.disabled = false;
    }
  };
}

function renderChange(source) {
  if (source === 'env') {
    $hint.textContent = '비밀번호가 ROUTER_MANAGER_AUTH_PASSWORD_HASH 환경변수로 고정되어 있습니다 - 여기서 바꿀 수 없습니다.';
    $form.style.display = 'none';
    return;
  }
  $hint.textContent = '비밀번호가 설정되어 있습니다. 바꾸려면 현재 비밀번호를 입력하세요.';
  $form.innerHTML = '';
  $form.appendChild(field('current', '현재 비밀번호'));
  $form.appendChild(field('next', '새 비밀번호'));
  const btn = document.createElement('button');
  btn.textContent = '비밀번호 변경';
  $form.appendChild(btn);
  $form.style.display = '';
  $form.onsubmit = async (e) => {
    e.preventDefault();
    btn.disabled = true;
    showMsg('', '');
    try {
      await api('/router/api/auth/change', {
        currentPassword: $form.current.value,
        newPassword: $form.next.value,
      });
      showMsg('ok', '변경되었습니다.');
      $form.reset();
    } catch (err) {
      showMsg('error', err.message);
    } finally {
      btn.disabled = false;
    }
  };
}

async function load() {
  try {
    const res = await fetch('/router/api/auth/status', { credentials: 'same-origin' });
    const status = await res.json();
    if (!status.required || status.source === 'unset') {
      renderSetup();
    } else {
      renderChange(status.source);
    }
  } catch (err) {
    $hint.textContent = '';
    showMsg('error', '상태를 불러오지 못했습니다: ' + err.message);
  }
}

load();
</script>
</body>
</html>
`
