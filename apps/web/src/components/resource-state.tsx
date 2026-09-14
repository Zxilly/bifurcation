"use client";

import { Loader } from "@cloudflare/kumo";
import { InlineEmpty } from "./inline-empty";

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
    <InlineEmpty title={title} description={description} />
  );
}
