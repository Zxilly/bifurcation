"use client";

import { Banner, Button, Dialog } from "@cloudflare/kumo";
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
        className="max-h-[calc(100dvh-96px)] overflow-y-auto p-8"
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <Dialog.Title className="text-2xl font-semibold">
            {title}
          </Dialog.Title>
          <Dialog.Close
            render={
              <Button
                variant="secondary"
                shape="square"
                aria-label="关闭"
                icon={<XIcon size={18} />}
              />
            }
          />
        </div>
        {children}
      </Dialog>
    </Dialog.Root>
  );
}
export function FormError({ message }: { message: string }) {
  return message ? (
    <Banner role="alert" variant="error" size="sm">
      {message}
    </Banner>
  ) : null;
}
