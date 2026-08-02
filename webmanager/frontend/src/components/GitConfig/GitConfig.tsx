import { GitUserForm } from './GitUserForm'
import { SshHosts } from './SshHosts'
import { HttpsCredentials } from './HttpsCredentials'
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
      <HttpsCredentials />
    </section>
  )
}
