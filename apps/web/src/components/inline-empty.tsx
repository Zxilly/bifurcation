"use client";

import { Empty } from "@cloudflare/kumo";

// Empty state for a table body or a section that already sits inside a
// card: Kumo's Empty is sized for a whole page, so the frame, padding and
// heading scale are pulled down to the surrounding text.
export function InlineEmpty({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <Empty
      size="sm"
      className="gap-1 rounded-none border-0 bg-transparent py-6 [&>h2]:text-base [&>h2]:font-medium [&>p]:text-sm"
      title={title}
      description={description}
    />
  );
}
