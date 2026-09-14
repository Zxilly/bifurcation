"use client";

import { Banner, Button, Dialog } from "@cloudflare/kumo";
import { XIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
export function Modal({
  title,
  open,
  onClose,
  children,
  size = "lg",
  role = "dialog",
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  size?: "lg" | "xl";
  role?: "dialog" | "alertdialog";
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // Callers mount dialogs on demand. Start Base UI closed so opening still
    // passes through its native starting styles, as with a persistent Trigger.
    const frame = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <Dialog.Root
      role={role}
      open={open && mounted}
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
