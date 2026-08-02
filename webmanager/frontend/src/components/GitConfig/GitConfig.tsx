import { GitUserForm } from './GitUserForm'
import { SshHosts } from './SshHosts'
import { KnownHosts } from './KnownHosts'
import { CommitSigning } from './CommitSigning'
import { HttpsCredentials } from './HttpsCredentials'
import { GitLFS } from './GitLFS'
import { RawConfigEditor } from './RawConfigEditor'
import '../common/common.css'
import './GitConfig.css'

export function GitConfig() {
  return (
    <section>
      <div className="section-header">
        <h1>Git Config</h1>
      </div>
      <GitUserForm />
      <SshHosts />
      <KnownHosts />
      <CommitSigning />
      <HttpsCredentials />
      <GitLFS />
      <RawConfigEditor />
    </section>
  )
}
