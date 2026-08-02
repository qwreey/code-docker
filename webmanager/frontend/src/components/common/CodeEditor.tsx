import { useEffect, useRef } from 'react'
import { basicSetup, EditorView } from 'codemirror'
import { Compartment, EditorState } from '@codemirror/state'
import { StreamLanguage } from '@codemirror/language'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { oneDark } from '@codemirror/theme-one-dark'
import './CodeEditor.css'

export type CodeEditorLanguage = 'ini' | 'plain'

export interface CodeEditorProps {
  value: string
  onChange: (value: string) => void
  /** 'ini' covers INI-shaped formats (e.g. gitconfig: `[section]` + `key = value`). */
  language?: CodeEditorLanguage
  readOnly?: boolean
  /** CSS height, e.g. '400px' or '60vh'. Caller decides — not hardcoded here. */
  height?: string
}

// gitconfig-style INI (`[section "sub"]`, `key = value`, `#`/`;` comments) has no
// dedicated official Lezer grammar. CodeMirror 5's legacy "toml" stream-mode
// (shipped by the codemirror org itself, not a hand-rolled grammar) already
// highlights `[section]` headers, `key =` properties and `#` comments, which is
// close enough to gitconfig's shape for v1. Swap for a real Lezer grammar later
// if a consumer needs more precision.
function languageExtension(language: CodeEditorLanguage | undefined) {
  if (language === 'ini') return StreamLanguage.define(toml)
  return []
}

function themeExtension(dark: boolean) {
  return dark ? oneDark : []
}

const baseTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '0.85rem' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--mono)' },
})

export function CodeEditor({ value, onChange, language, readOnly, height }: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const languageCompartment = useRef(new Compartment())
  const readOnlyCompartment = useRef(new Compartment())
  const themeCompartment = useRef(new Compartment())
  const applyingExternalValue = useRef(false)

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const media = window.matchMedia('(prefers-color-scheme: dark)')

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged && !applyingExternalValue.current) {
        onChangeRef.current(update.state.doc.toString())
      }
    })

    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        baseTheme,
        updateListener,
        languageCompartment.current.of(languageExtension(language)),
        readOnlyCompartment.current.of(EditorState.readOnly.of(!!readOnly)),
        themeCompartment.current.of(themeExtension(media.matches)),
      ],
    })

    const view = new EditorView({ state, parent: container })
    viewRef.current = view

    const handleThemeChange = (event: MediaQueryListEvent) => {
      view.dispatch({
        effects: themeCompartment.current.reconfigure(themeExtension(event.matches)),
      })
    }
    media.addEventListener('change', handleThemeChange)

    return () => {
      media.removeEventListener('change', handleThemeChange)
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only; prop changes are handled by the effects below via compartments
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    applyingExternalValue.current = true
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    })
    applyingExternalValue.current = false
  }, [value])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: languageCompartment.current.reconfigure(languageExtension(language)),
    })
  }, [language])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: readOnlyCompartment.current.reconfigure(EditorState.readOnly.of(!!readOnly)),
    })
  }, [readOnly])

  return <div ref={containerRef} className="code-editor" style={{ height: height ?? '320px' }} />
}
