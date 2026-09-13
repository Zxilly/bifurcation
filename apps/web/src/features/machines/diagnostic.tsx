"use client";

import { useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { FormError } from "@/components/modal";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
const timestamp = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "short",
  timeStyle: "medium",
  timeZone: "Asia/Shanghai",
});
function snapshotTime(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  try {
    return timestamp.format(value);
  } catch {
    return null;
  }
}

export function DiagnosticResult({ value }: { value: unknown }) {
  const diagnostic = record(value);
  const logs = record(diagnostic?.logs);
  const lines =
    Array.isArray(logs?.lines) &&
    logs.lines.every((line) => typeof line === "string")
      ? (logs.lines as string[])
      : null;
  const observedAt = snapshotTime(diagnostic?.observedAt);
  const source = logs?.source === "embedded-core" ? "内嵌核心日志" : null;
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [rawOpen, setRawOpen] = useState(lines === null);
  async function copy() {
    try {
      await navigator.clipboard.writeText((lines ?? []).join("\n"));
      setCopied(true);
      setError("");
    } catch {
      setError("无法访问剪贴板，请选择日志文本手动复制。");
    }
  }
  return (
    <div className="stack gap-3">
      {lines !== null && (
        <>
          <div className="actions">
            <h4 className="font-semibold">最近日志</h4>
            {source && <span className="subtle text-xs">{source}</span>}
          </div>
          {observedAt !== null && (
            <p className="subtle text-xs">采集时间 {observedAt}</p>
          )}
          {logs?.truncated === true && (
            <p className="notice">日志内容因行数或大小限制被截断。</p>
          )}
          {lines.length ? (
            <>
              <pre
                aria-label="最近日志"
                className="secret max-h-96 overflow-auto whitespace-pre-wrap"
              >
                <code>{lines.join("\n")}</code>
              </pre>
              <FormError message={error} />
              <div>
                <Button onClick={copy}>
                  {copied ? "日志已复制" : "复制日志"}
                </Button>
              </div>
            </>
          ) : (
            <p className="subtle">该快照没有日志内容。</p>
          )}
        </>
      )}
      <details
        open={rawOpen}
        onToggle={(event) => setRawOpen(event.currentTarget.open)}
      >
        <summary className="cursor-pointer subtle text-xs py-2">
          原始诊断 JSON
        </summary>
        {rawOpen && (
          <pre className="secret max-h-96 overflow-auto">
            {JSON.stringify(value, null, 2)}
          </pre>
        )}
      </details>
    </div>
  );
}
