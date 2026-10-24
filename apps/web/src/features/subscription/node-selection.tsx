"use client";

import { useState } from "react";
import { Badge, Banner, Button, Checkbox } from "@cloudflare/kumo";
import { Protocol, type SubscriptionGroupBinding, type SubscriptionNode } from "@bifurcation/rpc/panel/me";

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
  const [activeKey, setActiveKey] = useState<number>();
  const [selections, setSelections] = useState<Record<number, { signature: string; machineIds: string[] }>>({});
  const [notice, setNotice] = useState("");
  const available = nodes.filter((node) => node.available);
  const active = groups.find((group) => group.bindings[0].key === activeKey) ?? groups[0];
  const key = active?.bindings[0].key;
  const signature = JSON.stringify(active?.bindings);
  const savedSelection = key === undefined ? undefined : selections[key];
  const selected = (savedSelection && savedSelection.signature === signature
    ? savedSelection.machineIds
    : available.filter((node) => active?.bindings.some((binding) => matches(binding, node))).map((node) => node.machineId))
    .filter((id) => available.some((node) => node.machineId === id));

  function select(machineIds: string[]) {
    if (key === undefined) return;
    setSelections((current) => ({ ...current, [key]: { signature, machineIds } }));
    setNotice("");
  }

  return <div className="stack">
    <p className="subtle">为每种用途选择节点，然后生成预览并发布。已有筛选会保留，只有应用新的节点选择才会修改本订阅草稿。</p>
    {!available.length && <Banner variant="alert">暂无已就绪的节点。请联系管理员完成节点配置；现在可以保存草稿，节点就绪后再预览发布。</Banner>}
    {!groups.length && <p className="subtle">此配置没有节点组绑定。可在“节点组与属性”中添加。</p>}
    {active && <div className="subscription-node-layout">
      <nav className="subscription-node-index" aria-label="订阅用途">
        <h2>用途</h2>
        {groups.map((group) => {
          const unmatched = group.bindings.some((binding) => !nodes.some((node) => matches(binding, node)));
          const matched = available.filter((node) => group.bindings.some((binding) => matches(binding, node)));
          return <Button key={group.bindings[0].key} className="subscription-node-use" variant={active === group ? "secondary" : "ghost"}
            aria-label={`选择${group.name}节点`} aria-pressed={active === group} aria-controls="subscription-node-detail"
            onClick={() => { setActiveKey(group.bindings[0].key); setNotice(""); }}>
            <span className="subscription-node-use-label"><span>{group.name}</span><span className="subtle font-normal">{matched.length} 台节点</span></span>
            {unmatched && <Badge variant="destructive">需要选择</Badge>}
          </Button>;
        })}
      </nav>
      <section id="subscription-node-detail" aria-label={`选择${active.name}节点`} className="subscription-node-detail stack">
        <div className="panel-header"><h2>{active.name}</h2><Badge variant="secondary">已选择 {selected.length} 台</Badge></div>
        <p className="subtle">应用后，这{active.bindings.length === 2 ? "两个关联组" : "个组"}将仅使用所选节点，并替换原有地区、标签、协议和排除条件。后来新增的节点不会自动加入。</p>
        <div><Button disabled={disabled || !available.length} onClick={() => select(available.map((node) => node.machineId))}>选择全部已就绪节点</Button></div>
        <div className="subscription-node-options">{nodes.map((node) => <div key={node.machineId} className="subscription-node-option">
          <Checkbox disabled={!node.available || disabled} checked={selected.includes(node.machineId)} label={`${node.name} · ${node.region || "未设置地区"}${node.available ? "" : " · 未就绪"}`} onCheckedChange={(checked) => select(checked ? [...selected, node.machineId] : selected.filter((id) => id !== node.machineId))} />
          {node.tags.length > 0 && <p className="subtle mt-1 pl-7">{node.tags.join(" · ")}</p>}
        </div>)}</div>
        <p className="subtle">已选择 {selected.length} 台节点。至少选择一台才能应用。</p>
        <div className="actions">
          <Button disabled={disabled} onClick={() => select(available.filter((node) => active.bindings.some((binding) => matches(binding, node))).map((node) => node.machineId))}>取消选择</Button>
          <Button disabled={disabled || !selected.length} onClick={() => {
            if (!selected.length) return;
            onApply(active.bindings.map((binding) => binding.key), selected);
            setNotice(`已将节点选择应用到${active.name}的订阅草稿。请保存并生成预览。`);
          }}>应用到本订阅草稿</Button>
        </div>
        {notice && <p role="status" className="subtle">{notice}</p>}
        <div className="subscription-node-current stack">
          <h3>草稿中的节点</h3>
          <p className="subtle break-words">修改范围：{active.bindings.map((binding) => binding.groupTag).join("、")}。固定成员引用保持不变；最终结果由预览检查。</p>
          {active.bindings.map((binding, index) => {
            const matched = nodes.filter((node) => matches(binding, node));
            return <div key={binding.key}>
              <p className="subtle break-words">{active.bindings.length > 1 ? (index === 0 ? "手动选择" : "自动测速") : binding.groupTag} · {filterSummary(binding)}</p>
              <p className="mt-1 break-words">{matched.length ? matched.map((node) => node.name).join("、") : "没有符合当前条件的节点，请选择节点或调整高级筛选。"}</p>
            </div>;
          })}
        </div>
      </section>
    </div>}
  </div>;
}
