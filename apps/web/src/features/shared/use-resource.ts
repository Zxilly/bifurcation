"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "./api";
export function useResource<T>(url: string) {
  const [result, setResult] = useState<{ url: string; data: T } | null>(null);
  const [failure, setFailure] = useState<{
    url: string;
    message: string;
  } | null>(null);
  const sequence = useRef(0);
  const update = useCallback(
    (data: T) => {
      sequence.current++;
      setResult({ url, data });
      setFailure(null);
    },
    [url],
  );
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const data = await api<T>(url);
      if (request === sequence.current) {
        setResult({ url, data });
        setFailure(null);
      }
    } catch (e) {
      if (request === sequence.current)
        setFailure({ url, message: errorMessage(e) });
    }
  }, [url]);
  useEffect(() => {
    let active = true;
    const request = ++sequence.current;
    api<T>(url)
      .then((data) => {
        if (active && request === sequence.current) {
          setResult({ url, data });
          setFailure(null);
        }
      })
      .catch((e) => {
        if (active && request === sequence.current)
          setFailure({ url, message: errorMessage(e) });
      });
    return () => {
      active = false;
    };
  }, [url]);
  return {
    data: result?.url === url ? result.data : null,
    error: failure?.url === url ? failure.message : "",
    loading: result?.url !== url && failure?.url !== url,
    refresh,
    update,
  };
}
