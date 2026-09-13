"use client";

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
        <p role="status" className="notice mb-6">
          {notice}
        </p>
      )}
      {subscription ? (
        <>
          {subscription.blocked && (
            <p role="alert" className="notice mb-6">
              {subscription.blockReason === BlockReason.QUOTA
                ? "已达到本月额度，代理接入暂停。"
                : "账号已禁用，代理接入暂停。"}{" "}
              当前配置不包含可用代理节点。
            </p>
          )}
          <section className="panel">
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
          </section>
          <section className="panel">
            <div className="panel-header">
              <h2>客户端配置格式</h2>
              <span>sing-box {subscription.configFormatVersion}</span>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>节点</th>
                    <th>协议</th>
                    <th>地址</th>
                    <th>配置状态</th>
                    <th>接入状态</th>
                  </tr>
                </thead>
                <tbody>
                  {subscription.nodes.map((node) => (
                    <tr key={node.machineId}>
                      <td>{node.name}</td>
                      <td>
                        {node.protocols
                          .map((protocol) =>
                            protocol === Protocol.TROJAN ? "Trojan" : "Hysteria2",
                          )
                          .join(" + ")}
                      </td>
                      <td>{node.address}</td>
                      <td>
                        <Badge variant="secondary">
                          {node.configurationState === ConfigurationState.APPLIED
                            ? "已应用"
                            : "等待应用"}
                        </Badge>
                      </td>
                      <td>{node.available ? "可接入" : "未就绪"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!subscription.nodes.length && (
                <p className="empty-state">暂无可用节点</p>
              )}
              {subscription.nodes.length > 0 &&
                subscription.nodes.every((node) => !node.available) && (
                  <p className="notice mt-4">
                    节点尚未就绪，当前订阅不包含可用代理。
                  </p>
                )}
            </div>
          </section>
          <section className="panel">
            <div className="panel-header">
              <h2>代理凭据</h2>
              <span className="subtle text-xs">
                版本 {subscription.credentialGeneration}
              </span>
            </div>
            {subscription.nodes.some(
              (node) => node.configurationState === ConfigurationState.PENDING,
            ) && (
              <p className="notice mb-4">
                部分节点正在等待应用配置，旧配置可能仍在运行。
              </p>
            )}
            <Button
              variant="secondary-destructive"
              onClick={() => open("credentials")}
            >
              重置代理凭据
            </Button>
          </section>
        </>
      ) : (
        <section className="panel">
          <p
            className="empty-state"
            role={resource.loading ? "status" : undefined}
          >
            {resource.loading ? "正在加载订阅…" : "订阅暂时无法加载，请重试。"}
          </p>
        </section>
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
              <div className="actions">
                <Button variant="destructive" loading={busy} onClick={reset}>
                  {action === "subscription" ? "重置订阅链接" : "重置代理凭据"}
                </Button>
                <Button disabled={busy} onClick={() => setAction(null)}>
                  取消
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
