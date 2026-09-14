"use client";

import { useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { FormError } from "./modal";
import { CodeDocument } from "./code-document";

export function JsonDocument({
  value,
  filename = "config.json",
  label = "sing-box JSON",
}: {
  value: unknown;
  filename?: string;
  label?: string;
}) {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setError("");
    } catch {
      setError("无法访问剪贴板，请选择并手动复制。");
    }
  }
  function download() {
    const url = URL.createObjectURL(
      new Blob([text], { type: "application/json;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return (
    <div className="stack gap-3">
      <CodeDocument code={text} label={label} />
      <FormError message={error} />
      <div className="actions">
        <Button onClick={copy}>{copied ? "已复制 JSON" : "复制 JSON"}</Button>
        <Button onClick={download}>下载配置</Button>
      </div>
    </div>
  );
}
