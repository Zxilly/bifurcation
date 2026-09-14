"use client";

import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor/editor";
import "monaco-editor/features/register.all";
import { jsonDefaults } from "monaco-editor/languages/features/json/register";
import { Field } from "@cloudflare/kumo";
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
}: JsonEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor>(null);
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!host.current) return;
    void configureSchema();
    const instance = monaco.editor.create(host.current, {
      value,
      language: "json",
      ariaLabel: label,
      theme: "vs",
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 13,
      lineHeight: 20,
      tabSize: 2,
      insertSpaces: true,
      renderLineHighlight: "line",
      fixedOverflowWidgets: true,
      overviewRulerBorder: false,
      scrollbar: { alwaysConsumeMouseWheel: false },
    });
    editor.current = instance;
    const subscription = instance.onDidChangeModelContent(() => {
      latest.current(instance.getValue());
    });
    return () => {
      subscription.dispose();
      instance.getModel()?.dispose();
      instance.dispose();
      editor.current = null;
    };
    // The editor owns its text after mount; `value` only seeds it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label]);

  useEffect(() => {
    const instance = editor.current;
    if (instance && instance.getValue() !== value) instance.setValue(value);
  }, [value]);

  useEffect(() => {
    editor.current?.updateOptions({ readOnly: disabled });
  }, [disabled]);

  return (
    <Field hideLabel label={label} description={description} error={error ? { message: error, match: true } : undefined}>
      {/* Monaco's input element is not labelable (a textarea or an EditContext
          div depending on the browser); the accessible name comes from ariaLabel. */}
      <label className={labelVariants()} onClick={() => editor.current?.focus()}>
        {label}
      </label>
      <div
        ref={host}
        className="min-w-0 overflow-hidden rounded-lg bg-kumo-control ring ring-kumo-line focus-within:ring-[1.5px] focus-within:ring-kumo-focus/50"
        style={{ height: `${rows * 20 + 16}px` }}
      />
    </Field>
  );
}
