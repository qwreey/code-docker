import { GitUserForm } from './GitUserForm'
import { CommitSigning } from './CommitSigning'
import { HttpsCredentials } from './HttpsCredentials'
import { GitLFS } from './GitLFS'
import { RawConfigEditor } from './RawConfigEditor'
import '../common/common.css'
import './GitConfig.css'

// SSH-level settings (known_hosts, ~/.ssh/config per-host entries and raw
// editing, the default identity key) live under the SSH Keys tab instead of
// here — they're not git-specific (any ssh/scp connection uses them too),
// see components/SshKeys/SshKeys.tsx.
export function GitConfig() {
  return (
    <section>
      <div className="section-header">
        <h1>Git Config</h1>
      </div>
      <GitUserForm />
      <CommitSigning />
      <HttpsCredentials />
      <GitLFS />
      <RawConfigEditor />
    </section>
  )
}
