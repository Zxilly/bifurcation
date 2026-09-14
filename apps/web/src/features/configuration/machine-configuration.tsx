"use client";

import { LayerCard, Banner, Select } from "@cloudflare/kumo";
import { useEffect, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Input, InputArea } from "@cloudflare/kumo/components/input";
import type { JsonObject } from "@bufbuild/protobuf";
import { create } from "@bufbuild/protobuf";
import { TaskKind } from "@bifurcation/rpc";
import type { MachineDetail } from "@bifurcation/rpc/panel/machines";
import {
  MachineConfigurationInputSchema,
  Reconciliation,
  type ConfigurationPreview,
  type MachineConfiguration,
} from "@bifurcation/rpc/panel/configuration";
import { Modal, FormError } from "@/components/modal";
import { JsonDocument } from "@/components/json-document";
import { Reauthenticate } from "@/features/identity/reauth";
import { ApiError, errorMessage } from "@/features/shared/api";
import { panel } from "@/features/shared/rpc";
import { useResource } from "@/features/shared/use-resource";

const states: Record<number, string> = {
  [Reconciliation.NOT_CONFIGURED]: "未配置",
  [Reconciliation.PENDING]: "等待应用",
  [Reconciliation.APPLIED]: "已应用",
  [Reconciliation.FAILED]: "应用失败",
};

export function MachineConfiguration({
  machine,
  onPublished,
}: {
  machine: MachineDetail;
  onPublished: () => Promise<void>;
}) {
  const resource = useResource(
    `machine-config:${machine.id}`,
    () =>
      panel.configuration
        .getMachineConfiguration({ machineId: machine.id })
        .then((r) => r.configuration!),
    { refreshInterval: 5_000 },
  );
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const configuration = resource.data;
  return (
    <LayerCard render={<section />} className="panel">
      <div className="panel-header">
        <h2>节点配置</h2>
        {configuration && (
          <Badge
            variant={
              configuration.reconciliation === Reconciliation.FAILED
                ? "destructive"
                : "secondary"
            }
          >
            {states[configuration.reconciliation]}
          </Badge>
        )}
      </div>
      <FormError message={resource.error} />
      {resource.error && (
        <Button onClick={resource.refresh}>重新加载配置</Button>
      )}
      {notice && (
        <Banner role="status" variant="secondary" className="mb-5">
          {notice}
        </Banner>
      )}
      {configuration ? (
        <>
          <dl className="grid gap-5 sm:grid-cols-3 mb-5">
            <div>
              <dt className="subtle mb-2">daemon 内嵌核心</dt>
              <dd>
                {configuration.bundledCoreVersion
                  ? `sing-box ${configuration.bundledCoreVersion}`
                  : "未上报"}
              </dd>
            </div>
            <div>
              <dt className="subtle mb-2">配置版本</dt>
              <dd>
                {configuration.version
                  ? `版本 ${configuration.version}`
                  : "尚未发布"}
              </dd>
            </div>
            <div>
              <dt className="subtle mb-2">授权状态</dt>
              <dd>
                {configuration.desiredPolicyRevision
                  ? configuration.desiredPolicyRevision ===
                    configuration.appliedPolicyRevision
                    ? "已同步"
                    : "等待同步"
                  : "尚未发布"}
              </dd>
            </div>
          </dl>
          {configuration.latestTask?.message && (
            <p className="subtle mb-5">{configuration.latestTask.message}</p>
          )}
          <Button
            variant="primary"
            onClick={() => {
              setNotice("");
              setOpen(true);
            }}
          >
            发布配置
          </Button>
        </>
      ) : (
        resource.loading && (
          <p role="status" className="subtle">
            正在加载配置…
          </p>
        )
      )}
      {open && configuration && (
        <ConfigurationEditor
          machine={machine}
          initial={configuration}
          onClose={() => setOpen(false)}
          onPublished={async () => {
            setOpen(false);
            setNotice("配置已发布，等待机器完成检查和应用。");
            await Promise.all([resource.refresh(), onPublished()]);
          }}
        />
      )}
    </LayerCard>
  );
}

function ConfigurationEditor({
  machine,
  initial,
  onClose,
  onPublished,
}: {
  machine: MachineDetail;
  initial: MachineConfiguration;
  onClose: () => void;
  onPublished: () => Promise<void>;
}) {
  const existing = initial.settings;
  const existingMode = existing?.tls?.mode;
  const [listen, setListen] = useState(existing?.listen ?? "::");
  const [trojanPort, setTrojanPort] = useState(
    String(existing?.trojanPort ?? 443),
  );
  const [hysteria2Port, setHysteria2Port] = useState(
    String(existing?.hysteria2Port ?? 8443),
  );
  const [mode, setMode] = useState<"path" | "pem" | "acme">(
    existingMode?.case ?? "path",
  );
  const [serverName, setServerName] = useState(existing?.tls?.serverName ?? "");
  const [acmeEmail, setAcmeEmail] = useState(
    existingMode?.case === "acme" ? existingMode.value.email : "",
  );
  const [certificatePath, setCertificatePath] = useState(
    existingMode?.case === "path"
      ? existingMode.value.certificatePath
      : "/etc/bifurcation/tls/fullchain.pem",
  );
  const [privateKeyPath, setPrivateKeyPath] = useState(
    existingMode?.case === "path"
      ? existingMode.value.privateKeyPath
      : "/etc/bifurcation/tls/privkey.pem",
  );
  const [certificatePem, setCertificatePem] = useState(
    existingMode?.case === "pem" ? existingMode.value.certificatePem : "",
  );
  const [privateKeyPem, setPrivateKeyPem] = useState(
    existingMode?.case === "pem" ? existingMode.value.privateKeyPem : "",
  );
  const [baseJson, setBaseJson] = useState(
    JSON.stringify(existing?.baseJson ?? {}, null, 2),
  );
  const [preview, setPreview] = useState<ConfigurationPreview | null>(null);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (preview) previewHeading.current?.focus();
  }, [preview]);
  const [publishRequestKey, setPublishRequestKey] = useState("");
  const [version, setVersion] = useState(initial.version);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reauth, setReauth] = useState(false);
  const supported = machine.capabilities.includes(TaskKind.APPLY_CONFIG);

  async function loadPem(
    file: File | undefined,
    update: (content: string) => void,
  ) {
    setPreview(null);
    setError("");
    if (!file) return;
    if (file.size > 64 * 1024) {
      setError("证书或私钥文件不能超过 64 KiB。");
      return;
    }
    setBusy(true);
    try {
      update(await file.text());
    } catch {
      setError("无法读取文件，请重新选择。");
    } finally {
      setBusy(false);
    }
  }
  function settings() {
    let base: unknown;
    try {
      base = JSON.parse(baseJson);
    } catch {
      throw new Error("基础配置不是有效 JSON，请修正后重新预览。");
    }
    if (!base || typeof base !== "object" || Array.isArray(base))
      throw new Error("基础配置必须是 JSON 对象。");
    const ports = [Number(trojanPort), Number(hysteria2Port)];
    if (
      ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)
    )
      throw new Error("监听端口必须是 1–65535 的整数。");
    return create(MachineConfigurationInputSchema, {
      listen,
      trojanPort: ports[0],
      hysteria2Port: ports[1],
      tls: {
        serverName,
        mode:
          mode === "path"
            ? { case: "path", value: { certificatePath, privateKeyPath } }
            : mode === "acme"
              ? { case: "acme", value: { email: acmeEmail } }
              : { case: "pem", value: { certificatePem, privateKeyPem } },
      },
      baseJson: base as JsonObject,
    });
  }
  async function createPreview(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setPreview(null);
    try {
      const result = await panel.configuration.previewConfiguration({
        machineId: machine.id,
        expectedVersion: version,
        settings: settings(),
      });
      setPublishRequestKey(crypto.randomUUID());
      setPreview(result.preview!);
    } catch (e) {
      await handleError(e);
    } finally {
      setBusy(false);
    }
  }
  async function handleError(e: unknown) {
    if (e instanceof ApiError && e.code === "REAUTH_REQUIRED") {
      setReauth(true);
      return;
    }
    if (
      e instanceof ApiError &&
      [
        "VERSION_CONFLICT",
        "STALE_POLICY",
        "PREVIEW_EXPIRED",
        "PREVIEW_USED",
      ].includes(e.code)
    ) {
      setPreview(null);
      try {
        const current = await panel.configuration.getMachineConfiguration({
          machineId: machine.id,
        });
        setVersion(current.configuration!.version);
      } catch {
        /* Preserve the user's draft if refreshing also fails. */
      }
      setError(`${errorMessage(e)}。编辑内容已保留，请重新生成预览。`);
    } else setError(errorMessage(e));
  }
  async function publish() {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      if (preview.expiresAt <= Date.now()) {
        setPreview(null);
        throw new Error("预览已过期，请重新生成。");
      }
      await panel.configuration.publishConfiguration({
        machineId: machine.id,
        previewId: preview.previewId,
        expectedVersion: preview.expectedVersion,
        requestKey: publishRequestKey,
      });
      await onPublished();
    } catch (e) {
      await handleError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Modal
        title="发布节点配置"
        size="xl"
        open
        onClose={() => {
          if (!busy) onClose();
        }}
      >
        <div className="stack">
          <p className="subtle">
            {machine.name} · 当前版本 {version}
          </p>
          <form onSubmit={createPreview} onChange={() => setPreview(null)}>
            <fieldset disabled={busy} className="stack">
              <Input
                label="监听地址"
                value={listen}
                onChange={(event) => setListen(event.target.value)}
                placeholder="::"
                required
                description=":: 监听所有 IPv6 接口；也可填写具体 IPv4 或 IPv6 地址。"
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <Input
                  label="Trojan 监听端口"
                  type="number"
                  min={1}
                  max={65535}
                  value={trojanPort}
                  onChange={(event) => setTrojanPort(event.target.value)}
                  required
                />
                <Input
                  label="Hysteria2 监听端口（UDP）"
                  type="number"
                  min={1}
                  max={65535}
                  value={hysteria2Port}
                  onChange={(event) => setHysteria2Port(event.target.value)}
                  required
                />
              </div>
              <Input
                label="TLS 服务器名称"
                value={serverName}
                onChange={(event) => setServerName(event.target.value)}
                placeholder="证书对应的域名"
                required
              />
              <Select
                label="证书来源"
                items={{
                  path: "机器上的文件路径",
                  pem: "上传证书与私钥",
                  acme: "ACME 自动签发",
                }}
                value={mode}
                onValueChange={(value) =>
                  setMode(value as "path" | "pem" | "acme")
                }
              />
              {mode === "acme" && (
                <Input
                  label="ACME 联系邮箱"
                  type="email"
                  value={acmeEmail}
                  onChange={(event) => setAcmeEmail(event.target.value)}
                  required
                  description="节点向 Let's Encrypt 申请并自动续期证书，需放行 80 端口的 HTTP 质询。"
                />
              )}
              {mode === "path" && (
                <>
                  <Input
                    label="TLS 证书路径"
                    value={certificatePath}
                    onChange={(event) => setCertificatePath(event.target.value)}
                    required
                  />
                  <Input
                    label="TLS 私钥路径"
                    value={privateKeyPath}
                    onChange={(event) => setPrivateKeyPath(event.target.value)}
                    required
                  />
                </>
              )}
              {mode === "pem" && (
                <>
                  <Input
                    label="证书文件（PEM）"
                    type="file"
                    accept=".pem,.crt,.cer"
                    onChange={(event) =>
                      void loadPem(event.target.files?.[0], setCertificatePem)
                    }
                  />
                  <InputArea
                    label="证书 PEM"
                    value={certificatePem}
                    onChange={(event) => setCertificatePem(event.target.value)}
                    rows={4}
                    spellCheck={false}
                    className="font-mono text-xs"
                    required
                  />
                  <Input
                    label="私钥文件（PEM）"
                    type="file"
                    accept=".pem,.key"
                    onChange={(event) =>
                      void loadPem(event.target.files?.[0], setPrivateKeyPem)
                    }
                  />
                  <InputArea
                    label="私钥 PEM"
                    value={privateKeyPem}
                    onChange={(event) => setPrivateKeyPem(event.target.value)}
                    rows={4}
                    spellCheck={false}
                    className="font-mono text-xs"
                    required
                  />
                </>
              )}
              <InputArea
                label="基础配置 JSON"
                value={baseJson}
                onChange={(event) => setBaseJson(event.target.value)}
                rows={8}
                spellCheck={false}
                className="font-mono text-xs"
                description="监听与用户列表由上方设置生成；其他 JSON 选项会保留。"
              />
              <div className="mt-8 flex flex-wrap justify-end gap-2">
                <Button type="submit" loading={busy}>
                  生成预览
                </Button>
              </div>
            </fieldset>
          </form>
          <FormError message={error} />
          {preview && (
            <>
              <div className="panel-header mb-0">
                <h2 ref={previewHeading} tabIndex={-1}>
                  最终 sing-box JSON
                </h2>
                <Badge variant="secondary">策略 {preview.policyRevision}</Badge>
              </div>
              <JsonDocument
                key={preview.previewId}
                value={preview.finalJson}
                filename={`sing-box-${machine.id}.json`}
              />
              <p className="subtle break-all text-xs">
                SHA-256 · {preview.digest}
              </p>
              <Banner variant="alert">
                <p className="font-medium">发布可能短暂中断连接</p>
                <p className="mt-1">
                  机器会先检查候选配置，失败时恢复上一可用配置。
                </p>
              </Banner>
              {!machine.installationId && (
                <p className="subtle">机器接入后才能发布配置。</p>
              )}
              {machine.installationId && !supported && (
                <p className="subtle">
                  当前 daemon 不支持此配置任务，请先升级 daemon。
                </p>
              )}
              <div className="mt-8 flex flex-wrap justify-end gap-2">
                <Button disabled={busy} onClick={onClose}>
                  取消
                </Button>
                <Button
                  variant="primary"
                  loading={busy}
                  disabled={!machine.installationId || !supported}
                  onClick={publish}
                >
                  检查并发布
                </Button>
              </div>
            </>
          )}
        </div>
      </Modal>
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
