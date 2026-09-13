"use client";
import { Button, Dialog } from "@cloudflare/kumo";
import { XIcon } from "@phosphor-icons/react";
export function Modal({
  title,
  open,
  onClose,
  children,
  size = "lg",
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  size?: "lg" | "xl";
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <Dialog
        size={size}
        className="max-h-[calc(100dvh-48px)] overflow-y-auto p-6"
      >
        <div className="panel-header">
          <Dialog.Title className="dialog-title">{title}</Dialog.Title>
          <Button
            variant="ghost"
            shape="square"
            aria-label="关闭"
            icon={<XIcon size={18} />}
            onClick={onClose}
          />
        </div>
        {children}
      </Dialog>
    </Dialog.Root>
  );
}
export function FormError({ message }: { message: string }) {
  return message ? (
    <p role="alert" className="form-error">
      {message}
    </p>
  ) : null;
}
