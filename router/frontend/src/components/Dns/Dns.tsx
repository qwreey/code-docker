import { useState } from 'react'
import { Blocklist } from './Blocklist'
import { CustomHosts } from './CustomHosts'
import { Resolver } from './Resolver'
import { Query } from './Query'
import '../common/common.css'
import './Dns.css'

type Tab = 'blocklist' | 'custom-hosts' | 'resolver' | 'query'

// router's DNS forwarder (dnsmasq) management - content blocklist sources
// (multi-list, Caddy-style), custom hostname->IP entries (MagicDNS-style),
// and upstream resolver override. See
// router/.claude/dns-blocklist-management-plan.md for why these were pure
// default/override files with no runtime API until now.
export function Dns() {
  const [tab, setTab] = useState<Tab>('blocklist')

  return (
    <section>
      <div className="section-header">
        <h1>DNS</h1>
        <div className="dns-tabs">
          <button
            type="button"
            className={`dns-tab${tab === 'blocklist' ? ' dns-tab-active' : ''}`}
            onClick={() => setTab('blocklist')}
          >
            블록리스트
          </button>
          <button
            type="button"
            className={`dns-tab${tab === 'custom-hosts' ? ' dns-tab-active' : ''}`}
            onClick={() => setTab('custom-hosts')}
          >
            추가 호스트
          </button>
          <button
            type="button"
            className={`dns-tab${tab === 'resolver' ? ' dns-tab-active' : ''}`}
            onClick={() => setTab('resolver')}
          >
            리졸버
          </button>
          <button
            type="button"
            className={`dns-tab${tab === 'query' ? ' dns-tab-active' : ''}`}
            onClick={() => setTab('query')}
          >
            조회
          </button>
        </div>
      </div>
      <p className="section-description">
        {tab === 'blocklist'
          ? '이 라우터를 게이트웨이로 사용하는 컨테이너가 거쳐 나가는 요청 중 차단할 도메인 목록을 관리합니다.'
          : tab === 'custom-hosts'
            ? '특정 호스트 이름을 실제 IP로 직접 매핑합니다.'
            : tab === 'resolver'
              ? '업스트림 DNS 서버를 지정합니다.'
              : 'dig처럼 도메인을 직접 조회해 디버깅합니다.'}
      </p>

      {tab === 'blocklist' && <Blocklist />}
      {tab === 'custom-hosts' && <CustomHosts />}
      {tab === 'resolver' && <Resolver />}
      {tab === 'query' && <Query />}
    </section>
  )
}
