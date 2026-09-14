"use client";

import { lazy, Suspense, useSyncExternalStore } from "react";
import { Field } from "@cloudflare/kumo";
import { labelVariants } from "@cloudflare/kumo/components/label";

export type JsonEditorProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  description?: string;
  error?: string;
  /** Visible height in 20px lines. */
  rows?: number;
};

const Monaco = lazy(() =>
  import("./json-editor-monaco").then((module) => ({ default: module.JsonEditorMonaco })),
);

const noop = () => () => {};
const useHydrated = () => useSyncExternalStore(noop, () => true, () => false);

// Monaco touches `window` at import time, so it loads only after hydration;
// the placeholder keeps the label and box in place meanwhile.
export function JsonEditor(props: JsonEditorProps) {
  const hydrated = useHydrated();
  if (!hydrated) return <JsonEditorPlaceholder {...props} />;
  return (
    <Suspense fallback={<JsonEditorPlaceholder {...props} />}>
      <Monaco {...props} />
    </Suspense>
  );
}

function JsonEditorPlaceholder({ label, description, rows = 20 }: JsonEditorProps) {
  return (
    <Field hideLabel label={label} description={description}>
      <span className={labelVariants()}>{label}</span>
      <div
        role="status"
        aria-label={`${label}：正在加载编辑器`}
        className="min-w-0 rounded-lg bg-kumo-control ring ring-kumo-line"
        style={{ height: `${rows * 20 + 16}px` }}
      />
    </Field>
  );
}
