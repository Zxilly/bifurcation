"use client";

import { useState } from "react";
import { Badge, Banner, Button, Checkbox } from "@cloudflare/kumo";
import { Protocol, type SubscriptionGroupBinding, type SubscriptionNode } from "@bifurcation/rpc/panel/me";
import { Modal } from "@/components/modal";

type Binding = SubscriptionGroupBinding & { key: number };
type Group = { name: string; bindings: Binding[] };
const presets = [
  ["select", "auto", "日常访问"],
  ["select-ai", "auto-ai", "AI 服务"],
  ["select-game", "auto-game", "游戏"],
] as const;

function matches(binding: Binding, node: SubscriptionNode) {
  return node.available &&
    (!binding.regions.length || binding.regions.includes(node.region)) &&
    binding.tags.every((tag) => node.tags.includes(tag)) &&
    (!binding.machineIds.length || binding.machineIds.includes(node.machineId)) &&
    !binding.excludeMachineIds.includes(node.machineId) &&
    (!binding.protocols.length || binding.protocols.some((protocol) =>
      node.protocols.includes(protocol === "trojan" ? Protocol.TROJAN : protocol === "hysteria2" ? Protocol.HYSTERIA2 : Protocol.UNSPECIFIED)));
}

function groupsFor(bindings: Binding[], templateJson: string): Group[] {
  let outbounds: { type?: string; tag?: string }[] = [];
  try {
    const template = JSON.parse(templateJson);
    if (Array.isArray(template?.outbounds)) outbounds = template.outbounds.filter((entry: unknown) => entry && typeof entry === "object");
  } catch { /* Invalid JSON remains editable in the advanced tab. */ }
  const used = new Set<number>();
  const groups: Group[] = [];
  for (const [selectorTag, autoTag, name] of presets) {
    const selector = bindings.filter((binding) => binding.groupTag === selectorTag);
    const auto = bindings.filter((binding) => binding.groupTag === autoTag);
    if (selector.length !== 1 || auto.length !== 1 ||
      !outbounds.some((entry) => entry.tag === selectorTag && entry.type === "selector") ||
      !outbounds.some((entry) => entry.tag === autoTag && entry.type === "urltest") ||
      !selector[0].staticMembers.includes(autoTag) ||
      selector[0].staticMembers.some((tag) => tag !== autoTag && !outbounds.some((entry) => entry.tag === tag && entry.type === "direct")) ||
      auto[0].staticMembers.length) continue;
    groups.push({ name, bindings: [selector[0], auto[0]] });
    used.add(selector[0].key); used.add(auto[0].key);
  }
  for (const binding of bindings) if (!used.has(binding.key)) groups.push({ name: binding.groupTag || "未命名组", bindings: [binding] });
  return groups;
}

function filterSummary(binding: Binding) {
  const parts = [
    binding.regions.length ? `地区：${binding.regions.join("、")}` : "",
    binding.tags.length ? `标签：${binding.tags.join("、")}` : "",
    binding.protocols.length ? `协议：${binding.protocols.join("、")}` : "",
    binding.machineIds.length ? `固定选择 ${binding.machineIds.length} 台节点` : "",
    binding.excludeMachineIds.length ? `排除 ${binding.excludeMachineIds.length} 台节点` : "",
  ].filter(Boolean);
  return parts.join("；") || "自动包含当前及后来符合授权的节点";
}

export function NodeSelection({ bindings, templateJson, nodes, disabled, onApply }: {
  bindings: Binding[];
  templateJson: string;
  nodes: SubscriptionNode[];
  disabled: boolean;
  onApply: (keys: number[], machineIds: string[]) => void;
}) {
  const groups = groupsFor(bindings, templateJson);
  const [editing, setEditing] = useState<Group | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const available = nodes.filter((node) => node.available);

  return <div className="stack">
    <p className="subtle">为每种用途选择节点，然后生成预览并发布。已有筛选会保留，只有应用新的节点选择才会修改本订阅草稿。</p>
    {!available.length && <Banner variant="alert">暂无已就绪的节点。请联系管理员完成节点配置；现在可以保存草稿，节点就绪后再预览发布。</Banner>}
    {!groups.length && <p className="subtle">此配置没有节点组绑定。可在“节点组与属性”中添加。</p>}
    {groups.map((group) => {
      const unmatched = group.bindings.filter((binding) => !nodes.some((node) => matches(binding, node)));
      return <section key={group.bindings[0].key} aria-label={`${group.name}节点`} className="border-t border-kumo-line pt-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2"><h2>{group.name}</h2>{unmatched.length > 0 && <Badge variant="destructive">需要选择节点</Badge>}</div>
          <Button disabled={disabled || !available.length} onClick={() => {
            setEditing(group);
            setSelected(available.filter((node) => group.bindings.some((binding) => matches(binding, node))).map((node) => node.machineId));
          }}>选择{group.name}节点</Button>
        </div>
        <div className="mt-3 space-y-3">{group.bindings.map((binding) => {
          const matched = nodes.filter((node) => matches(binding, node));
          return <div key={binding.key} className="text-sm">
            <p className="subtle break-words">{group.bindings.length > 1 ? (binding === group.bindings[0] ? "手动选择" : "自动测速") : binding.groupTag} · {filterSummary(binding)}</p>
            <p className="mt-1 break-words">{matched.length ? matched.map((node) => node.name).join("、") : "没有符合当前条件的节点，请选择节点或调整高级筛选。"}</p>
          </div>;
        })}</div>
      </section>;
    })}
    <Modal title={`选择${editing?.name ?? ""}节点`} open={!!editing} onClose={() => setEditing(null)}>
      <div className="stack">
        <p>应用后，这{editing?.bindings.length === 2 ? "两个关联组" : "个组"}将仅使用所选节点，并替换原有地区、标签、协议和排除条件。后来新增的节点不会自动加入。</p>
        <p className="subtle break-words">修改范围：{editing?.bindings.map((binding) => binding.groupTag).join("、")}。固定成员引用保持不变；最终结果由预览检查。</p>
        <div><Button onClick={() => setSelected(available.map((node) => node.machineId))}>选择全部已就绪节点</Button></div>
        <div className="max-h-80 space-y-4 overflow-y-auto py-1">{nodes.map((node) => <div key={node.machineId}>
          <Checkbox disabled={!node.available || disabled} checked={selected.includes(node.machineId)} label={`${node.name} · ${node.region || "未设置地区"}${node.available ? "" : " · 未就绪"}`} onCheckedChange={(checked) => setSelected((current) => checked ? [...current, node.machineId] : current.filter((id) => id !== node.machineId))} />
          {node.tags.length > 0 && <p className="subtle mt-1 pl-7 text-sm">{node.tags.join(" · ")}</p>}
        </div>)}</div>
        <p className="subtle">已选择 {selected.length} 台节点。至少选择一台才能应用。</p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button onClick={() => setEditing(null)}>取消</Button>
          <Button variant="primary" disabled={disabled || !selected.length} onClick={() => {
            if (!editing || !selected.length) return;
            onApply(editing.bindings.map((binding) => binding.key), selected);
            setEditing(null);
          }}>应用到本订阅草稿</Button>
        </div>
      </div>
    </Modal>
  </div>;
}
