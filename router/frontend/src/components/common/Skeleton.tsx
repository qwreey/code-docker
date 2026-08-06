import './Skeleton.css'

// Generic, position-agnostic loading placeholder - ported from webmanager's
// own Skeleton.tsx (see that file for the full rationale).
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
