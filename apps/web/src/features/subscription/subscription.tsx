"use client";

import {
  Badge,
  Banner,
  Button,
  DropdownMenu,
  Input,
  LayerCard,
  LinkButton,
  Select,
  Table,
} from "@cloudflare/kumo";
import { DotsThreeIcon } from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type {
  ListSubscriptionProfilesResponse,
  SubscriptionProfile,
} from "@bifurcation/rpc/panel/me";
import { Modal, FormError } from "@/components/modal";
import { JsonDocument } from "@/components/json-document";
import { InlineEmpty } from "@/components/inline-empty";
import { errorMessage } from "@/features/shared/api";
import { panel } from "@/features/shared/rpc";
import { useServerRefresh } from "@/features/shared/use-refresh";

type Action = {
  kind: "rotate" | "delete" | "pause" | "resume" | "config" | "link";
  profile: SubscriptionProfile;
};

const actionTitles = {
  rotate: "重置订阅链接",
  delete: "删除订阅",
  pause: "暂停订阅",
  resume: "恢复订阅",
  config: "查看配置",
  link: "订阅链接",
};
const subscriptionLimit = 20;

function profileState(profile: SubscriptionProfile) {
  if (!profile.enabled) return "已暂停";
  if (!profile.publishedVersion) return "草稿";
  if (profile.generationError) return "生成失败";
  return profile.nodeCount ? "可下载" : "等待节点";
}

function downloadUnavailable(profile: SubscriptionProfile) {
  if (!profile.enabled) return "订阅已暂停，当前不能通过链接下载配置。恢复订阅后仍可使用原地址。";
  if (!profile.publishedVersion) return "订阅尚未发布，当前不能通过链接下载配置。请先编辑、预览并发布。";
  if (profile.generationError) return "配置生成失败，当前不能通过链接下载配置。请检查配置和可用节点。";
  if (!profile.nodeCount) return "当前没有已就绪的节点，请联系管理员后再更新客户端订阅。";
  return "";
}

// The page provides profiles and node context; mutations re-render it.
export function Subscription({
  profiles,
  context,
}: Pick<ListSubscriptionProfilesResponse, "profiles" | "context">) {
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
  const atLimit = profiles.length >= subscriptionLimit;
  const destructiveAction = action && ["rotate", "delete", "pause"].includes(action.kind);

  function startCreate(source?: SubscriptionProfile) {
    if (atLimit) return;
    requestKey.current = crypto.randomUUID();
    setCopyFrom(source?.id);
    setName(source ? `${source.name} 副本` : "");
    setPreset("desktop");
    setError("");
    setCreating(true);
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await panel.me.createSubscriptionProfile({
        name,
        preset,
        copyFromId: copyFrom,
        requestKey: requestKey.current,
      });
      router.push(`/subscription/${encodeURIComponent(result.profile!.id)}`);
      setCreating(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function copyLink(profile: SubscriptionProfile) {
    await navigator.clipboard.writeText(profile.url);
    const unavailable = downloadUnavailable(profile);
    setNotice(`已复制「${profile.name}」的订阅链接。${unavailable || "请在支持 sing-box 配置的客户端中添加远程订阅，粘贴此链接并更新。"}`);
  }

  async function inspect(profile: SubscriptionProfile, kind: Action["kind"]) {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const detail = (await panel.me.getSubscriptionProfile({ id: profile.id })).profile!;
      if (kind === "link" && !downloadUnavailable(detail)) {
        try {
          await copyLink(detail);
          return;
        } catch {
          setNotice("无法访问剪贴板，请选择完整链接手动复制。");
        }
      }
      setAction({ profile: detail, kind });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function copyDisplayedLink() {
    if (!action) return;
    setError("");
    setBusy(true);
    try {
      await copyLink(action.profile);
      setAction(null);
    } catch {
      setError("无法访问剪贴板，请选择完整链接手动复制。");
    } finally {
      setBusy(false);
    }
  }

  async function mutate() {
    setBusy(true);
    setError("");
    try {
      if (credentials) {
        await panel.me.resetProxyCredentials({});
        setCredentials(false);
        setNotice("代理凭据已重置，等待机器应用新配置。请重新获取订阅。");
      } else if (action) {
        await panel.me.updateSubscriptionProfile({
          id: action.profile.id,
          expectedVersion: action.profile.version,
          action: action.kind,
        });
        const result = { pause: "暂停", resume: "恢复", delete: "删除" };
        setNotice(action.kind === "rotate"
          ? "订阅链接已重置，请更新客户端的订阅地址。"
          : `「${action.profile.name}」已${result[action.kind as keyof typeof result]}。`);
        setAction(null);
      }
      refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>接入与订阅</h1>
          <p className="subtle mt-2">为手机、PC 或其他用途分别创建订阅，共享节点，独立管理分流规则。</p>
        </div>
        <div className="actions">
          <Button loading={pending} onClick={refresh}>刷新状态</Button>
          <Button
            variant="primary"
            disabled={atLimit || busy}
            aria-describedby={atLimit ? "subscription-limit" : undefined}
            onClick={() => startCreate()}
          >
            创建订阅
          </Button>
        </div>
      </div>
      {!action && !creating && !credentials && <FormError message={error} />}
      {notice && <Banner role="status" variant="secondary" className="mb-5">{notice}</Banner>}
      {context?.blocked && (
        <Banner variant="error" className="mb-5">账号已禁用或已达到本月额度，代理接入暂停。</Banner>
      )}
      <p id="subscription-limit" className="subtle mb-3">
        {atLimit
          ? "已达到 20 条订阅上限。删除不再使用的订阅后，可继续创建或复制。"
          : `已创建 ${profiles.length} / ${subscriptionLimit} 条订阅`}
      </p>
      <LayerCard className="min-w-0 overflow-x-auto p-0">
        {profiles.length ? (
          <Table layout="fixed">
            <Table.Header>
              <Table.Row>
                <Table.Head>订阅</Table.Head>
                <Table.Head className="hidden w-28 sm:table-cell">状态</Table.Head>
                <Table.Head className="hidden w-24 text-right sm:table-cell">可用节点</Table.Head>
                <Table.Head className="w-42 lg:w-72">操作</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {profiles.map((profile) => {
                const state = profileState(profile);
                const href = `/subscription/${encodeURIComponent(profile.id)}`;
                return (
                  <Table.Row key={profile.id}>
                    <Table.Cell className="break-words">
                      <Link href={href} className="font-medium underline">{profile.name}</Link>
                      <p className="subtle mt-1">
                        {profile.preset === "legacy" ? "原有配置" : profile.preset === "mobile" ? "手机" : "PC"}
                        {" · "}
                        {profile.publishedVersion ? `已发布 v${profile.publishedVersion}` : "未发布"}
                      </p>
                      <p className="mt-2 sm:hidden">{state} · {profile.nodeCount} 台可用节点</p>
                    </Table.Cell>
                    <Table.Cell className="hidden sm:table-cell">
                      <Badge variant={state === "生成失败" ? "destructive" : "secondary"}>{state}</Badge>
                    </Table.Cell>
                    <Table.Cell className="hidden text-right tabular-nums sm:table-cell">{profile.nodeCount}</Table.Cell>
                    <Table.Cell>
                      <div className="flex flex-wrap items-center gap-2">
                        {state === "可下载" ? (
                          <Button disabled={busy} onClick={() => void inspect(profile, "link")}>复制链接</Button>
                        ) : state === "已暂停" ? (
                          <Button disabled={busy} onClick={() => void inspect(profile, "resume")}>恢复订阅</Button>
                        ) : (
                          <LinkButton variant="secondary" href={href}>
                            {state === "草稿" ? "编辑并发布" : state === "等待节点" ? "查看节点" : "修复配置"}
                          </LinkButton>
                        )}
                        {state === "可下载" && (
                          <LinkButton variant="secondary" href={href} className="hidden lg:inline-flex">编辑配置</LinkButton>
                        )}
                        <DropdownMenu>
                          <DropdownMenu.Trigger render={
                            <Button
                              variant="ghost"
                              shape="square"
                              disabled={busy}
                              aria-label={`${profile.name} 的更多操作`}
                              icon={<DotsThreeIcon size={20} aria-hidden />}
                            />
                          } />
                          <DropdownMenu.Content>
                            <DropdownMenu.Item onClick={() => router.push(href)}>编辑配置</DropdownMenu.Item>
                            {state !== "可下载" && (
                              <DropdownMenu.Item onClick={() => void inspect(profile, "link")}>复制链接</DropdownMenu.Item>
                            )}
                            <DropdownMenu.Item onClick={() => void inspect(profile, "config")}>查看与下载配置</DropdownMenu.Item>
                            <DropdownMenu.Item disabled={atLimit} onClick={() => startCreate(profile)}>复制为新订阅</DropdownMenu.Item>
                            <DropdownMenu.Separator />
                            <DropdownMenu.Item onClick={() => void inspect(profile, "rotate")}>重置订阅链接</DropdownMenu.Item>
                            <DropdownMenu.Item onClick={() => void inspect(profile, profile.enabled ? "pause" : "resume")}>
                              {profile.enabled ? "暂停订阅" : "恢复订阅"}
                            </DropdownMenu.Item>
                            <DropdownMenu.Item variant="danger" onClick={() => void inspect(profile, "delete")}>删除订阅</DropdownMenu.Item>
                          </DropdownMenu.Content>
                        </DropdownMenu>
                      </div>
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        ) : (
          <InlineEmpty title="还没有订阅" description="创建订阅并发布配置后，即可将链接导入客户端。" />
        )}
      </LayerCard>
      <section className="panel-section stack mt-8" aria-labelledby="subscription-nodes">
        <h2 id="subscription-nodes">可用节点</h2>
        {context?.nodes.length ? (
          <>
            <p className="subtle">所有订阅共享这些节点，可在各自的配置中按地区、标签筛选。</p>
            <LayerCard className="min-w-0 overflow-x-auto p-0">
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.Head>节点</Table.Head>
                    <Table.Head>地区 / 标签</Table.Head>
                    <Table.Head>接入状态</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {context.nodes.map((node) => (
                    <Table.Row key={node.machineId}>
                      <Table.Cell>{node.name}</Table.Cell>
                      <Table.Cell>
                        {node.region || "未设置地区"}
                        {node.tags.length > 0 && <p className="subtle">{node.tags.join(" · ")}</p>}
                      </Table.Cell>
                      <Table.Cell>{node.available ? "可接入" : "未就绪"}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </LayerCard>
          </>
        ) : (
          <p className="subtle">暂无可用节点。管理员发布节点配置后会显示在这里；现在仍可创建订阅、保存草稿。</p>
        )}
      </section>
      <section className="panel-section stack mt-8">
        <h2>代理凭据</h2>
        <p className="subtle">所有订阅共用同一套账号代理凭据。重置会影响全部订阅；单独重置或暂停某条订阅链接不会撤销已导入的代理连接。</p>
        <div>
          <Button variant="secondary-destructive" disabled={busy} onClick={() => { setError(""); setCredentials(true); }}>
            重置代理凭据
          </Button>
        </div>
      </section>
      <Modal title={copyFrom ? "复制为新订阅" : "创建订阅"} open={creating} onClose={() => { if (!busy) setCreating(false); }}>
        <form onSubmit={create} className="stack">
          <Input label="订阅名称" value={name} onChange={(e) => setName(e.target.value)} required maxLength={64} placeholder="例如：手机日常、PC 游戏" />
          {!copyFrom && <Select label="初始模板" value={preset} onValueChange={(value) => setPreset(String(value))} items={{ desktop: "PC", mobile: "手机" }} />}
          <p className="subtle">创建后选择各用途的节点，预览并发布，再将链接添加到客户端。可直接使用模板，无需修改 JSON。</p>
          <FormError message={error} />
          <div className="mt-8 flex justify-end gap-2">
            <Button type="button" onClick={() => setCreating(false)} disabled={busy}>取消</Button>
            <Button type="submit" variant="primary" loading={busy}>创建并编辑</Button>
          </div>
        </form>
      </Modal>
      <Modal
        title={action ? `${actionTitles[action.kind]} · ${action.profile.name}` : "订阅"}
        size={action?.kind === "config" ? "xl" : "lg"}
        role={destructiveAction ? "alertdialog" : "dialog"}
        open={!!action}
        onClose={() => { if (!busy) setAction(null); }}
      >
        {action?.kind === "config" ? (
          action.profile.generationError
            ? <FormError message={action.profile.generationError} />
            : <JsonDocument value={action.profile.configJson} />
        ) : action?.kind === "link" ? (
          <div className="stack">
            {downloadUnavailable(action.profile) && <Banner variant="secondary">{downloadUnavailable(action.profile)}</Banner>}
            <Input label="完整订阅链接" value={action.profile.url} readOnly onFocus={(event) => event.currentTarget.select()} />
            <FormError message={error} />
            <div className="mt-8 flex justify-end gap-2">
              <Button disabled={busy} onClick={() => setAction(null)}>关闭</Button>
              <Button variant="primary" loading={busy} onClick={copyDisplayedLink}>复制链接</Button>
            </div>
          </div>
        ) : action ? (
          <div className="stack">
            <p>
              {action.kind === "rotate"
                ? "旧链接将立即失效，请更新此订阅的客户端地址。"
                : action.kind === "delete"
                  ? "此链接将永久失效，删除后无法恢复。"
                  : action.kind === "pause"
                    ? "停止此链接的配置下载，恢复后仍可使用原地址。"
                    : action.profile.publishedVersion
                      ? "恢复此链接的配置下载；仍需有可生成的已发布配置。"
                      : "恢复此订阅。它尚未发布，请编辑、预览并发布后再通过链接下载配置。"}
              其他订阅保持不变，已导入的代理凭据不受影响。
            </p>
            <FormError message={error} />
            <div className="mt-8 flex justify-end gap-2">
              <Button disabled={busy} onClick={() => setAction(null)}>取消</Button>
              <Button variant={destructiveAction ? "destructive" : "primary"} loading={busy} onClick={mutate}>
                {actionTitles[action.kind]}
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
      <Modal title="重置代理凭据" role="alertdialog" open={credentials} onClose={() => { if (!busy) setCredentials(false); }}>
        <div className="stack">
          <p>所有订阅将使用新代理凭据。机器应用新配置后，旧凭据失效；请更新所有客户端。各条订阅链接保持有效。</p>
          <FormError message={error} />
          <div className="mt-8 flex justify-end gap-2">
            <Button disabled={busy} onClick={() => setCredentials(false)}>取消</Button>
            <Button variant="destructive" loading={busy} onClick={mutate}>重置代理凭据</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
