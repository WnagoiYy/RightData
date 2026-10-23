import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import Editor, { loader, type OnMount } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import CSSWorker from 'monaco-editor/language/css/css.worker.js?worker'
import HTMLWorker from 'monaco-editor/language/html/html.worker.js?worker'
import TypeScriptWorker from 'monaco-editor/language/typescript/ts.worker.js?worker'
import { formatBulletinSource } from './bulletinFormatter'

self.MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    if (label === 'css' || label === 'scss' || label === 'less') return new CSSWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HTMLWorker()
    if (label === 'typescript' || label === 'javascript') return new TypeScriptWorker()
    return new EditorWorker()
  },
}

loader.config({ monaco })

export type BulletinEditorDefinition = { id: string; name: string }

export type BulletinSourceEditorHandle = {
  format: () => Promise<'changed' | 'unchanged' | 'stale'>
  insertText: (text: string) => boolean
}

type BulletinSourceEditorProps = {
  value: string
  definitions: BulletinEditorDefinition[]
  parameterKeys: string[]
  onChange: (value: string) => void
  onSave: () => void
  onFormatRequest: () => void
  onReadyChange: (ready: boolean) => void
}

export const BulletinSourceEditor = forwardRef<BulletinSourceEditorHandle, BulletinSourceEditorProps>(function BulletinSourceEditor({
  value,
  definitions,
  parameterKeys,
  onChange,
  onSave,
  onFormatRequest,
  onReadyChange,
}, ref) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const completionRef = useRef<monaco.IDisposable | null>(null)
  const definitionsRef = useRef(definitions)
  const parameterKeysRef = useRef(parameterKeys)
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  const onFormatRequestRef = useRef(onFormatRequest)
  const onReadyChangeRef = useRef(onReadyChange)
  definitionsRef.current = definitions
  parameterKeysRef.current = parameterKeys
  onChangeRef.current = onChange
  onSaveRef.current = onSave
  onFormatRequestRef.current = onFormatRequest
  onReadyChangeRef.current = onReadyChange

  const format = async (): Promise<'changed' | 'unchanged' | 'stale'> => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model) return 'unchanged'
    const current = model.getValue()
    const version = model.getVersionId()
    const formatted = await formatBulletinSource(current)
    if (editorRef.current !== editor || model.isDisposed() || model.getVersionId() !== version) return 'stale'
    if (formatted === current) return 'unchanged'
    editor.pushUndoStop()
    editor.executeEdits('rightdata-format', [{ range: model.getFullModelRange(), text: formatted, forceMoveMarkers: true }])
    editor.pushUndoStop()
    return 'changed'
  }

  const insertText = (text: string): boolean => {
    const editor = editorRef.current
    const selection = editor?.getSelection()
    if (!editor || !selection) return false
    editor.executeEdits('rightdata-asset', [{ range: selection, text, forceMoveMarkers: true }])
    editor.focus()
    return true
  }

  useImperativeHandle(ref, () => ({ format, insertText }))

  useEffect(() => () => {
    completionRef.current?.dispose()
    editorRef.current = null
    onReadyChangeRef.current(false)
  }, [])

  const mountEditor: OnMount = (editor, api) => {
    editorRef.current = editor
    completionRef.current?.dispose()
    completionRef.current = api.languages.registerCompletionItemProvider('html', {
      triggerCharacters: ['.', '"', "'"],
      provideCompletionItems(model: monaco.editor.ITextModel, position: monaco.Position) {
        const word = model.getWordUntilPosition(position)
        const range = new api.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
        const sourceSuggestions = definitionsRef.current.map((definition) => {
          const id = JSON.stringify(definition.id)
          return {
            label: `rightData.query(${id})`,
            detail: definition.name,
            documentation: `执行已绑定查询定义：${definition.name}`,
            kind: api.languages.CompletionItemKind.Function,
            insertText: `window.rightData.query(${id}, \${1:{}}).then(function (result) {\n  \${2:console.log(result.rows)};\n});`,
            insertTextRules: api.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
          }
        })
        const parameterSuggestions = parameterKeysRef.current.map((key) => ({
          label: `rightDataParams.${key}`,
          detail: '当前通报筛选参数',
          kind: api.languages.CompletionItemKind.Variable,
          insertText: `window.rightDataParams?.[${JSON.stringify(key)}]`,
          range,
        }))
        return { suggestions: [
          ...sourceSuggestions,
          ...parameterSuggestions,
          {
            label: 'rightdata:init',
            detail: '通报文档初始化事件',
            kind: api.languages.CompletionItemKind.Event,
            insertText: `window.addEventListener('rightdata:init', function () {\n  \${1}\n});`,
            insertTextRules: api.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
          },
          {
            label: 'rightdata:params',
            detail: '筛选参数变化事件',
            kind: api.languages.CompletionItemKind.Event,
            insertText: `window.addEventListener('rightdata:params', function (event) {\n  const params = event.detail;\n  \${1}\n});`,
            insertTextRules: api.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
          },
        ] }
      },
    })
    editor.addAction({
      id: 'rightdata.save-bulletin',
      label: '保存通报',
      keybindings: [api.KeyMod.CtrlCmd | api.KeyCode.KeyS],
      run: () => onSaveRef.current(),
    })
    editor.addAction({
      id: 'rightdata.format-bulletin',
      label: '格式化通报源码',
      keybindings: [api.KeyMod.Shift | api.KeyMod.Alt | api.KeyCode.KeyF],
      run: () => onFormatRequestRef.current(),
    })
    onReadyChangeRef.current(true)
  }

  return <Editor
    height="100%"
    language="html"
    theme="vs"
    value={value}
    onMount={mountEditor}
    onChange={(next) => onChangeRef.current(next ?? '')}
    loading={<div className="rd-config-editor-loading">正在加载源码编辑器…</div>}
    options={{
      ariaLabel: '通报 HTML 源码',
      automaticLayout: true,
      fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
      fontSize: 12,
      formatOnPaste: false,
      formatOnType: false,
      insertSpaces: true,
      minimap: { enabled: false },
      padding: { top: 10, bottom: 10 },
      scrollBeyondLastLine: false,
      tabSize: 2,
      wordWrap: 'on',
    }}
  />
})
