import { useState } from 'react'
import { ProcessTable } from './ProcessTable'
import { PortTable } from './PortTable'
import { Performance } from './Performance'
import '../common/common.css'
import './Processes.css'

type MainTab = 'performance' | 'processes'
type ProcessesSubTab = 'processes' | 'ports'

export function Processes() {
  const [mainTab, setMainTab] = useState<MainTab>('performance')
  const [subTab, setSubTab] = useState<ProcessesSubTab>('processes')

  return (
    <section>
      <div className="section-header">
        <h1>Task Manager</h1>
        <div className="processes-tabs processes-maintabs">
          <button
            type="button"
            className={`processes-tab${mainTab === 'performance' ? ' processes-tab-active' : ''}`}
            onClick={() => setMainTab('performance')}
          >
            성능
          </button>
          <button
            type="button"
            className={`processes-tab${mainTab === 'processes' ? ' processes-tab-active' : ''}`}
            onClick={() => setMainTab('processes')}
          >
            프로세스
          </button>
        </div>
      </div>
      <p className="section-description">
        {mainTab === 'performance'
          ? '컨테이너와 호스트의 CPU/메모리/디스크/네트워크 사용량을 실시간으로 확인합니다.'
          : '실행 중인 프로세스와 리스닝 중인 포트를 조회하고, 점유 중인 프로세스를 바로 종료할 수 있습니다.'}
      </p>

      {mainTab === 'performance' ? (
        <Performance />
      ) : (
        <>
          <div className="processes-tabs">
            <button
              type="button"
              className={`processes-tab${subTab === 'processes' ? ' processes-tab-active' : ''}`}
              onClick={() => setSubTab('processes')}
            >
              프로세스
            </button>
            <button
              type="button"
              className={`processes-tab${subTab === 'ports' ? ' processes-tab-active' : ''}`}
              onClick={() => setSubTab('ports')}
            >
              포트
            </button>
          </div>
          {subTab === 'processes' ? <ProcessTable /> : <PortTable />}
        </>
      )}
    </section>
  )
}
