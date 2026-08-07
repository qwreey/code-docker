// Public export surface - what webmanager (or any other consumer) imports.
// Keep this the single place new page components get exposed from, so a
// consumer's import lines stay stable even if internal file layout changes.
export { DevProxy } from './components/DevProxy/DevProxy'
export { AppRoutes } from './components/AppRoutes/AppRoutes'
export { Tailscale } from './components/Tailscale/Tailscale'
export { RouterUnlockModalHost } from './components/common/UnlockModal'
export { RouterAuthSetupBanner } from './components/common/RouterAuthSetupBanner'
