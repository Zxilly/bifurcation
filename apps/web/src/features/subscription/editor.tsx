"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { create } from "@bufbuild/protobuf";
import { Badge, Banner, Button, Input, InputArea, LayerCard } from "@cloudflare/kumo";
import { SubscriptionGroupBindingSchema, type SubscriptionProfile, type PreviewSubscriptionProfileResponse } from "@bifurcation/rpc/panel/me";
import { FormError } from "@/components/modal";
import { JsonDocument } from "@/components/json-document";
import { errorMessage } from "@/features/shared/api";
import { panel } from "@/features/shared/rpc";
import { useResource } from "@/features/shared/use-resource";

const split = (value: string) => value.split(/[,，]+/).map((part) => part.trim()).filter(Boolean);

function ListInput({ label, values, placeholder, onEdit, onCommit }: { label: string; values: string[]; placeholder: string; onEdit: () => void; onCommit: (value: string[]) => void }) {
  const [text, setText] = useState(values.join(", "));
  return <Input label={label} value={text} placeholder={placeholder} onChange={(event) => { setText(event.target.value); onEdit(); }} onBlur={() => onCommit(split(text))} />;
}

export function SubscriptionEditorPage({ id }: { id: string }) {
  const resource = useResource(`me:subscription:${id}`, () => panel.me.getSubscriptionProfile({ id }).then((r) => r.profile!));
  return <div className="mx-auto w-full max-w-6xl min-w-0">
    <Link href="/subscription" className="subtle underline">返回订阅列表</Link>
    <FormError message={resource.error} />
    {resource.error && <Button onClick={resource.refresh}>重新加载</Button>}
    {resource.data ? <Editor key={id} initial={resource.data} /> : <p role="status" className="subtle mt-5">{resource.loading ? "正在加载订阅…" : "订阅暂时无法加载。"}</p>}
  </div>;
}

function Editor({ initial }: { initial: SubscriptionProfile }) {
  const [profile, setProfile] = useState(initial);
  const [name, setName] = useState(initial.name);
  const [templateJson, setTemplateJson] = useState(initial.draft?.templateJson ?? "{}");
  const [bindings, setBindings] = useState(initial.draft?.bindings ?? []);
  const [tab, setTab] = useState<"template" | "groups">("template");
  const [preview, setPreview] = useState<PreviewSubscriptionProfileResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (preview) heading.current?.focus(); }, [preview]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  function change() { setDirty(true); setPreview(null); setNotice(""); }
  async function saveDraft() {
    const result = await panel.me.saveSubscriptionDraft({ id: profile.id, expectedVersion: profile.version, name, draft: { templateJson, bindings } });
    setProfile(result.profile!); setDirty(false); return result.profile!;
  }
  async function save(thenPreview: boolean) {
    setBusy(true); setError(""); setPreview(null); setNotice("");
    try {
      const saved = dirty ? await saveDraft() : profile;
      if (thenPreview) setPreview(await panel.me.previewSubscriptionProfile({ id: profile.id, expectedVersion: saved.version }));
      else setNotice("草稿已保存，客户端仍使用已发布配置。");
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function publish() {
    if (!preview) return;
    setBusy(true); setError("");
    try {
      const result = await panel.me.publishSubscriptionProfile({ id: profile.id, expectedVersion: profile.version, previewId: preview.previewId });
      setProfile(result.profile!); setPreview(null); setNotice("订阅配置已发布。链接保持不变，客户端下次更新订阅时获取新规则；其他订阅不受影响。");
    } catch (e) { setError(errorMessage(e)); setPreview(null); } finally { setBusy(false); }
  }
  async function importFile(file?: File) {
    if (!file) return;
    if (file.size > 1024 * 1024) { setError("配置文件不能超过 1 MiB。"); return; }
    setBusy(true);
    try { setTemplateJson(await file.text()); change(); } catch { setError("读取文件失败，请重试。"); } finally { setBusy(false); }
  }
  return <>
    <div className="page-heading mt-5"><div><h1>编辑订阅配置</h1><p className="subtle mt-2">{profile.name} · {profile.publishedVersion ? `已发布 v${profile.publishedVersion}` : "尚未发布"}{dirty ? " · 有未保存修改" : ""}</p></div>
      <div className="actions"><Button disabled={busy} onClick={() => void save(false)}>保存草稿</Button><Button variant="primary" loading={busy} onClick={() => void save(true)}>生成预览</Button></div>
    </div>
    {notice && <Banner role="status" variant="secondary" className="mb-5">{notice}</Banner>}
    <FormError message={error} />
    {!profile.enabled && <Banner variant="alert" className="mb-5">此订阅已暂停。发布配置不会恢复下载，请在订阅列表中恢复。</Banner>}
    <LayerCard render={<section />} className="panel stack">
      <Input label="订阅名称" value={name} maxLength={64} disabled={busy} onChange={(e) => { setName(e.target.value); change(); }} />
      <div className="actions" aria-label="配置编辑区域"><Button aria-pressed={tab === "template"} variant={tab === "template" ? "primary" : "secondary"} onClick={() => setTab("template")}>基础配置</Button><Button aria-pressed={tab === "groups"} variant={tab === "groups" ? "primary" : "secondary"} onClick={() => setTab("groups")}>节点组与属性</Button></div>
      <fieldset disabled={busy} className="stack min-w-0">
        {tab === "template" ? <>
          <p className="subtle">这里保存完整的客户端规则，例如 DNS、TUN、广告过滤和路由。代理出口的地址、TLS 和账号凭据由平台根据节点配置生成；以 bfc_ 开头的 tag 留给平台使用。</p>
          <div className="actions"><Button type="button" onClick={() => { try { setTemplateJson(JSON.stringify(JSON.parse(templateJson), null, 2)); change(); setError(""); } catch { setError("JSON 格式错误，请修正后再格式化。"); } }}>格式化 JSON</Button><Input type="file" label="导入配置 JSON" accept=".json,application/json" onChange={(e) => void importFile(e.target.files?.[0])} /></div>
          <InputArea label="客户端基础配置 JSON" value={templateJson} rows={24} spellCheck={false} className="font-mono text-xs" onChange={(e) => { setTemplateJson(e.target.value); change(); }} />
          <p className="subtle">保存草稿不影响客户端。配置中的本地路径和远程规则集由客户端处理；预览只检查 JSON、节点组及出口引用，不验证客户端系统权限、远程资源可达性或所有核心选项。</p>
        </> : <>
          <p className="subtle">组 tag 对应基础配置中的 selector / urltest。地区匹配任一填写值，标签须全部匹配；留空表示不限制。筛选只从当前账号可用节点中选取，节点改名不会改变绑定。</p>
          <p className="subtle">默认 AI 组使用 ai 标签，游戏组使用 game 标签。选择组和它引用的自动组应使用一致的属性筛选；无匹配节点时需调整属性或条件。</p>
          {bindings.map((binding, index) => <div key={index} className="stack border-t border-kumo-line pt-5">
            <div className="flex items-end gap-3"><div className="min-w-0 flex-1"><Input label={`组 ${index + 1} tag`} value={binding.groupTag} onChange={(e) => { setBindings((current) => current.map((entry, i) => i === index ? { ...entry, groupTag: e.target.value } : entry)); change(); }} /></div><Button variant="secondary-destructive" onClick={() => { setBindings((current) => current.filter((_, i) => i !== index)); change(); }}>移除此绑定</Button></div>
            <div className="grid gap-4 sm:grid-cols-2">{([
              ["regions", "地区", "例如：日本, 新加坡"], ["tags", "标签", "例如：ai 或 game"], ["protocols", "协议", "trojan, hysteria2；留空包含两者"], ["staticMembers", "固定成员 tag", "例如：auto-ai；先列固定成员，再加入动态节点"], ["machineIds", "仅包含机器 ID", "留空自动包含后来符合属性的节点"], ["excludeMachineIds", "排除机器 ID", "留空不排除"],
            ] as const).map(([key, label, placeholder]) => <ListInput key={`${binding.groupTag}:${key}`} label={`${binding.groupTag || index + 1} · ${label}`} values={binding[key]} placeholder={placeholder} onEdit={change} onCommit={(values) => { setBindings((current) => current.map((entry, i) => i === index ? { ...entry, [key]: values } : entry)); }} />)}</div>
          </div>)}
          <div><Button onClick={() => { setBindings((current) => [...current, create(SubscriptionGroupBindingSchema)]); change(); }}>添加节点组绑定</Button></div>
        </>}
      </fieldset>
    </LayerCard>
    {preview && <LayerCard render={<section />} className="panel stack">
      <div className="panel-header"><h2 ref={heading} tabIndex={-1}>订阅配置预览</h2><Badge variant="secondary">{preview.nodeCount} 个节点</Badge></div>
      <p className="subtle">此预览根据当前节点属性和授权生成，5 分钟内有效。发布只更新这条订阅的规则，不更换链接。</p>
      <details><summary className="cursor-pointer">显示完整配置（含代理凭据）</summary><div className="mt-4"><JsonDocument value={preview.configJson} /></div></details>
      <p className="subtle break-all text-xs">SHA-256 · {preview.digest}</p>
      <div className="flex justify-end gap-2"><Button disabled={busy} onClick={() => setPreview(null)}>继续编辑</Button><Button variant="primary" loading={busy} onClick={publish}>发布此订阅</Button></div>
    </LayerCard>}
  </>;
}
