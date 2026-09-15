"use client";

import { Button, ClipboardText } from "@cloudflare/kumo";
import { Modal } from "./modal";
export function CopyValue({
  value,
  copyLabel = "复制",
}: {
  value: string;
  copyLabel?: string;
}) {
  return (
    <ClipboardText
      text={value}
      size="base"
      labels={{ copyAction: copyLabel }}
      tooltip={{ text: copyLabel, copiedText: "已复制" }}
    />
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
        <div className="mt-8 flex flex-wrap justify-end gap-2">
          <Button variant="primary" onClick={onClose}>
            完成
          </Button>
        </div>
      </div>
    </Modal>
  );
}
