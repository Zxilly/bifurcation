import "server-only";
import { z } from "zod";
import { AppError } from "@/server/http/errors";
import { jsonBytes, renderClient } from "@/server/adapters/sing-box";
import type { subscriptionSnapshot } from "./snapshot";
import defaultTemplate from "./default.template.json";

const strings = z.array(z.string().min(1).max(160)).max(100);
export const bindingSchema = z.object({
  groupTag: z.string().min(1).max(100),
  regions: strings.default([]),
  tags: strings.default([]),
  protocols: z.array(z.enum(["trojan", "hysteria2"])).max(2).default([]),
  machineIds: strings.default([]),
  excludeMachineIds: strings.default([]),
  staticMembers: strings.default([]),
});
export const draftSchema = z.object({
  templateJson: z.string().max(1024 * 1024),
  bindings: z.array(bindingSchema).max(64),
});
export type SubscriptionDraft = z.infer<typeof draftSchema>;
type Snapshot = ReturnType<typeof subscriptionSnapshot>;
type Json = Record<string, unknown>;

function invalid(path: string, message: string): never {
  throw new AppError("INVALID_SUBSCRIPTION_CONFIG", `${path}: ${message}`, 422);
}
function object(value: unknown, path: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(path, "需要 JSON 对象");
  return value as Json;
}
function objects(value: unknown, path: string): Json[] {
  if (!Array.isArray(value)) invalid(path, "需要数组");
  return value.map((entry, index) => object(entry, `${path}/${index}`));
}

export function defaultDraft(preset: string): SubscriptionDraft {
  const template = structuredClone(defaultTemplate) as Json;
  if (preset === "mobile") {
    // The mobile client owns its TUN interface and control endpoint.
    template.inbounds = [{ type: "tun", tag: "tun-in", address: ["172.19.0.1/30"], auto_route: true, stack: "mixed" }];
  }
  return {
    templateJson: JSON.stringify(template, null, 2),
    bindings: ["select", "auto", "select-ai", "auto-ai", "select-game", "auto-game"].map((groupTag) => ({
      groupTag, regions: [], tags: groupTag.endsWith("-ai") ? ["ai"] : groupTag.endsWith("-game") ? ["game"] : [],
      protocols: [], machineIds: [], excludeMachineIds: [],
      staticMembers: groupTag === "select" ? ["auto", "direct"] : groupTag === "select-ai" ? ["auto-ai"] : groupTag === "select-game" ? ["auto-game"] : [],
    })),
  };
}

export function legacyDraft(snapshot: Snapshot): SubscriptionDraft {
  const template = renderClient([], snapshot.credentials.secrets, false);
  template.outbounds = [
    { type: "selector", tag: "proxy", default: "auto", outbounds: [] },
    { type: "urltest", tag: "auto", url: "https://www.gstatic.com/generate_204", interval: "3m", tolerance: 50, outbounds: [] },
    { type: "direct", tag: "direct" },
  ];
  template.route = { default_domain_resolver: "dns-local", final: "proxy" };
  return { templateJson: JSON.stringify(template, null, 2), bindings: ["proxy", "auto"].map((groupTag) => ({ groupTag, regions: [], tags: [], protocols: [], machineIds: [], excludeMachineIds: [], staticMembers: groupTag === "proxy" ? ["auto"] : [] })) };
}

// This validator checks the generated graph. It never starts a core, reads files,
// fetches rule sets or claims OS/client compatibility for user-authored settings.
export function renderSubscription(draftInput: SubscriptionDraft, snapshot: Snapshot) {
  const draft = draftSchema.parse(draftInput);
  if (snapshot.blocked) throw new AppError("SUBSCRIPTION_BLOCKED", "账号已禁用或已达到本月额度", 403);
  let parsed: unknown;
  try { parsed = JSON.parse(draft.templateJson); } catch { invalid("/", "不是有效 JSON"); }
  let size = 0;
  function bound(value: unknown, depth: number) {
    if (depth > 64 || ++size > 100_000) invalid("/", "配置嵌套或元素数量过多");
    if (value && typeof value === "object") for (const entry of Object.values(value)) bound(entry, depth + 1);
  }
  bound(parsed, 0);
  const result = object(parsed, "/");
  const outbounds = objects(result.outbounds, "/outbounds");
  const available = snapshot.nodes.filter((node) => node.available).sort((a, b) => a.id.localeCompare(b.id));
  if (!available.length) invalid("/outbounds", "暂无已应用配置且授权就绪的节点");
  const byTag = new Map<string, Json>();
  for (const [index, outbound] of outbounds.entries()) {
    if (typeof outbound.tag !== "string" || !outbound.tag) invalid(`/outbounds/${index}/tag`, "需要唯一 tag");
    if (outbound.tag.startsWith("bfc_")) invalid(`/outbounds/${index}/tag`, "bfc_ 前缀由平台保留");
    if (byTag.has(outbound.tag)) invalid(`/outbounds/${index}/tag`, "tag 重复");
    byTag.set(outbound.tag, outbound);
  }
  const generated = available.flatMap((node) => {
    const rendered = renderClient([node], snapshot.credentials.secrets, false);
    return (rendered.outbounds as Json[]).filter((outbound) => ["trojan", "hysteria2"].includes(String(outbound.type))).map((outbound) => ({
      node, protocol: String(outbound.type), outbound: { ...outbound, tag: `bfc_${node.id}_${outbound.type}` },
    }));
  });
  for (const { outbound } of generated) byTag.set(outbound.tag, outbound);
  const boundTags = new Set<string>();
  const selectedByGroup = new Map<string, Set<string>>();
  for (const binding of draft.bindings) {
    const path = `/bindings/${binding.groupTag}`;
    if (boundTags.has(binding.groupTag)) invalid(path, "组被重复绑定");
    boundTags.add(binding.groupTag);
    const group = byTag.get(binding.groupTag);
    if (!group || !["selector", "urltest"].includes(String(group.type))) invalid(path, "找不到对应的 selector/urltest");
    const members = generated.filter(({ node, protocol }) =>
      (!binding.regions.length || binding.regions.includes(node.region)) &&
      binding.tags.every((tag) => node.tags.includes(tag)) &&
      (!binding.protocols.length || binding.protocols.includes(protocol as "trojan" | "hysteria2")) &&
      (!binding.machineIds.length || binding.machineIds.includes(node.id)) &&
      !binding.excludeMachineIds.includes(node.id),
    ).map(({ outbound }) => outbound.tag);
    selectedByGroup.set(binding.groupTag, new Set(members));
    if (!members.length) invalid(path, "没有匹配节点；请调整地区/标签或由管理员设置节点属性");
    group.outbounds = [...new Set([...binding.staticMembers, ...members])];
  }
  result.outbounds = [...outbounds, ...generated.map(({ outbound }) => outbound)];
  const requireOutbound = (value: unknown, path: string) => {
    if (typeof value !== "string" || !byTag.has(value)) invalid(path, "引用的出口不存在");
  };
  for (const [tag, outbound] of byTag) {
    if (["selector", "urltest"].includes(String(outbound.type))) {
      if (!Array.isArray(outbound.outbounds) || !outbound.outbounds.length) invalid(`/outbounds/${tag}/outbounds`, "节点组不能为空");
      outbound.outbounds.forEach((value, index) => requireOutbound(value, `/outbounds/${tag}/outbounds/${index}`));
      if (outbound.default !== undefined && !outbound.outbounds.includes(outbound.default)) invalid(`/outbounds/${tag}/default`, "默认成员不在此组中");
    }
  }
  const walk = (value: unknown, path: string) => {
    if (Array.isArray(value)) { value.forEach((entry, index) => walk(entry, `${path}/${index}`)); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      if (["outbound", "detour", "download_detour", "external_ui_download_detour"].includes(key)) requireOutbound(entry, `${path}/${key}`);
      walk(entry, `${path}/${key}`);
    }
  };
  walk(result, "");
  const route = result.route === undefined ? {} : object(result.route, "/route");
  if (route.final !== undefined) requireOutbound(route.final, "/route/final");
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(tag: string) {
    if (visiting.has(tag)) invalid(`/outbounds/${tag}`, "出口引用形成循环");
    if (visited.has(tag)) return;
    visiting.add(tag);
    const entry = byTag.get(tag)!;
    const next = [...(Array.isArray(entry.outbounds) ? entry.outbounds : []), ...(typeof entry.detour === "string" ? [entry.detour] : [])];
    for (const target of next) visit(String(target));
    visiting.delete(tag); visited.add(tag);
  }
  for (const tag of byTag.keys()) visit(tag);
  const leaves = new Map<string, Set<string>>();
  function managedLeaves(tag: string): Set<string> {
    const cached = leaves.get(tag); if (cached) return cached;
    const entry = byTag.get(tag)!;
    const found = new Set<string>(tag.startsWith("bfc_") ? [tag] : []);
    for (const target of [...(Array.isArray(entry.outbounds) ? entry.outbounds : []), ...(typeof entry.detour === "string" ? [entry.detour] : [])]) {
      for (const leaf of managedLeaves(String(target))) found.add(leaf);
    }
    leaves.set(tag, found); return found;
  }
  for (const binding of draft.bindings) {
    const selected = selectedByGroup.get(binding.groupTag)!;
    if ([...managedLeaves(binding.groupTag)].some((tag) => !selected.has(tag))) invalid(`/bindings/${binding.groupTag}`, "固定成员间接包含筛选范围之外的节点，请同步自动组的筛选条件");
  }
  return { configJson: jsonBytes(result).toString("utf8"), nodeCount: available.length };
}
