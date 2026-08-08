import './Skeleton.css'

// Generic, position-agnostic loading placeholder - see CLAUDE.md's
// "First-load skeleton" ground rule for when to use this. Ported back from
// @code-docker/router-frontend as part of 2026-08-08's decoupling (see
// ErrorBanner.tsx's doc comment) - this component originated here, moved to
// router-frontend when that package centralized common UI, and is now a
// hand-kept duplicate again rather than a shared import.
export function Skeleton() {
  return (
    <div className="skeleton" aria-hidden="true">
      <div className="skeleton-bar skeleton-bar-title" />
      <div className="skeleton-bar" />
      <div className="skeleton-bar" />
      <div className="skeleton-bar skeleton-bar-short" />
    </div>
  )
}
