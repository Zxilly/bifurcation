"use client";

import { useState } from "react";
import { Banner, Button, Input, LinkButton } from "@cloudflare/kumo";
import type { SubscriptionProfile } from "@bifurcation/rpc/panel/me";

export function PublishedAccess({ profile }: { profile: SubscriptionProfile }) {
  const [manual, setManual] = useState(false);
  const [notice, setNotice] = useState("");
  const unavailable = !profile.enabled || !profile.publishedVersion || !!profile.generationError || profile.nodeCount === 0;
  return <div className="stack">
    <p>在支持 sing-box 配置的客户端中添加远程订阅，粘贴链接并更新配置。以后发布新规则后，在客户端更新同一条订阅即可。</p>
    {unavailable && <Banner variant="alert">{!profile.enabled ? "订阅已暂停，请先回到订阅列表恢复。" : profile.generationError || "当前没有已就绪节点，请联系管理员后再更新订阅。"}</Banner>}
    <div className="flex flex-wrap gap-2">
      <Button variant="primary" disabled={unavailable} onClick={async () => {
        try {
          await navigator.clipboard.writeText(profile.url);
          setNotice("订阅链接已复制，可粘贴到客户端的远程订阅地址。");
        } catch {
          setManual(true);
          setNotice("无法访问剪贴板，请选择完整链接手动复制。");
        }
      }}>复制订阅链接</Button>
      {!unavailable && <LinkButton variant="secondary" href={profile.url} download={`${profile.name}.json`}>下载已发布配置</LinkButton>}
      <Button onClick={() => setManual((value) => !value)}>{manual ? "收起完整链接" : "显示完整链接"}</Button>
    </div>
    {notice && <p role="status">{notice}</p>}
    {manual && <Input label="完整订阅链接" value={profile.url} readOnly onFocus={(event) => event.currentTarget.select()} />}
    <p className="subtle">下载的 JSON 文件是当前配置快照，不会自动更新。订阅链接包含访问凭据，请勿公开分享。</p>
  </div>;
}
