"use client";
import useSWR from "swr";
import { errorMessage } from "./api";
export function useResource<T>(
  key: string,
  fetcher: () => Promise<T>,
  options: { refreshInterval?: number } = {},
) {
  const { data, error, isLoading, mutate } = useSWR<T>(key, fetcher, {
    refreshInterval: options.refreshInterval,
  });
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
