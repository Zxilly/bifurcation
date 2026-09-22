"use client";

import { Button } from "@cloudflare/kumo";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Modal } from "./modal";

/** Protect local editor state when following links or leaving the document. */
export function UnsavedChanges({ dirty }: { dirty: boolean }) {
  const router = useRouter();
  const [destination, setDestination] = useState<{ href: string; historyKey?: string } | null>(null);
  const allowedTraversal = useRef<string | null>(null);

  useEffect(() => {
    if (!dirty) return;
    function beforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
    }
    function followLink(event: MouseEvent) {
      if (
        event.defaultPrevented || event.button !== 0 ||
        event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
      ) return;
      const link = event.target instanceof Element
        ? event.target.closest<HTMLAnchorElement>("a[href]")
        : null;
      if (!link || link.hasAttribute("download") || (link.target && link.target !== "_self")) return;
      const url = new URL(link.href);
      if (url.origin !== location.origin || !["http:", "https:"].includes(url.protocol)) return;
      if (url.pathname === location.pathname && url.search === location.search) return;
      event.preventDefault();
      event.stopPropagation();
      setDestination({ href: url.pathname + url.search + url.hash });
    }
    function traverse(event: NavigateEvent) {
      if (event.navigationType !== "traverse" || !event.cancelable || !event.destination.sameDocument) return;
      if (allowedTraversal.current === event.destination.key) {
        allowedTraversal.current = null;
        return;
      }
      const url = new URL(event.destination.url);
      if (url.pathname === location.pathname && url.search === location.search) return;
      // Cancel before popstate restores the Next route, preserving the editor
      // and the existing browser history until the user makes a choice.
      event.preventDefault();
      setDestination({ href: url.pathname + url.search + url.hash, historyKey: event.destination.key });
    }
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", followLink, true);
    window.navigation?.addEventListener("navigate", traverse);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", followLink, true);
      window.navigation?.removeEventListener("navigate", traverse);
    };
  }, [dirty]);

  return (
    <Modal title="放弃未保存的修改？" role="alertdialog" open={destination !== null} onClose={() => setDestination(null)}>
      <p className="subtle">当前编辑尚未保存。离开后这些修改会丢失，已发布配置不受影响。</p>
      <div className="mt-8 flex flex-wrap justify-end gap-2">
        <Button onClick={() => setDestination(null)}>继续编辑</Button>
        <Button variant="destructive" onClick={() => {
          if (!destination) return;
          if (destination.historyKey && window.navigation) {
            allowedTraversal.current = destination.historyKey;
            void window.navigation.traverseTo(destination.historyKey).finished?.catch(() => {
              allowedTraversal.current = null;
            });
          } else router.push(destination.href);
          setDestination(null);
        }}>放弃修改并离开</Button>
      </div>
    </Modal>
  );
}
