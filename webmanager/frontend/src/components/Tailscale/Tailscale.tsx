import { GlobalSettings } from './GlobalSettings'
import { Forwards } from './Forwards'
import { Publish } from './Publish'
import '../common/common.css'
import './Tailscale.css'

export function Tailscale() {
  return (
    <section>
      <div className="section-header">
        <h1>Tailscale</h1>
      </div>
      <p className="section-description">
        tailscale 로그인 상태/URL은 code-server 화면 배너에서 확인하세요 — 여기서는 forwards/publish 설정만
        관리합니다.
      </p>
      <GlobalSettings />
      <Forwards />
      <Publish />
    </section>
  )
}
