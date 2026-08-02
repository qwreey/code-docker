import './Placeholder.css'

export function Placeholder({ title, note }: { title: string; note?: string }) {
  return (
    <div className="placeholder">
      <div className="placeholder-icon" aria-hidden="true">
        🚧
      </div>
      <h2>{title}</h2>
      <p className="placeholder-tag">구현 예정 (coming soon)</p>
      {note && <p className="placeholder-note">{note}</p>}
    </div>
  )
}
