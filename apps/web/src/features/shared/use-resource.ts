"use client";
import useSWR from "swr";
import { api, errorMessage } from "./api";
export function useResource<T>(
  url: string,
  options: { refreshInterval?: number } = {},
) {
  const { data, error, isLoading, mutate } = useSWR<T>(
    url,
    (path: string) => api<T>(path),
    { refreshInterval: options.refreshInterval },
  );
  return {
    data: data ?? null,
    error: error ? errorMessage(error) : "",
    loading: isLoading,
    refresh: async () => {
      await mutate();
    },
    update: (value: T) => {
      void mutate(value, { revalidate: false });
    },
  };
}
