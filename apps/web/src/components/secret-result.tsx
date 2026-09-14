"use client";

import {
  Button,
  ClipboardText,
  Collapsible,
  InputArea,
} from "@cloudflare/kumo";
import { Modal } from "./modal";
export function CopyValue({
  value,
  copyLabel = "复制",
}: {
  value: string;
  copyLabel?: string;
}) {
  return (
    <div className="stack min-w-0 gap-3">
      <ClipboardText
        text={value}
        size="base"
        labels={{ copyAction: copyLabel }}
        tooltip={{ text: copyLabel, copiedText: "已复制" }}
      />
      <Collapsible.Root>
        <Collapsible.DefaultTrigger>
          查看完整内容 / 手动复制
        </Collapsible.DefaultTrigger>
        <Collapsible.DefaultPanel>
          <InputArea
            label="完整内容"
            description="未出现“已复制”提示时，可选择这里的完整文本手动复制。"
            value={value}
            readOnly
            className="font-mono text-sm"
            onFocus={(event) => event.currentTarget.select()}
          />
        </Collapsible.DefaultPanel>
      </Collapsible.Root>
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
        <div className="mt-8 flex flex-wrap justify-end gap-2">
          <Button variant="primary" onClick={onClose}>
            完成
          </Button>
        </div>
      </div>
    </Modal>
  );
}
