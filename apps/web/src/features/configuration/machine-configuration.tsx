"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Input, InputArea } from "@cloudflare/kumo/components/input";
import type { MachineDetailDto } from "@/contracts/machines";
import type {
  ConfigurationPreviewDto,
  ConfigurationPublishDto,
  MachineConfigurationDto,
  MachineConfigurationInput,
} from "@/contracts/configuration";
import { Modal, FormError } from "@/components/modal";
import { JsonDocument } from "@/components/json-document";
import { Reauthenticate } from "@/features/identity/reauth";
import { api, ApiError, errorMessage } from "@/features/shared/api";
import { useResource } from "@/features/shared/use-resource";

const states = {
  not_configured: "未配置",
  pending: "等待应用",
  applied: "已应用",
  failed: "应用失败",
};

export function MachineConfiguration({
  machine,
  onPublished,
}: {
  machine: MachineDetailDto;
  onPublished: () => Promise<void>;
}) {
  const resource = useResource<MachineConfigurationDto>(
    `/api/v1/admin/machines/${encodeURIComponent(machine.id)}/config`,
  );
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const interval = setInterval(resource.refresh, 5000);
    return () => clearInterval(interval);
  }, [resource.refresh]);
  const configuration = resource.data;
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>节点配置</h2>
        {configuration && (
          <Badge
            variant={
              configuration.reconciliation === "failed"
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
        <p role="status" className="notice mb-5">
          {notice}
        </p>
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
    </section>
  );
}

function ConfigurationEditor({
  machine,
  initial,
  onClose,
  onPublished,
}: {
  machine: MachineDetailDto;
  initial: MachineConfigurationDto;
  onClose: () => void;
  onPublished: (result: ConfigurationPublishDto) => Promise<void>;
}) {
  const existing = initial.settings;
  const [listen, setListen] = useState(existing?.listen ?? "::");
  const [trojanPort, setTrojanPort] = useState(
    String(existing?.trojanPort ?? 443),
  );
  const [hysteria2Port, setHysteria2Port] = useState(
    String(existing?.hysteria2Port ?? 8443),
  );
  const [mode, setMode] = useState<"path" | "pem">(
    existing?.tls.mode ?? "path",
  );
  const [serverName, setServerName] = useState(existing?.tls.serverName ?? "");
  const [certificatePath, setCertificatePath] = useState(
    existing?.tls.mode === "path"
      ? existing.tls.certificatePath
      : "/etc/bifurcation/tls/fullchain.pem",
  );
  const [privateKeyPath, setPrivateKeyPath] = useState(
    existing?.tls.mode === "path"
      ? existing.tls.privateKeyPath
      : "/etc/bifurcation/tls/privkey.pem",
  );
  const [certificatePem, setCertificatePem] = useState(
    existing?.tls.mode === "pem" ? existing.tls.certificatePem : "",
  );
  const [privateKeyPem, setPrivateKeyPem] = useState(
    existing?.tls.mode === "pem" ? existing.tls.privateKeyPem : "",
  );
  const [baseJson, setBaseJson] = useState(
    JSON.stringify(existing?.baseJson ?? {}, null, 2),
  );
  const [preview, setPreview] = useState<ConfigurationPreviewDto | null>(null);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (preview) previewHeading.current?.focus();
  }, [preview]);
  const [publishRequestKey, setPublishRequestKey] = useState("");
  const [version, setVersion] = useState(initial.version);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reauth, setReauth] = useState(false);
  const endpoint = `/api/v1/admin/machines/${encodeURIComponent(machine.id)}/config`;
  const supported = machine.capabilities.includes("apply_config");

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
  function settings(): MachineConfigurationInput {
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
    return {
      listen,
      trojanPort: ports[0],
      hysteria2Port: ports[1],
      tls:
        mode === "path"
          ? { mode, serverName, certificatePath, privateKeyPath }
          : { mode, serverName, certificatePem, privateKeyPem },
      baseJson: base as Record<string, unknown>,
    };
  }
  async function createPreview(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setPreview(null);
    try {
      const result = await api<ConfigurationPreviewDto>(`${endpoint}/preview`, {
        method: "POST",
        body: { expectedVersion: version, settings: settings() },
      });
      setPublishRequestKey(crypto.randomUUID());
      setPreview(result);
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
        const current = await api<MachineConfigurationDto>(endpoint);
        setVersion(current.version);
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
      const result = await api<ConfigurationPublishDto>(`${endpoint}/publish`, {
        method: "POST",
        body: {
          previewId: preview.previewId,
          expectedVersion: preview.expectedVersion,
          requestKey: publishRequestKey,
        },
      });
      await onPublished(result);
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
              <label className="stack gap-2">
                证书来源
                <select
                  className="field-select"
                  value={mode}
                  onChange={(event) =>
                    setMode(event.target.value as "path" | "pem")
                  }
                >
                  <option value="path">机器上的文件路径</option>
                  <option value="pem">上传证书与私钥</option>
                </select>
              </label>
              {mode === "path" ? (
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
              ) : (
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
              <div className="actions">
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
              <div className="notice">
                <p className="font-medium">发布可能短暂中断连接</p>
                <p className="mt-1">
                  机器会先检查候选配置，失败时恢复上一可用配置。
                </p>
              </div>
              {!machine.installationId && (
                <p className="subtle">机器接入后才能发布配置。</p>
              )}
              {machine.installationId && !supported && (
                <p className="subtle">
                  当前 daemon 不支持此配置任务，请先升级 daemon。
                </p>
              )}
              <div className="actions">
                <Button
                  variant="primary"
                  loading={busy}
                  disabled={!machine.installationId || !supported}
                  onClick={publish}
                >
                  检查并发布
                </Button>
                <Button disabled={busy} onClick={onClose}>
                  取消
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
