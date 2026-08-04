import './Skeleton.css'

// Generic, position-agnostic loading placeholder - a handful of shimmering
// bars, not a shape traced to any particular tab's real layout. Tabs vary
// too much (tables/cards/charts/terminal) for a per-component skeleton to
// be worth maintaining; this one intentionally doesn't try to match the
// real content it's replacing, only to read as "something is loading here"
// (same bar-count for every tab, real apps get away with this all the
// time). Swap in wherever a tab currently shows a bare
// `<p className="empty-state">불러오는 중...</p>` for its first load.
//
// Pairs with utils/viewTransition.ts for the fade: wrap the state update
// that flips loading→false in withViewTransition so the browser cross-
// fades this out and the real content in, instead of an instant swap.
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
