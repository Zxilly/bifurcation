import { LayerCard, LinkButton } from "@cloudflare/kumo";

export default function NotFound() {
  return (
    <LayerCard render={<div />} className="panel stack">
      <h1>找不到该资源</h1>
      <p>它可能已被删除，或链接不正确。</p>
      <div>
        <LinkButton variant="secondary" href="/">返回首页</LinkButton>
      </div>
    </LayerCard>
  );
}
