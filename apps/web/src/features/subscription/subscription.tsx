"use client";

import { Banner, LayerCard, Table, Empty } from "@cloudflare/kumo";
import { ResourceState } from "@/components/resource-state";
import { useState } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import {
  BlockReason,
  ConfigurationState,
  Protocol,
} from "@bifurcation/rpc/panel/me";
import { Modal, FormError } from "@/components/modal";
import { CopyValue } from "@/components/secret-result";
import { JsonDocument } from "@/components/json-document";
import { Reauthenticate } from "@/features/identity/reauth";
import { ApiError, errorMessage } from "@/features/shared/api";
import { panel } from "@/features/shared/rpc";
import { useResource } from "@/features/shared/use-resource";

export function Subscription() {
  const resource = useResource("me:subscription", () =>
    panel.me.getSubscription({}).then((r) => r.subscription!),
  );
  const [action, setAction] = useState<
    "config" | "subscription" | "credentials" | null
  >(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [reauth, setReauth] = useState(false);
  const subscription = resource.data;
  const open = (action: "config" | "subscription" | "credentials") => {
    setError("");
    setNotice("");
    setAction(action);
  };
  async function reset() {
    if (action !== "subscription" && action !== "credentials") return;
    setBusy(true);
    setError("");
    try {
      const result =
        action === "subscription"
          ? await panel.me.resetSubscriptionToken({})
          : await panel.me.resetProxyCredentials({});
      resource.update(result.subscription!);
      setNotice(
        action === "subscription"
          ? "订阅链接已重置，请更新客户端的订阅地址。"
          : "代理凭据已重置，等待机器应用新配置。请重新获取订阅。",
      );
      setAction(null);
    } catch (e) {
      if (e instanceof ApiError && e.code === "REAUTH_REQUIRED")
        setReauth(true);
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <h1>接入与订阅</h1>
        <Button onClick={resource.refresh}>刷新状态</Button>
      </div>
      <FormError message={resource.error} />
      {notice && (
        <Banner role="status" variant="secondary" className="mb-6">
          {notice}
        </Banner>
      )}
      {subscription ? (
        <>
          {subscription.blocked && (
            <Banner role="alert" variant="error" className="mb-6">
              {subscription.blockReason === BlockReason.QUOTA
                ? "已达到本月额度，代理接入暂停。"
                : "账号已禁用，代理接入暂停。"}{" "}
              当前配置不包含可用代理节点。
            </Banner>
          )}
          <LayerCard render={<section />} className="panel">
            <div className="panel-header">
              <h2>sing-box 订阅</h2>
              <Badge variant="secondary">长期有效</Badge>
            </div>
            <CopyValue
              key={subscription.generation}
              value={subscription.url}
              copyLabel="复制订阅链接"
            />
            <div className="actions mt-4">
              <Button onClick={() => open("config")}>查看与下载配置</Button>
              <Button variant="ghost" onClick={() => open("subscription")}>
                重置订阅链接
              </Button>
            </div>
          </LayerCard>
          <section className="panel-section stack">
            <div className="panel-header">
              <h2>客户端配置格式</h2>
              <span>sing-box {subscription.configFormatVersion}</span>
            </div>
            <LayerCard className="min-w-0 overflow-x-auto p-0">
              <Table className="min-w-max tabular-nums">
                <Table.Header>
                  <Table.Row>
                    <Table.Head>节点</Table.Head>
                    <Table.Head>协议</Table.Head>
                    <Table.Head>地址</Table.Head>
                    <Table.Head>配置状态</Table.Head>
                    <Table.Head>接入状态</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {subscription.nodes.map((node) => (
                    <Table.Row key={node.machineId}>
                      <Table.Cell>{node.name}</Table.Cell>
                      <Table.Cell>
                        {node.protocols
                          .map((protocol) =>
                            protocol === Protocol.TROJAN
                              ? "Trojan"
                              : "Hysteria2",
                          )
                          .join(" + ")}
                      </Table.Cell>
                      <Table.Cell>{node.address}</Table.Cell>
                      <Table.Cell>
                        <Badge variant="secondary">
                          {node.configurationState ===
                          ConfigurationState.APPLIED
                            ? "已应用"
                            : "等待应用"}
                        </Badge>
                      </Table.Cell>
                      <Table.Cell>
                        {node.available ? "可接入" : "未就绪"}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                  {!subscription.nodes.length && (
                    <Table.Row>
                      <Table.Cell colSpan={5}>
                        <Empty
                          className="rounded-none border-0 bg-transparent"
                          title="暂无可用节点"
                        />
                      </Table.Cell>
                    </Table.Row>
                  )}
                </Table.Body>
              </Table>
              {subscription.nodes.length > 0 &&
                subscription.nodes.every((node) => !node.available) && (
                  <Banner variant="secondary" className="mt-4">
                    节点尚未就绪，当前订阅不包含可用代理。
                  </Banner>
                )}
            </LayerCard>
          </section>
          <LayerCard render={<section />} className="panel">
            <div className="panel-header">
              <h2>代理凭据</h2>
              <span className="subtle text-xs">
                版本 {subscription.credentialGeneration}
              </span>
            </div>
            {subscription.nodes.some(
              (node) => node.configurationState === ConfigurationState.PENDING,
            ) && (
              <Banner variant="secondary" className="mb-4">
                部分节点正在等待应用配置，旧配置可能仍在运行。
              </Banner>
            )}
            <Button
              variant="secondary-destructive"
              onClick={() => open("credentials")}
            >
              重置代理凭据
            </Button>
          </LayerCard>
        </>
      ) : (
        <LayerCard render={<section />} className="panel">
          <ResourceState
            loading={resource.loading}
            title={
              resource.loading ? "正在加载订阅…" : "订阅暂时无法加载，请重试。"
            }
          />
        </LayerCard>
      )}
      {action && subscription && (
        <Modal
          title={
            {
              config: "sing-box 配置",
              subscription: "重置订阅链接",
              credentials: "重置代理凭据",
            }[action]
          }
          size={action === "config" ? "xl" : "lg"}
          open
          onClose={() => {
            if (!busy) setAction(null);
          }}
        >
          {action === "config" ? (
            <JsonDocument value={subscription.configJson} />
          ) : (
            <div className="stack">
              <p>
                {action === "subscription"
                  ? "旧订阅链接将立即失效。客户端需更新订阅地址，已导入的代理配置仍可继续使用。"
                  : "机器应用新配置后，旧代理凭据将失效。请重新获取订阅并更新客户端配置；订阅链接保持有效。"}
              </p>
              <FormError message={error} />
              <div className="mt-8 flex flex-wrap justify-end gap-2">
                <Button disabled={busy} onClick={() => setAction(null)}>
                  取消
                </Button>
                <Button variant="destructive" loading={busy} onClick={reset}>
                  {action === "subscription" ? "重置订阅链接" : "重置代理凭据"}
                </Button>
              </div>
            </div>
          )}
        </Modal>
      )}
      {reauth && (
        <Reauthenticate
          onClose={() => setReauth(false)}
          onComplete={() => {
            setReauth(false);
            setError("身份已验证，请再次提交。");
          }}
        />
      )}
    </>
  );
}
