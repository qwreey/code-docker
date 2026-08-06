import { DevProxy } from './components/DevProxy/DevProxy'

// Standalone dev-server preview shell only - `npm run dev` inside
// router/frontend renders this so components can be previewed in isolation
// against a real router-manager (see vite.config.ts's proxy target). Not
// used when webmanager imports these components directly (see src/index.ts).
function App() {
  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '1.5rem' }}>
      <DevProxy />
    </div>
  )
}

export default App
