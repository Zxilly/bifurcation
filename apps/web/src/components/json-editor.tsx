"use client";

import { lazy, Suspense, useSyncExternalStore, type ReactNode } from "react";
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
  variant?: "field" | "workspace";
  /** Additional document actions, such as importing a file. */
  toolbar?: ReactNode;
  /** The model value is authoritative even before React commits the last key. */
  onSave?: (value: string) => void;
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

function JsonEditorPlaceholder({ label, description, rows = 20, variant = "field" }: JsonEditorProps) {
  return (
    <Field hideLabel label={label} description={description}>
      <span className={labelVariants()}>{label}</span>
      <div
        role="status"
        aria-label={`${label}：正在加载编辑器`}
        className={`grid min-w-0 place-items-center rounded-lg bg-kumo-control ring ring-kumo-line ${variant === "workspace" ? "json-editor-placeholder" : ""}`}
        style={variant === "field" ? { height: `${rows * 20 + 16}px` } : undefined}
      >
        <p className="subtle">正在加载 JSON 编辑器…</p>
      </div>
    </Field>
  );
}
