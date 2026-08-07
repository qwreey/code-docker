import { api, errorMessage } from '../api/client'

export type RestartOutcome = 'restarted' | 'declined' | 'error'

// Shared by Mise.tsx and ClaudeCode.tsx: both flows install/update a global
// mise tool, and code-server only picks up the new PATH on its next start
// (config/code-runner.default.sh evaluates `mise env` once at process start,
// not continuously - see root README/CLAUDE.md). Reuses the same
// window.confirm idiom Supervisor/ProcessTable.tsx already uses for
// restart/stop actions, since this repo has no separate confirm-dialog
// component.
export async function confirmAndRestartCodeServer(): Promise<RestartOutcome> {
  if (!window.confirm('code-server를 지금 재시작할까요? 재시작 중 code-server 연결이 잠시 끊깁니다.')) {
    return 'declined'
  }
  try {
    await api.post('/supervisor/processes/code/restart')
    return 'restarted'
  } catch (e) {
    console.error('code-server restart failed:', errorMessage(e))
    return 'error'
  }
}
