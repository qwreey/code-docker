interface LogoProps {
  size?: number
  className?: string
}

// A gauge/dial mark: an open dial rim with a needle and pivot, evoking a
// control panel reading out the status of the things it manages (processes,
// tailscale, disk, etc). Pure currentColor so it follows the light/dark
// theme wherever it's placed - see index.css's --text-heading/--accent.
export function Logo({ size = 20, className }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <path d="M17.4 9A7 7 0 1 1 6.6 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M12 13.5 9.5 8.1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="13.5" r="1.6" fill="currentColor" />
    </svg>
  )
}
