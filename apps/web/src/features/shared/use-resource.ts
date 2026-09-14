"use client";
import useSWR from "swr";
import { Code } from "@connectrpc/connect";
import { ApiError, errorMessage } from "./api";

type Snapshot<T> = { value: T; updatedAt: number };

export function useResource<T>(
  key: string,
  fetcher: () => Promise<T>,
  options: { refreshInterval?: number } = {},
) {
  const { data, error, isLoading, isValidating, mutate } = useSWR<Snapshot<T>>(
    key,
    async () => ({ value: await fetcher(), updatedAt: Date.now() }),
    { refreshInterval: options.refreshInterval },
  );
  const accessDenied =
    error instanceof ApiError &&
    (error.transportCode === Code.Unauthenticated ||
      error.transportCode === Code.PermissionDenied);
  return {
    data: accessDenied ? null : (data?.value ?? null),
    updatedAt: accessDenied ? null : (data?.updatedAt ?? null),
    error: error ? errorMessage(error) : "",
    loading: isLoading,
    refreshing: isValidating,
    refresh: async () => {
      try {
        await mutate();
      } catch {
        // SWR reports the error. Keep it until a successful response, so a
        // retry cannot briefly expose a snapshot whose access was denied.
      }
    },
    update: (value: T) => {
      void mutate({ value, updatedAt: Date.now() }, { revalidate: false });
    },
  };
}
