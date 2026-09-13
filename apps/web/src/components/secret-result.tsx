"use client";
import { useState } from "react";
import { Button } from "@cloudflare/kumo";
import { Modal, FormError } from "./modal";
export function CopyValue({
  value,
  copyLabel = "复制",
}: {
  value: string;
  copyLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setError("");
    } catch {
      setError("无法访问剪贴板，请选择并手动复制。");
    }
  }
  return (
    <div className="stack">
      <code className="secret">{value}</code>
      <FormError message={error} />
      <div>
        <Button onClick={copy}>{copied ? "已复制" : copyLabel}</Button>
      </div>
    </div>
  );
}
export function SecretResult({
  title,
  value,
  onClose,
}: {
  title: string;
  value: string;
  onClose: () => void;
}) {
  return (
    <Modal title={title} open onClose={onClose}>
      <div className="stack">
        <p className="subtle">请现在复制并妥善保存，关闭后不会再次显示。</p>
        <CopyValue value={value} />
        <div className="actions">
          <Button variant="primary" onClick={onClose}>
            完成
          </Button>
        </div>
      </div>
    </Modal>
  );
}
