import { useState } from 'react'
import { ProcessTable } from './ProcessTable'
import { PortTable } from './PortTable'
import { SystemSummary } from './SystemSummary'
import '../common/common.css'
import './Processes.css'

type Tab = 'processes' | 'ports'

export function Processes() {
  const [tab, setTab] = useState<Tab>('processes')

  return (
    <section>
      <div className="section-header">
        <h1>Processes</h1>
      </div>
      <p className="section-description">
        실행 중인 프로세스와 리스닝 중인 포트를 조회하고, 점유 중인 프로세스를 바로 종료할 수 있습니다.
      </p>
      <SystemSummary />
      <div className="processes-tabs">
        <button
          type="button"
          className={`processes-tab${tab === 'processes' ? ' processes-tab-active' : ''}`}
          onClick={() => setTab('processes')}
        >
          프로세스
        </button>
        <button
          type="button"
          className={`processes-tab${tab === 'ports' ? ' processes-tab-active' : ''}`}
          onClick={() => setTab('ports')}
        >
          포트
        </button>
      </div>
      {tab === 'processes' ? <ProcessTable /> : <PortTable />}
    </section>
  )
}
