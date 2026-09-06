import { Suspense, lazy } from 'react'
import { Sheet } from '../common/Sheet'
import { Skeleton } from '../common/Skeleton'

// FileManager pulls in the CodeMirror chunk; lazy here for the same reason
// App.tsx lazy-loads the Files tab itself.
const FileManager = lazy(() =>
  import('./FileManager').then((module) => ({ default: module.FileManager })),
)

// The file browser as a dialog over whatever tab you're already on, the same
// shape (and for the same reason) as ProjectInfoDialog: an agent running in
// the terminal writes a file and asks you to look at it, and switching tabs
// to read it costs you the terminal you were watching — reported as "그 왕복
// 동작이 많이 복잡해져".
//
// Full-screen rather than the default centered card: a file browser is a
// screen in its own right, and on a phone the card variant left almost
// nothing for the listing itself.
export function FileManagerDialog({
  path,
  onClose,
  onOpenTerminal,
  onOpenInFilesTab,
}: {
  path: string | null
  onClose: () => void
  onOpenTerminal?: (cwd: string) => void
  onOpenInFilesTab?: (path: string | null) => void
}) {
  if (path === null) return null

  return (
    <Sheet
      open
      onClose={onClose}
      title="파일 브라우저"
      size="full"
      headerActions={
        onOpenInFilesTab && (
          <button
            type="button"
            className="btn btn-secondary btn-small"
            onClick={() => {
              onOpenInFilesTab(path === '' ? null : path)
              onClose()
            }}
            title="Files 탭에서 이어서 보기"
          >
            탭으로 열기
          </button>
        )
      }
    >
      <Suspense fallback={<Skeleton />}>
        <FileManager
          embedded
          initialPath={path === '' ? null : path}
          onOpenTerminal={onOpenTerminal}
        />
      </Suspense>
    </Sheet>
  )
}
