"use client";

import { useEffect, useId, useRef, useState } from "react";
import * as monaco from "monaco-editor/editor";
import "monaco-editor/features/register.all";
import { getWorker, jsonDefaults } from "monaco-editor/languages/features/json/register";
import { Button, Field } from "@cloudflare/kumo";
import { ArrowUDownLeftIcon, ArrowUDownRightIcon, ArrowsInSimpleIcon, ArrowsOutSimpleIcon, MagnifyingGlassIcon, TextAlignLeftIcon } from "@phosphor-icons/react";
import { FormError } from "./modal";
import { labelVariants } from "@cloudflare/kumo/components/label";
import type { JsonEditorProps } from "./json-editor";

// Workers are created with `new Worker(new URL(...))` so the bundler emits
// them next to the page chunks; no CDN or loader is involved. Monaco's own
// editor-worker lookup builds the URL separately from the Worker call, which
// Turbopack treats as a plain asset, so both workers are resolved here.
const globals = window as Window & {
  monaco?: typeof monaco;
  MonacoEnvironment?: { getWorker(id: string, label: string): Worker };
};
globals.MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === "json")
      return new Worker(new URL("monaco-editor/language/json/json.worker.js", import.meta.url), { type: "module" });
    return new Worker(new URL("monaco-editor/editor/editor.worker.js", import.meta.url), { type: "module" });
  },
};
// Exposed for debugging and end-to-end tests, like the classic loader does.
globals.monaco = monaco;

let schemaConfigured: Promise<void> | undefined;
// The vendored sing-box schema is applied to every JSON model; documents may
// carry any `$schema` URL and it is deliberately never fetched.
function configureSchema() {
  schemaConfigured ??= import("@/schemas/sing-box.json").then(({ default: schema }) => {
    jsonDefaults.setDiagnosticsOptions({
      validate: true,
      allowComments: false,
      trailingCommas: "error",
      enableSchemaRequest: false,
      schemaValidation: "warning",
      schemas: [{ uri: schema.$id, fileMatch: ["*"], schema }],
    });
  });
  return schemaConfigured;
}

export function JsonEditorMonaco({
  label,
  value,
  onChange,
  disabled = false,
  description,
  error,
  rows = 20,
  variant = "field",
  toolbar,
  onSave,
}: JsonEditorProps) {
  const workspace = variant === "workspace";
  const root = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor>(null);
  const applyingValue = useRef(false);
  const latest = useRef({ onChange, onSave, disabled });
  const [wrap, setWrap] = useState(workspace);
  const [expanded, setExpanded] = useState(false);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [markers, setMarkers] = useState<monaco.editor.IMarker[]>([]);
  const [formatting, setFormatting] = useState(false);
  const [actionError, setActionError] = useState("");
  const [schemaError, setSchemaError] = useState("");
  const [position, setPosition] = useState({ lineNumber: 1, column: 1 });
  const [history, setHistory] = useState({ undo: false, redo: false });
  const problemsId = useId();
  useEffect(() => {
    latest.current = { onChange, onSave, disabled };
  }, [onChange, onSave, disabled]);

  useEffect(() => {
    if (!host.current) return;
    void configureSchema().catch(() => setSchemaError("字段提示未能加载，可继续编辑并保存草稿；刷新页面后重试。"));
    const instance = monaco.editor.create(host.current, {
      value,
      language: "json",
      ariaLabel: label,
      theme: "vs",
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 15,
      lineHeight: 24,
      padding: { top: 12, bottom: 12 },
      lineNumbersMinChars: workspace ? 3 : 5,
      lineDecorationsWidth: workspace ? 8 : 10,
      wordWrap: workspace ? "on" : "off",
      readOnly: disabled,
      tabSize: 2,
      insertSpaces: true,
      renderLineHighlight: "line",
      fixedOverflowWidgets: true,
      overviewRulerBorder: false,
      scrollbar: { alwaysConsumeMouseWheel: false },
    });
    editor.current = instance;
    const model = instance.getModel()!;
    function updateHistory() {
      setHistory({ undo: model.canUndo(), redo: model.canRedo() });
    }
    const contentSubscription = instance.onDidChangeModelContent(() => {
      if (!applyingValue.current) latest.current.onChange(instance.getValue());
      setActionError("");
      updateHistory();
    });
    const cursorSubscription = instance.onDidChangeCursorPosition((event) => {
      setPosition(event.position);
      updateHistory();
    });
    const markerSubscription = monaco.editor.onDidChangeMarkers((resources) => {
      if (resources.some((resource) => resource.toString() === model.uri.toString())) {
        setMarkers(monaco.editor.getModelMarkers({ resource: model.uri }).sort((a, b) =>
          b.severity - a.severity || a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn,
        ));
      }
    });
    if (workspace) instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (!latest.current.disabled) latest.current.onSave?.(instance.getValue());
    });
    return () => {
      contentSubscription.dispose();
      cursorSubscription.dispose();
      markerSubscription.dispose();
      instance.dispose();
      model.dispose();
      editor.current = null;
    };
    // The editor owns its text after mount; `value` only seeds it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label, workspace]);

  useEffect(() => {
    const instance = editor.current;
    const model = instance?.getModel();
    if (!instance || !model || instance.getValue() === value) return;
    // Importing/reloading is one undoable edit, including while readOnly.
    // The parent already owns this update; do not mark its loaded draft dirty.
    applyingValue.current = true;
    try {
      model.pushStackElement();
      const cursor = new monaco.Selection(1, 1, 1, 1);
      model.pushEditOperations(instance.getSelections(), [{ range: model.getFullModelRange(), text: value }], () => [cursor]);
      model.pushStackElement();
      instance.setSelection(cursor);
      instance.setScrollTop(0);
      setHistory({ undo: model.canUndo(), redo: model.canRedo() });
    } finally {
      applyingValue.current = false;
    }
  }, [value]);

  useEffect(() => {
    editor.current?.updateOptions({ readOnly: disabled });
  }, [disabled]);

  useEffect(() => {
    editor.current?.updateOptions({ wordWrap: wrap ? "on" : "off" });
  }, [wrap]);

  async function format() {
    const instance = editor.current;
    if (!instance || disabled || formatting) return;
    try {
      JSON.parse(instance.getValue());
    } catch {
      setActionError("JSON 格式有误，请先修正问题列表中的语法错误。内容已保留，仍可保存草稿。");
      setProblemsOpen(true);
      return;
    }
    setFormatting(true);
    setActionError("");
    try {
      const worker = await getWorker();
      await worker(instance.getModel()!.uri);
      if (latest.current.disabled || editor.current !== instance) return;
      // Monaco formats the original tokens, preserving large numbers and undo.
      const action = instance.getAction("editor.action.formatDocument");
      if (!action?.isSupported()) throw new Error("Formatter unavailable");
      await action.run();
      if (document.activeElement === document.body || root.current?.contains(document.activeElement)) instance.focus();
      const model = instance.getModel();
      if (model) setHistory({ undo: model.canUndo(), redo: model.canRedo() });
    } catch {
      setActionError("暂时无法格式化，请稍后重试。编辑内容已保留。");
    } finally {
      setFormatting(false);
    }
  }

  function jumpTo(marker: monaco.editor.IMarker) {
    const instance = editor.current;
    if (!instance) return;
    instance.setSelection(new monaco.Range(marker.startLineNumber, marker.startColumn, marker.endLineNumber, marker.endColumn));
    instance.revealLineInCenter(marker.startLineNumber);
    instance.focus();
  }

  const errors = markers.filter((marker) => marker.severity === monaco.MarkerSeverity.Error).length;

  return (
    <Field hideLabel label={label} description={description} error={error ? { message: error, match: true } : undefined}>
      {/* Monaco's input element is not labelable (a textarea or an EditContext
          div depending on the browser); the accessible name comes from ariaLabel. */}
      <label className={labelVariants()} onClick={() => editor.current?.focus()}>
        {label}
      </label>
      <div ref={root} className={workspace ? "json-editor-workspace min-w-0" : "min-w-0"} data-expanded={expanded}>
        {workspace && <div className="json-editor-toolbar" role="group" aria-label="JSON 编辑工具">
          <div className="flex flex-wrap items-center gap-1.5">
            <Button type="button" size="sm" className="text-sm" disabled={disabled || formatting} loading={formatting} onClick={() => void format()}>格式化 JSON</Button>
            <Button type="button" size="sm" className="text-sm" icon={MagnifyingGlassIcon} onClick={() => { editor.current?.focus(); editor.current?.trigger("toolbar", "editor.action.startFindReplaceAction", null); }}>查找 / 替换</Button>
            {toolbar}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button type="button" size="sm" variant="ghost" shape="square" icon={ArrowUDownLeftIcon} aria-label="撤销" title="撤销（Ctrl / ⌘ + Z）" disabled={disabled || !history.undo} onClick={() => editor.current?.trigger("toolbar", "undo", null)} />
            <Button type="button" size="sm" variant="ghost" shape="square" icon={ArrowUDownRightIcon} aria-label="重做" title="重做（Ctrl / ⌘ + Shift + Z）" disabled={disabled || !history.redo} onClick={() => editor.current?.trigger("toolbar", "redo", null)} />
            <Button type="button" size="sm" className="text-sm" variant={wrap ? "secondary" : "ghost"} icon={TextAlignLeftIcon} aria-pressed={wrap} onClick={() => setWrap(!wrap)}>自动换行</Button>
            <Button type="button" size="sm" className="text-sm" variant="ghost" icon={expanded ? ArrowsInSimpleIcon : ArrowsOutSimpleIcon} aria-expanded={expanded} onClick={() => {
              setExpanded(!expanded);
              if (!expanded) requestAnimationFrame(() => root.current?.scrollIntoView({ block: "start" }));
            }}>{expanded ? "收起编辑区" : "扩大编辑区"}</Button>
          </div>
        </div>}
        {workspace && <FormError message={schemaError || actionError} />}
        <div
          ref={host}
          className={`json-editor-host min-w-0 overflow-hidden bg-kumo-control ring ring-kumo-line focus-within:ring-[1.5px] focus-within:ring-kumo-focus/50 ${workspace ? "" : "rounded-lg"}`}
          style={workspace ? undefined : { height: `${rows * 24 + 24}px` }}
        />
        {workspace && <>
          <div className="json-editor-status">
            <Button type="button" size="sm" className="text-sm" variant="ghost" aria-expanded={problemsOpen} aria-controls={problemsId} onClick={() => setProblemsOpen(!problemsOpen)}>问题（{markers.length}）</Button>
            {errors > 0 && <span className="text-kumo-danger">{errors} 个错误</span>}
            {markers.length > errors && <span>{markers.length - errors} 条字段提示</span>}
            <span className="ml-auto tabular-nums">第 {position.lineNumber} 行，第 {position.column} 列</span>
            {onSave && <span className="hidden sm:inline">Ctrl / ⌘ + S 保存草稿</span>}
          </div>
          <div id={problemsId} hidden={!problemsOpen} className="json-editor-problems">
            <p className="subtle px-3 py-2">语法错误与字段提示仅供编辑参考；保存草稿不受影响，发布前仍需生成预览。</p>
            {markers.length ? <ul>
              {markers.map((marker, index) => <li key={`${marker.startLineNumber}:${marker.startColumn}:${index}`}>
                <Button type="button" variant="ghost" className="json-editor-problem h-auto justify-start rounded-none text-left text-sm whitespace-normal" onClick={() => jumpTo(marker)} aria-label={`第 ${marker.startLineNumber} 行，第 ${marker.startColumn} 列：${marker.message}`}>
                  <span className={marker.severity === monaco.MarkerSeverity.Error ? "text-kumo-danger" : "subtle"}>{marker.severity === monaco.MarkerSeverity.Error ? "错误" : "提示"} · {marker.startLineNumber}:{marker.startColumn}</span>
                  <span>{marker.message}</span>
                </Button>
              </li>)}
            </ul> : <p className="px-3 pb-3">当前没有编辑提示。</p>}
          </div>
        </>}
      </div>
    </Field>
  );
}
