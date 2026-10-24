"use client";

import { Button, Input } from "@cloudflare/kumo";
import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Modal, ModalActions } from "./modal";
export function CopyValue({
  value,
  copyLabel = "复制",
}: {
  value: string;
  copyLabel?: string;
}) {
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const [manualValue, setManualValue] = useState<string | null>(null);
  const [failedValue, setFailedValue] = useState<string | null>(null);
  const copied = copiedValue === value;
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedValue(value);
      setFailedValue(null);
    } catch {
      setCopiedValue(null);
      setFailedValue(value);
      setManualValue(value);
    }
  }
  return (
    <div className="min-w-0 space-y-3">
      <div className="flex min-w-0 items-center gap-2 rounded-lg bg-kumo-recessed p-2">
        <span className="min-w-0 flex-1 truncate px-1 font-mono text-sm">{value}</span>
        <Button aria-label={copyLabel} icon={copied ? CheckIcon : CopyIcon} onClick={() => void copy()}>{copied ? "已复制" : copyLabel}</Button>
        <Button variant="ghost" onClick={() => setManualValue(manualValue === value ? null : value)} aria-expanded={manualValue === value}>手动复制</Button>
      </div>
      <div role="status" className="subtle text-sm">
        {failedValue === value ? "无法访问剪贴板，请在下方选择完整内容后手动复制。" : copied ? "已复制到剪贴板。" : null}
      </div>
      {manualValue === value && <Input label="完整内容" value={value} readOnly onFocus={(event) => event.currentTarget.select()} />}
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
        <ModalActions>
          <Button variant="primary" onClick={onClose}>
            完成
          </Button>
        </ModalActions>
      </div>
    </Modal>
  );
}
