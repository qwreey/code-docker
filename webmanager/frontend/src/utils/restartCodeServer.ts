import { api, errorMessage } from '../api/client'

export type RestartOutcome = 'restarted' | 'error'

// Shared by Mise/JobPanel.tsx and common/RestartNeededBanner.tsx: both flows
// install/update a global mise tool, and code-server only picks up the new
// PATH on its next start (config/code-runner.default.sh evaluates
// `mise env` once at process start, not continuously - see root README/
// CLAUDE.md). Confirmation itself is the caller's own ConfirmDialog now
// (window.confirm can't be dismissed by some automated test/agent
// harnesses) - this just performs the already-confirmed restart.
export async function restartCodeServer(): Promise<RestartOutcome> {
  try {
    await api.post('/supervisor/processes/code/restart')
    return 'restarted'
  } catch (e) {
    console.error('code-server restart failed:', errorMessage(e))
    return 'error'
  }
}
