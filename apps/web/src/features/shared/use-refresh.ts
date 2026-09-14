"use client";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

// Re-renders the Server Components that provided this page's data after a
// mutation. The transition keeps the current view until fresh data arrives.
export function useServerRefresh() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return { pending, refresh: () => startTransition(() => router.refresh()) };
}
