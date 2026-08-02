import { lazy } from 'react'

export type { CodeEditorProps, CodeEditorLanguage } from './CodeEditor'

// Heavy CodeMirror imports live in CodeEditor.tsx. Importing *this* module
// instead of CodeEditor.tsx directly keeps that code out of the main bundle —
// Vite code-splits it into its own chunk, fetched only once this component
// actually renders (see ExpandableEditor for the common "load on demand" UX).
export const LazyCodeEditor = lazy(() =>
  import('./CodeEditor').then((module) => ({ default: module.CodeEditor })),
)
