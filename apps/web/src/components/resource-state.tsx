"use client";

import { Empty, Loader } from "@cloudflare/kumo";

export function ResourceState({
  loading,
  title,
  description,
}: {
  loading: boolean;
  title: string;
  description?: string;
}) {
  return loading ? (
    <div
      role="status"
      className="flex items-center justify-center gap-3 px-4 py-10 text-kumo-subtle"
    >
      <Loader />
      <span>{title}</span>
    </div>
  ) : (
    <Empty
      size="sm"
      className="rounded-none border-0 bg-transparent"
      title={title}
      description={description}
    />
  );
}
