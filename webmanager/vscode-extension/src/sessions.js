'use strict'

const http = require('http')
const https = require('https')
const path = require('path')
const vscode = require('vscode')

// Same rule as internal/termsession's ValidateName.
const NAME_RE = /^[\p{L}\p{N} _.-]{1,64}$/u

// Where the extension host reaches webmanager's own API. Never through
// nginx on this origin: NGINX_BLOCK_LOOPBACK refuses loopback clients
// there. code-server inherits the container environment (including
// .env.webmanager), so WEBMANAGER_ADDR is the same value
// `webmanager --attach` uses.
function internalBaseUrl() {
  const configured = vscode.workspace.getConfiguration('webmanager').get('internalUrl')
  if (configured) return configured.replace(/\/+$/, '')
  return 'http://' + (process.env.WEBMANAGER_ADDR || 'private:81')
}

function getJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch (e) {
          reject(e)
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error('timed out')))
    req.on('error', reject)
  })
}

// Live session names via the ungated names-only endpoint (the same one
// `attach`'s shell completion uses). Rejects on any failure - callers
// degrade to "new session only".
async function fetchSessionNames() {
  const names = await getJson(internalBaseUrl() + '/api/terminal/session-names', 2000)
  return Array.isArray(names) ? names.filter((n) => typeof n === 'string') : []
}

// A valid, not-yet-taken name derived from base: disallowed characters
// become '-', and a taken name gets " 2", " 3", ... - the same numbering the
// Terminal tab's own "+" uses.
function uniqueName(base, taken) {
  let clean = String(base || '')
    .replace(/[^\p{L}\p{N} _.-]/gu, '-')
    .trim()
    .slice(0, 60)
  if (!clean) clean = '세션'
  const set = new Set(taken)
  if (!set.has(clean)) return clean
  for (let n = 2; ; n++) {
    const candidate = `${clean} ${n}`
    if (!set.has(candidate)) return candidate
  }
}

function validateName(name, taken) {
  if (!NAME_RE.test(name)) return '글자, 숫자, 공백, _ . - 만 쓸 수 있습니다 (최대 64자)'
  if (taken && taken.includes(name)) return '이미 있는 세션 이름입니다'
  return undefined
}

// The workspace folder of the text editor the user last looked at. Not just
// activeTextEditor: that is empty while a webview tab (one of ours) has
// focus, which is exactly when a view asks for a new session.
let lastEditorUri
function trackActiveEditor(context) {
  const remember = (e) => {
    if (e && e.document.uri.scheme === 'file') lastEditorUri = e.document.uri
  }
  remember(vscode.window.activeTextEditor)
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(remember))
}

function activeFolder() {
  const uri = (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri) || lastEditorUri
  const f = uri && vscode.workspace.getWorkspaceFolder(uri)
  return f && f.uri.scheme === 'file' ? f.uri.fsPath : undefined
}

// On-disk workspace folders, the active editor's first.
function fileFolders() {
  const all = (vscode.workspace.workspaceFolders || []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath)
  const active = activeFolder()
  return active ? [active, ...all.filter((p) => p !== active)] : all
}

// The folder a new session should start in: the active editor's workspace
// folder, else the first one, else none (webmanager's own default).
function defaultCwd() {
  return fileFolders()[0]
}

function folderBase(cwd) {
  return cwd ? path.basename(cwd) : ''
}

module.exports = { NAME_RE, internalBaseUrl, fetchSessionNames, uniqueName, validateName, defaultCwd, activeFolder, trackActiveEditor, fileFolders, folderBase }
