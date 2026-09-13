"use client";
import { Button } from "@cloudflare/kumo";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <div className="panel stack">
      <h1>页面暂时无法加载</h1>
      <p>请重试。如果问题持续，请联系管理员。</p>
      <div>
        <Button onClick={reset}>重新加载</Button>
      </div>
    </div>
  );
}
