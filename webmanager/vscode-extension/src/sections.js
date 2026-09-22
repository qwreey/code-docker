'use strict'

// webmanager's tabs, in sidebar order. Hand-kept copy of
// webmanager/frontend/src/components/Layout/sections.ts (id + label) - the
// extension has no build step to import it from, so a section added there
// has to be added here too to show up in "Open webmanager Tab…". A missing
// entry is harmless beyond that: the extension never validates what a view
// is showing, it only uses this list to offer choices and to label tabs.
const SECTIONS = [
  { id: 'terminal', label: 'Terminal', icon: 'terminal' },
  { id: 'files', label: 'Files', icon: 'files' },
  { id: 'projects', label: 'Projects', icon: 'repo' },
  { id: 'vnc', label: 'VNC', icon: 'vm' },
  { id: 'logs', label: 'Logs', icon: 'output' },
  { id: 'processes', label: 'Task Manager', icon: 'pulse' },
  { id: 'supervisor', label: 'Supervisor', icon: 'server-process' },
  { id: 'claude', label: 'Claude Code', icon: 'sparkle' },
  { id: 'sessions', label: 'Sessions', icon: 'history' },
  { id: 'dind', label: 'Docker (dind)', icon: 'package' },
  { id: 'mise', label: 'mise', icon: 'tools' },
  { id: 'extensions', label: 'Code Extensions', icon: 'extensions' },
  { id: 'ssh-keys', label: 'SSH Keys', icon: 'key' },
  { id: 'git-config', label: 'Git Config', icon: 'git-branch' },
  { id: 'fonts', label: '폰트', icon: 'text-size' },
  { id: 'file-share', label: 'File share', icon: 'cloud' },
  { id: 'dev-proxy', label: 'Dev Proxy', icon: 'globe' },
  { id: 'app-routes', label: 'App Routes', icon: 'link' },
  { id: 'tailscale', label: 'Tailscale', icon: 'remote' },
  { id: 'dns', label: 'DNS', icon: 'symbol-namespace' },
  { id: 'net', label: 'Net 관리', icon: 'radio-tower' },
  { id: 'tinyauth', label: 'tinyauth', icon: 'shield' },
  { id: 'router-settings', label: 'Router 설정', icon: 'settings-gear' },
]

function sectionLabel(id) {
  const s = SECTIONS.find((x) => x.id === id)
  return s ? s.label : id
}

module.exports = { SECTIONS, sectionLabel }
