import { Suspense, useState, type ReactNode } from 'react'
import { LazyCodeEditor, type CodeEditorProps } from './LazyCodeEditor'
import './ExpandableEditor.css'

export interface ExpandableEditorProps extends CodeEditorProps {
  /** Trigger button label. */
  triggerLabel?: string
  /** Keep the trigger button visible after the editor is expanded. Default false (hide it). */
  keepTriggerVisible?: boolean
  triggerClassName?: string
  loadingFallback?: ReactNode
}

/**
 * Generic "load the editor on demand" wrapper: renders a button that, once
 * clicked, mounts the lazy CodeMirror editor inside a Suspense boundary.
 *
 * Purely presentational — no save/cancel/API assumptions. Callers own that:
 * wrap this with their own load/save logic and pass `value`/`onChange` down.
 */
export function ExpandableEditor({
  triggerLabel = '자세히 편집',
  keepTriggerVisible = false,
  triggerClassName = 'btn btn-secondary btn-small',
  loadingFallback,
  ...editorProps
}: ExpandableEditorProps) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="expandable-editor">
      {(!expanded || keepTriggerVisible) && (
        <button
          type="button"
          className={triggerClassName}
          onClick={() => setExpanded(true)}
          disabled={expanded}
        >
          {triggerLabel}
        </button>
      )}
      {expanded && (
        <Suspense
          fallback={loadingFallback ?? <div className="expandable-editor-loading">에디터 불러오는 중...</div>}
        >
          <LazyCodeEditor {...editorProps} />
        </Suspense>
      )}
    </div>
  )
}
