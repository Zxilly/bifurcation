"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { create } from "@bufbuild/protobuf";
import { Badge, Banner, Button, Input, LayerCard, Tabs } from "@cloudflare/kumo";
import { SubscriptionGroupBindingSchema, type SubscriptionGroupBinding, type SubscriptionProfile, type PreviewSubscriptionProfileResponse, type Subscription } from "@bifurcation/rpc/panel/me";
import { FormError, Modal } from "@/components/modal";
import { JsonDocument } from "@/components/json-document";
import { JsonEditor } from "@/components/json-editor";
import { UnsavedChanges } from "@/components/unsaved-changes";
import { ApiError, errorMessage } from "@/features/shared/api";
import { panel } from "@/features/shared/rpc";
import { NodeSelection } from "./node-selection";
import { PublishedAccess } from "./published-access";

const bindingFields = [
  ["regions", "地区", "例如：日本, 新加坡"],
  ["tags", "标签", "例如：ai 或 game"],
  ["protocols", "协议", "trojan, hysteria2；留空包含两者"],
  ["staticMembers", "固定成员 tag", "例如：auto-ai；先列固定成员，再加入动态节点"],
  ["machineIds", "仅包含机器 ID", "留空自动包含后来符合属性的节点"],
  ["excludeMachineIds", "排除机器 ID", "留空不排除"],
] as const;
type BindingField = (typeof bindingFields)[number][0];
type BindingDraft = Record<BindingField | "groupTag", string> & { key: number };
type EditorTab = "nodes" | "template" | "groups";
type PendingAction = "save" | "preview" | "publish" | "import" | "reload" | null;

const split = (value: string) => value.split(/[,，]+/).map((part) => part.trim()).filter(Boolean);
function bindingDraft(binding: SubscriptionGroupBinding, key: number): BindingDraft {
  return {
    key, groupTag: binding.groupTag,
    regions: binding.regions.join(", "), tags: binding.tags.join(", "),
    protocols: binding.protocols.join(", "), staticMembers: binding.staticMembers.join(", "),
    machineIds: binding.machineIds.join(", "), excludeMachineIds: binding.excludeMachineIds.join(", "),
  };
}
function bindingInput(binding: BindingDraft) {
  return create(SubscriptionGroupBindingSchema, {
    groupTag: binding.groupTag,
    regions: split(binding.regions), tags: split(binding.tags),
    protocols: split(binding.protocols), staticMembers: split(binding.staticMembers),
    machineIds: split(binding.machineIds), excludeMachineIds: split(binding.excludeMachineIds),
  });
}

// The page provides the profile; the editor owns the draft from then on.
export function SubscriptionEditorPage({ profile, context }: { profile: SubscriptionProfile; context?: Subscription }) {
  return <div className="w-full min-w-0">
    <Link href="/subscription" className="subtle underline">返回订阅列表</Link>
    <Editor key={profile.id} initial={profile} initialContext={context} />
  </div>;
}

function Editor({ initial, initialContext }: { initial: SubscriptionProfile; initialContext?: Subscription }) {
  const [profile, setProfile] = useState(initial);
  const [name, setName] = useState(initial.name);
  const [templateJson, setTemplateJson] = useState(initial.draft?.templateJson ?? "{}");
  // Keep raw text in the parent so separators survive typing, tab switches and saves.
  const [bindings, setBindings] = useState(() => (initial.draft?.bindings ?? []).map(bindingDraft));
  const nextBindingKey = useRef(bindings.length);
  const [tab, setTab] = useState<EditorTab>("nodes");
  const [context, setContext] = useState(initialContext);
  const [refreshingNodes, setRefreshingNodes] = useState(false);
  const [published, setPublished] = useState(false);
  const [preview, setPreview] = useState<PreviewSubscriptionProfileResponse | null>(null);
  const [expiredPreviewId, setExpiredPreviewId] = useState("");
  const [pending, setPending] = useState<PendingAction>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const [reloadOpen, setReloadOpen] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = pending !== null;
  const previewExpired = !!preview && expiredPreviewId === preview.previewId;

  useEffect(() => {
    if (!preview) return;
    heading.current?.focus();
    const timer = window.setTimeout(() => setExpiredPreviewId(preview.previewId), Math.max(0, Number(preview.expiresAt) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [preview]);

  function change() { setDirty(true); setPreview(null); setNotice(""); setPublished(false); }
  function editBinding(key: number, field: BindingField | "groupTag", value: string) {
    setBindings((current) => current.map((binding) => binding.key === key ? { ...binding, [field]: value } : binding));
    change();
  }
  function handleError(error: unknown) {
    if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
      setConflict(true); setPreview(null); setError("");
    } else setError(errorMessage(error));
  }
  async function saveDraft(currentTemplate: string) {
    const result = await panel.me.saveSubscriptionDraft({ id: profile.id, expectedVersion: profile.version, name, draft: { templateJson: currentTemplate, bindings: bindings.map(bindingInput) } });
    setProfile(result.profile!); setDirty(false); setConflict(false);
    return result.profile!;
  }
  async function save(thenPreview: boolean, currentTemplate = templateJson) {
    setPending(thenPreview ? "preview" : "save"); setError(""); setPreview(null); setNotice("");
    try {
      const saved = dirty || currentTemplate !== templateJson ? await saveDraft(currentTemplate) : profile;
      if (thenPreview) setPreview(await panel.me.previewSubscriptionProfile({ id: profile.id, expectedVersion: saved.version }));
      else setNotice(saved.publishedVersion ? "草稿已保存，客户端仍使用已发布配置。" : "草稿已保存。生成预览并发布后，客户端才可下载配置。");
    } catch (error) { handleError(error); } finally { setPending(null); }
  }
  async function publish() {
    if (!preview) return;
    if (Number(preview.expiresAt) <= Date.now()) { setExpiredPreviewId(preview.previewId); return; }
    setPending("publish"); setError("");
    try {
      const result = await panel.me.publishSubscriptionProfile({ id: profile.id, expectedVersion: profile.version, previewId: preview.previewId });
      setProfile(result.profile!); setPreview(null);
      setPublished(true);
      setNotice("订阅配置已发布。链接保持不变，客户端下次更新订阅时获取新规则；其他订阅不受影响。");
    } catch (error) { handleError(error); setPreview(null); } finally { setPending(null); }
  }
  async function importFile(file?: File) {
    if (!file) return;
    setError("");
    if (file.size > 1024 * 1024) { setError("配置文件不能超过 1 MiB。"); return; }
    setPending("import");
    try { setTemplateJson(await file.text()); change(); }
    catch { setError("读取文件失败，请重试。"); }
    finally { setPending(null); }
  }
  async function reloadDraft() {
    setPending("reload"); setError("");
    try {
      const latest = (await panel.me.getSubscriptionProfile({ id: profile.id })).profile!;
      setProfile(latest); setName(latest.name); setTemplateJson(latest.draft?.templateJson ?? "{}");
      setBindings((latest.draft?.bindings ?? []).map((binding) => bindingDraft(binding, nextBindingKey.current++)));
      setDirty(false); setPreview(null); setConflict(false); setReloadOpen(false);
      setNotice("已载入最新草稿，可以继续编辑。");
    } catch (error) { setError(errorMessage(error)); } finally { setPending(null); }
  }

  async function refreshNodes() {
    setRefreshingNodes(true); setError("");
    try { setContext((await panel.me.listSubscriptionProfiles({})).context); }
    catch (error) { setError(errorMessage(error)); }
    finally { setRefreshingNodes(false); }
  }

  return <>
    <UnsavedChanges dirty={dirty} />
    <div className="mt-4 mb-5 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1>编辑订阅配置</h1><p className="subtle mt-2 break-words">{profile.name}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{dirty ? "有未保存修改" : "草稿已保存"}</Badge>
          <span className="subtle">{profile.publishedVersion ? `客户端使用已发布 v${profile.publishedVersion}` : "尚未发布，客户端暂不可下载"}</span>
        </div>
      </div>
      <div className="flex w-full gap-2 sm:w-auto sm:shrink-0">
        <Button className="flex-1 sm:flex-none" disabled={busy || !dirty} loading={pending === "save"} onClick={() => void save(false)}>保存草稿</Button>
        <Button className="flex-1 sm:flex-none" variant={preview && !previewExpired ? "secondary" : "primary"} disabled={busy} loading={pending === "preview"} onClick={() => void save(true)}>生成预览</Button>
      </div>
    </div>
    {notice && <Banner role="status" variant="secondary" className="mb-5">{notice}</Banner>}
    {published && <LayerCard render={<section />} className="panel stack mb-5">
      <h2 tabIndex={-1} ref={(element) => element?.focus()}>添加到客户端</h2>
      <PublishedAccess profile={profile} />
    </LayerCard>}
    {!reloadOpen && <FormError message={error} />}
    {conflict && <Banner role="alert" variant="alert" className="mb-5">
      <div className="stack gap-3">
        <p className="font-medium">订阅已在其他页面更新</p>
        <p>当前编辑内容仍保留在此页，尚未覆盖服务器上的草稿。请先复制需要保留的内容，再载入最新草稿。</p>
        <div><Button disabled={busy} onClick={() => setReloadOpen(true)}>载入最新草稿</Button></div>
      </div>
    </Banner>}
    {!profile.enabled && <Banner variant="alert" className="mb-5">此订阅已暂停。发布配置不会恢复下载，请在订阅列表中恢复。</Banner>}
    {context?.blocked && <Banner variant="error" className="mb-5">账号已禁用或已达到本月额度，当前不能发布或使用订阅。请联系管理员。</Banner>}
    <LayerCard render={<section />} className="panel flex min-w-0 flex-col gap-4">
      <Input label="订阅名称" value={name} maxLength={64} disabled={busy} onChange={(event) => { setName(event.target.value); change(); }} />
      <Tabs variant="underline" value={tab} onValueChange={(value) => setTab(value as EditorTab)}
        labels={{ scrollStart: "向左查看更多标签", scrollEnd: "向右查看更多标签" }}
        tabs={[{ value: "nodes", label: "选择节点" }, { value: "template", label: "高级 JSON 配置" }, { value: "groups", label: "节点组与属性" }].map((item) => ({
          ...item, render: <button id={`subscription-tab-${item.value}`} aria-controls={`subscription-panel-${item.value}`} />,
        }))}
      />
      <div id="subscription-panel-nodes" role="tabpanel" aria-labelledby="subscription-tab-nodes" tabIndex={0} hidden={tab !== "nodes"}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <p className="subtle">{profile.preset === "mobile" ? "手机模板" : profile.preset === "desktop" ? "PC 模板" : "当前模板"} · 无需修改 JSON 即可选择节点</p>
          <Button disabled={busy || refreshingNodes} loading={refreshingNodes} onClick={() => void refreshNodes()}>刷新可用节点</Button>
        </div>
        <NodeSelection bindings={bindings.map((binding) => ({ ...bindingInput(binding), key: binding.key }))} templateJson={templateJson} nodes={context?.nodes ?? []} disabled={busy || !!context?.blocked} onApply={(keys, machineIds) => {
          setBindings((current) => current.map((binding) => keys.includes(binding.key) ? {
            ...binding, machineIds: machineIds.join(", "), regions: "", tags: "", protocols: "", excludeMachineIds: "",
          } : binding));
          change();
        }} />
      </div>
      {/* Keep both panels mounted so Monaco retains undo history, folds and cursor state. */}
      <div id="subscription-panel-template" role="tabpanel" aria-labelledby="subscription-tab-template" tabIndex={0} hidden={tab !== "template"} className="min-w-0">
        <fieldset disabled={busy} className="flex min-w-0 flex-col gap-3">
          <p className="subtle">编辑客户端的 DNS、TUN 和分流规则。保存草稿后，预览并发布才会更新客户端下载的配置。</p>
          <JsonEditor
            label="客户端基础配置 JSON"
            variant="workspace"
            value={templateJson}
            rows={24}
            disabled={busy}
            onChange={(value) => { setTemplateJson(value); change(); }}
            onSave={(value) => { if (!busy && (dirty || value !== templateJson)) void save(false, value); }}
            toolbar={<>
              <Button type="button" size="sm" disabled={busy} loading={pending === "import"} onClick={() => fileInput.current?.click()}>导入 JSON 文件</Button>
              <input ref={fileInput} type="file" accept=".json,application/json" className="sr-only" tabIndex={-1} aria-hidden onChange={(event) => { void importFile(event.target.files?.[0]); event.target.value = ""; }} />
            </>}
          />
          <details className="subtle"><summary className="cursor-pointer">平台生成内容与预览检查范围</summary><div className="mt-3 space-y-3">
            <p>代理出口的地址、TLS 和账号凭据由平台根据节点配置生成；以 bfc_ 开头的 tag 留给平台使用。</p>
            <p>配置中的本地路径和远程规则集由客户端处理；预览只检查 JSON、节点组及出口引用，不验证客户端系统权限、远程资源可达性或所有核心选项。</p>
          </div></details>
        </fieldset>
      </div>
      <div id="subscription-panel-groups" role="tabpanel" aria-labelledby="subscription-tab-groups" tabIndex={0} hidden={tab !== "groups"} className="min-w-0">
        <fieldset disabled={busy} className="stack min-w-0">
          <p className="subtle">按地区、标签和协议为每个节点组选择节点。多个值用逗号分隔，留空表示不限制。</p>
          <details className="subtle"><summary className="cursor-pointer">节点组如何匹配与引用</summary><div className="mt-3 space-y-3">
            <p>组 tag 对应基础配置中的 selector / urltest。地区匹配任一填写值，标签须全部匹配；筛选只从当前账号可用节点中选取，节点改名不会改变绑定。</p>
            <p>默认 AI 组使用 ai 标签，游戏组使用 game 标签。选择组和它引用的自动组应使用一致的属性筛选；无匹配节点时需调整属性或条件。</p>
          </div></details>
          {!bindings.length && <p>尚未添加节点组绑定。添加绑定后，可按属性自动选择当前账号可用的节点。</p>}
          {bindings.map((binding, index) => <div key={binding.key} className="stack border-t border-kumo-line pt-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1"><Input label={`组 ${index + 1} tag`} value={binding.groupTag} onChange={(event) => editBinding(binding.key, "groupTag", event.target.value)} /></div>
              <Button className="self-start sm:self-auto" variant="secondary-destructive" onClick={() => { setBindings((current) => current.filter((entry) => entry.key !== binding.key)); change(); }}>移除此绑定</Button>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">{bindingFields.map(([key, label, placeholder]) =>
              <Input key={key} label={`${binding.groupTag || index + 1} · ${label}`} value={binding[key]} placeholder={placeholder} onChange={(event) => editBinding(binding.key, key, event.target.value)} />,
            )}</div>
          </div>)}
          <div><Button onClick={() => {
            const binding = bindingDraft(create(SubscriptionGroupBindingSchema), nextBindingKey.current++);
            setBindings((current) => [...current, binding]); change();
          }}>添加节点组绑定</Button></div>
        </fieldset>
      </div>
    </LayerCard>
    {preview && <LayerCard render={<section />} className="panel stack mt-6">
      <div className="panel-header"><h2 ref={heading} tabIndex={-1}>订阅配置预览</h2><Badge variant="secondary">{preview.nodeCount} 台可用节点</Badge></div>
      <p className="subtle">这里统计账号可用节点，各用途实际使用的节点以节点组选择为准。</p>
      {previewExpired ? <Banner role="status" variant="alert">预览已过期。请重新生成，确认当前节点和授权后再发布。</Banner>
        : <p className="subtle">有效至 {new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Asia/Shanghai" }).format(Number(preview.expiresAt))}（上海时间）。发布只更新这条订阅的规则，不更换链接。</p>}
      <details><summary className="cursor-pointer">显示完整配置（含代理凭据）</summary><div className="mt-4 stack"><JsonDocument value={preview.configJson} /><p className="subtle break-all text-xs">SHA-256 · {preview.digest}</p></div></details>
      <div className="flex flex-wrap justify-end gap-2">
        <Button disabled={busy} onClick={() => setPreview(null)}>继续编辑</Button>
        {previewExpired ? <Button variant="primary" disabled={busy} loading={pending === "preview"} onClick={() => void save(true)}>重新生成预览</Button>
          : <Button variant="primary" disabled={busy} loading={pending === "publish"} onClick={publish}>发布此订阅</Button>}
      </div>
    </LayerCard>}
    <Modal title="载入最新草稿" role="alertdialog" open={reloadOpen} onClose={() => { if (!busy) setReloadOpen(false); }}>
      <div className="stack">
        <p>这会替换当前页的订阅名称、基础配置和节点组，未保存的编辑将丢失。请先取消并复制需要保留的内容；服务器上的已发布配置不受影响。</p>
        <FormError message={error} />
        <div className="mt-8 flex flex-wrap justify-end gap-2"><Button disabled={busy} onClick={() => setReloadOpen(false)}>继续保留当前编辑</Button><Button variant="destructive" disabled={busy} loading={pending === "reload"} onClick={() => void reloadDraft()}>放弃当前编辑并载入</Button></div>
      </div>
    </Modal>
  </>;
}
