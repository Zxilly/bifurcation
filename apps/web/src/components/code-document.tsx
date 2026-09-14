"use client";

import { CodeHighlighted, ShikiProvider } from "@cloudflare/kumo/code";

export function CodeDocument({
  code,
  label,
  lang = "json",
}: {
  code: string;
  label: string;
  lang?: "json" | "text";
}) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className="max-h-[26rem] min-w-0 overflow-auto"
    >
      <ShikiProvider engine="javascript" languages={["json"]}>
        <CodeHighlighted
          code={code}
          lang={lang}
          showCopyButton={false}
          className="text-sm"
        />
      </ShikiProvider>
    </div>
  );
}
