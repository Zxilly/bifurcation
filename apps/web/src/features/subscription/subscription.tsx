"use client";

import { Banner, LayerCard, Table, Empty, Button, Input, Select, Badge } from "@cloudflare/kumo";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { ListSubscriptionProfilesResponse, SubscriptionProfile } from "@bifurcation/rpc/panel/me";
import { Modal, FormError } from "@/components/modal";
import { JsonDocument } from "@/components/json-document";
import { errorMessage } from "@/features/shared/api";
import { panel } from "@/features/shared/rpc";
import { useServerRefresh } from "@/features/shared/use-refresh";

type Action = { kind: "rotate" | "delete" | "pause" | "resume" | "config" | "link"; profile: SubscriptionProfile };

function profileState(profile: SubscriptionProfile) {
  return !profile.enabled ? "已暂停" : !profile.publishedVersion ? "草稿" : profile.generationError ? "生成失败" : "可下载";
}

// The page provides profiles and node context; mutations re-render it.
export function Subscription({ profiles, context }: Pick<ListSubscriptionProfilesResponse, "profiles" | "context">) {
  const router = useRouter();
  const { pending, refresh } = useServerRefresh();
  const [creating, setCreating] = useState(false);
  const [copyFrom, setCopyFrom] = useState<string>();
  const [name, setName] = useState("");
  const [preset, setPreset] = useState("desktop");
  const requestKey = useRef("");
  const [action, setAction] = useState<Action | null>(null);
  const [credentials, setCredentials] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  function startCreate(source?: SubscriptionProfile) {
    requestKey.current = crypto.randomUUID(); setCopyFrom(source?.id);
    setName(source ? `${source.name} 副本` : ""); setPreset("desktop"); setError(""); setCreating(true);
  }
  async function create(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const result = await panel.me.createSubscriptionProfile({ name, preset, copyFromId: copyFrom, requestKey: requestKey.current });
      router.push(`/subscription/${encodeURIComponent(result.profile!.id)}`);
      setCreating(false);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function inspect(profile: SubscriptionProfile, kind: Action["kind"]) {
    setError(""); setBusy(true);
    try {
      const detail = (await panel.me.getSubscriptionProfile({ id: profile.id })).profile!;
      if (kind === "link") {
        try { await navigator.clipboard.writeText(detail.url); setNotice(`已复制「${profile.name}」的订阅链接。`); return; }
        catch { setNotice("无法访问剪贴板，请选择完整链接手动复制。"); }
      }
      setAction({ profile: detail, kind });
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function mutate() {
    setBusy(true); setError("");
    try {
      if (credentials) {
        await panel.me.resetProxyCredentials({}); setCredentials(false);
        setNotice("代理凭据已重置，等待机器应用新配置。请重新获取订阅。");
      } else if (action) {
        await panel.me.updateSubscriptionProfile({ id: action.profile.id, expectedVersion: action.profile.version, action: action.kind });
        setNotice(action.kind === "rotate" ? "订阅链接已重置，请更新客户端的订阅地址。" : `「${action.profile.name}」已${{ pause: "暂停", resume: "恢复", delete: "删除" }[action.kind as "pause" | "resume" | "delete"]}。`);
        setAction(null);
      }
      refresh();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <>
      <div className="page-heading">
        <div><h1>接入与订阅</h1><p className="subtle mt-2">同一批节点，多套分流规则。为手机、PC 或其他用途分别创建订阅。</p></div>
        <div className="actions"><Button loading={pending} onClick={refresh}>刷新状态</Button><Button variant="primary" onClick={() => startCreate()}>创建订阅</Button></div>
      </div>
      {!action && !creating && !credentials && <FormError message={error} />}
      {notice && <Banner role="status" variant="secondary" className="mb-5">{notice}</Banner>}
      {context?.blocked && <Banner variant="error" className="mb-5">账号已禁用或已达到本月额度，代理接入暂停。</Banner>}
      <LayerCard className="min-w-0 overflow-x-auto p-0">
        <Table>
          <Table.Header><Table.Row><Table.Head>订阅</Table.Head><Table.Head className="hidden sm:table-cell">状态</Table.Head><Table.Head className="hidden sm:table-cell">节点</Table.Head><Table.Head>操作</Table.Head></Table.Row></Table.Header>
          <Table.Body>
            {profiles.map((profile) => <Table.Row key={profile.id}>
              <Table.Cell><Link href={`/subscription/${encodeURIComponent(profile.id)}`} className="underline font-medium">{profile.name}</Link><p className="subtle mt-1">{profile.preset === "legacy" ? "原有配置" : profile.preset === "mobile" ? "手机" : "PC"} · {profile.publishedVersion ? `已发布 v${profile.publishedVersion}` : "未发布"}</p><p className="mt-2 sm:hidden">{profileState(profile)} · {profile.nodeCount} 个节点</p></Table.Cell>
              <Table.Cell className="hidden sm:table-cell"><Badge variant={profile.generationError && profile.publishedVersion ? "destructive" : "secondary"}>{profileState(profile)}</Badge></Table.Cell>
              <Table.Cell className="hidden sm:table-cell">{profile.nodeCount}</Table.Cell>
              <Table.Cell><div className="flex flex-wrap items-center gap-3">
                <Button disabled={busy} onClick={() => void inspect(profile, "link")}>复制链接</Button>
                <Link href={`/subscription/${encodeURIComponent(profile.id)}`} className="underline">编辑配置</Link>
                <details><summary className="cursor-pointer">更多</summary><div className="flex flex-col items-start gap-2 py-3">
                  <Button variant="ghost" onClick={() => void inspect(profile, "config")}>查看与下载配置</Button>
                  <Button variant="ghost" onClick={() => startCreate(profile)}>复制为新订阅</Button>
                  <Button variant="ghost" onClick={() => void inspect(profile, "rotate")}>重置订阅链接</Button>
                  <Button variant="ghost" onClick={() => void inspect(profile, profile.enabled ? "pause" : "resume")}>{profile.enabled ? "暂停订阅" : "恢复订阅"}</Button>
                  <Button variant="secondary-destructive" onClick={() => void inspect(profile, "delete")}>删除订阅</Button>
                </div></details>
              </div></Table.Cell>
            </Table.Row>)}
            {!profiles.length && <Table.Row><Table.Cell colSpan={4}><Empty className="rounded-none border-0 bg-transparent" title="还没有订阅" /></Table.Cell></Table.Row>}
          </Table.Body>
        </Table>
      </LayerCard>
      <section className="panel-section stack mt-8">
        <h2>可用节点</h2><p className="subtle">所有订阅共享这些节点。地区与标签由管理员维护，模板据此生成选择组；各订阅的路由规则相互独立。</p>
        <LayerCard className="min-w-0 overflow-x-auto p-0"><Table>
          <Table.Header><Table.Row><Table.Head>节点</Table.Head><Table.Head>地区 / 标签</Table.Head><Table.Head>接入状态</Table.Head></Table.Row></Table.Header>
          <Table.Body>{context?.nodes.map((node) => <Table.Row key={node.machineId}><Table.Cell>{node.name}</Table.Cell><Table.Cell>{node.region || "未设置地区"}{node.tags.length > 0 && <p className="subtle">{node.tags.join(" · ")}</p>}</Table.Cell><Table.Cell>{node.available ? "可接入" : "未就绪"}</Table.Cell></Table.Row>)}
            {!context?.nodes.length && <Table.Row><Table.Cell colSpan={3}><Empty className="rounded-none border-0 bg-transparent" title="暂无可用节点" /></Table.Cell></Table.Row>}
          </Table.Body>
        </Table></LayerCard>
      </section>
      <section className="panel-section stack mt-8">
        <h2>代理凭据</h2><p className="subtle">所有订阅共用同一套账号代理凭据。重置会影响全部订阅；单独重置或暂停某条订阅链接不会撤销已导入的代理连接。</p>
        <div><Button variant="secondary-destructive" onClick={() => { setError(""); setCredentials(true); }}>重置代理凭据</Button></div>
      </section>
      <Modal title={copyFrom ? "复制为新订阅" : "创建订阅"} open={creating} onClose={() => { if (!busy) setCreating(false); }}>
        <form onSubmit={create} className="stack"><Input label="订阅名称" value={name} onChange={(e) => setName(e.target.value)} required maxLength={64} placeholder="例如：手机日常、PC 游戏" />
          {!copyFrom && <Select label="初始模板" value={preset} onValueChange={(v) => setPreset(String(v))} items={{ desktop: "PC", mobile: "手机" }} />}
          <p className="subtle">创建后进入独立编辑页。配置发布后，客户端才可通过这条链接获取配置。</p><FormError message={error} />
          <div className="mt-8 flex justify-end gap-2"><Button type="button" onClick={() => setCreating(false)} disabled={busy}>取消</Button><Button type="submit" variant="primary" loading={busy}>创建并编辑</Button></div>
        </form>
      </Modal>
      {action && <Modal title={`${{ rotate: "重置订阅链接", delete: "删除订阅", pause: "暂停订阅", resume: "恢复订阅", config: "查看配置", link: "订阅链接" }[action.kind]} · ${action.profile.name}`} size={action.kind === "config" ? "xl" : "lg"} open onClose={() => { if (!busy) setAction(null); }}>
        {action.kind === "config" ? (action.profile.generationError ? <FormError message={action.profile.generationError} /> : <JsonDocument value={action.profile.configJson} />) : action.kind === "link" ? <Input label="完整订阅链接" value={action.profile.url} readOnly onFocus={(event) => event.currentTarget.select()} /> : <div className="stack">
          <p>{action.kind === "rotate" ? "旧链接将立即失效，请更新此订阅的客户端地址。" : action.kind === "delete" ? "此链接将永久失效，删除后无法恢复。" : action.kind === "pause" ? "停止此链接的配置下载，恢复后仍可使用原地址。" : "恢复此链接的配置下载。"}其他订阅保持不变，已导入的代理凭据不受影响。</p><FormError message={error} />
          <div className="mt-8 flex justify-end gap-2"><Button disabled={busy} onClick={() => setAction(null)}>取消</Button><Button variant="destructive" loading={busy} onClick={mutate}>{action.kind === "rotate" ? "重置订阅链接" : action.kind === "delete" ? "删除订阅" : action.kind === "pause" ? "暂停订阅" : "恢复订阅"}</Button></div>
        </div>}
      </Modal>}
      <Modal title="重置代理凭据" open={credentials} onClose={() => { if (!busy) setCredentials(false); }}>
        <div className="stack"><p>所有订阅将使用新代理凭据。机器应用新配置后，旧凭据失效；请更新所有客户端。各条订阅链接保持有效。</p><FormError message={error} /><div className="mt-8 flex justify-end gap-2"><Button disabled={busy} onClick={() => setCredentials(false)}>取消</Button><Button variant="destructive" loading={busy} onClick={mutate}>重置代理凭据</Button></div></div>
      </Modal>
    </>
  );
}
