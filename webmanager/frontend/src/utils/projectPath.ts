// Shared by Terminal (jump from an open session's cwd to its project) and
// Projects (jump from a project back to sessions open under it) - see
// App.tsx's openInTerminal/openProject cross-tab payload mechanism.

// Given a session's live cwd and the Projects tab's configured scan roots
// (ProjectsResponse.roots), returns the project path it belongs to - the
// root plus the first path segment under it (e.g. root "/code/Projects",
// cwd "/code/Projects/code-docker/router" -> "/code/Projects/code-docker").
// Returns null if cwd isn't under any root, or is a root itself with no
// project segment after it.
export function projectPathForCwd(cwd: string, roots: string[]): string | null {
  if (!cwd) return null
  for (const root of roots) {
    const prefix = root.endsWith('/') ? root : `${root}/`
    if (!cwd.startsWith(prefix)) continue
    const rest = cwd.slice(prefix.length)
    const segment = rest.split('/')[0]
    if (!segment) continue
    return `${prefix}${segment}`
  }
  return null
}

// True if `path` is `projectPath` itself or a subdirectory of it - used by
// the Projects detail sheet to find terminal sessions open under a project.
export function isUnderProjectPath(path: string, projectPath: string): boolean {
  if (!path || !projectPath) return false
  if (path === projectPath) return true
  const prefix = projectPath.endsWith('/') ? projectPath : `${projectPath}/`
  return path.startsWith(prefix)
}
