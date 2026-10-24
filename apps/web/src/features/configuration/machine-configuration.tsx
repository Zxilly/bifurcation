"use client";

import { LayerCard, Banner, Collapsible, Select, LinkButton } from "@cloudflare/kumo";
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
  type MachineConfigurationInput,
  type PublishConfigurationResponse,
} from "@bifurcation/rpc/panel/configuration";
import Link from "next/link";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { FormError } from "@/components/modal";
import { ResourceFeedback } from "@/components/resource-feedback";
import { JsonDocument } from "@/components/json-document";
import { CodeDocument } from "@/components/code-document";
import { JsonEditor } from "@/components/json-editor";
import { UnsavedChanges } from "@/components/unsaved-changes";
import { Reauthenticate } from "@/features/identity/reauth";
import { ApiError, errorMessage } from "@/features/shared/api";
import { panel } from "@/features/shared/rpc";
import { resourceKeys } from "@/features/shared/keys";
import { useResource } from "@/features/shared/use-resource";
import { useServerRefresh } from "@/features/shared/use-refresh";
import { PublicationProgress } from "./publication-progress";

const states: Record<number, string> = {
  [Reconciliation.NOT_CONFIGURED]: "未配置",
  [Reconciliation.PENDING]: "等待应用",
  [Reconciliation.APPLIED]: "已应用",
  [Reconciliation.FAILED]: "应用失败",
};

export function MachineConfiguration({ machine }: { machine: MachineDetail }) {
  const resource = useResource(
    resourceKeys.machineConfiguration(machine.id),
    () =>
      panel.configuration
        .getMachineConfiguration({ machineId: machine.id })
        .then((r) => r.configuration!),
    { refreshInterval: 5_000 },
  );
  const configuration = resource.data;
  return (
    <LayerCard render={<section />} className="machine-configuration">
      <div className="machine-section-heading">
        <h2>节点配置</h2>
        {configuration && (
          <Badge
            variant={
              configuration.reconciliation === Reconciliation.FAILED
                ? "destructive"
                : configuration.reconciliation === Reconciliation.APPLIED
                  ? "success"
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
      {configuration ? (
        <>
          <dl className="machine-facts">
            <div>
              <dt>配置版本</dt>
              <dd>
                {configuration.version
                  ? `版本 ${configuration.version}`
                  : "尚未发布"}
              </dd>
            </div>
            <div>
              <dt>授权状态</dt>
              <dd>
                {configuration.desiredPolicyRevision
                  ? configuration.desiredPolicyRevision ===
                    configuration.appliedPolicyRevision
                    ? "已同步"
                    : "等待同步"
                  : "尚未发布"}
              </dd>
            </div>
            <div>
              <dt>Trojan 端口</dt>
              <dd>{configuration.settings?.trojanPort ?? "未配置"}</dd>
            </div>
            <div>
              <dt>Hysteria2 端口</dt>
              <dd>{configuration.settings?.hysteria2Port ?? "未配置"}</dd>
            </div>
            <div>
              <dt>TLS 域名</dt>
              <dd>{configuration.settings?.tls?.serverName || "未配置"}</dd>
            </div>
          </dl>
          {configuration.latestTask?.message && (
            <p className="subtle mt-3">{configuration.latestTask.message}</p>
          )}
          <Link
            href={`/admin/machines/${machine.id}/configuration`}
            className="machine-section-link"
          >
            查看与编辑配置
          </Link>
        </>
      ) : (
        resource.loading && (
          <p role="status" className="subtle">
            正在加载配置…
          </p>
        )
      )}
    </LayerCard>
  );
}

function ConfigurationSteps({ current }: { current: number }) {
  return (
    <ol className="configuration-steps" aria-label="配置发布流程">
      {["编辑配置", "生成预览", "确认发布"].map((label, index) => (
        <li key={label} aria-current={current === index ? "step" : undefined} data-complete={index < current || undefined}>
          <span className="configuration-step-number" aria-hidden>{index + 1}</span>
          <span>{label}</span>
        </li>
      ))}
    </ol>
  );
}

// The page provides the current machine and configuration; the editor keeps
// its own draft and version until publishing succeeds.
export function MachineConfigurationPage({
  machine,
  configuration,
}: {
  machine: MachineDetail;
  configuration: MachineConfiguration;
}) {
  const id = machine.id;
  const { refresh } = useServerRefresh();
  const [published, setPublished] = useState<PublishConfigurationResponse | null>(null);
  const [draft, setDraft] = useState<MachineConfiguration | null>(null);
  return (
    <div className="configuration-workspace">
      <Link href={`/admin/machines/${id}`} className="machine-back-link">
        <ArrowLeftIcon size={16} aria-hidden />
        返回机器详情
      </Link>
      <div className="page-heading">
        <div>
          <h1>发布节点配置</h1>
          <p className="page-description">
            {machine.name} ·
            编辑配置后生成预览，确认最终内容再发布。
          </p>
        </div>
      </div>
      <div className="configuration-content">
        {published ? (
          <>
            <ConfigurationSteps current={2} />
            <PublicationProgress machineId={id} publication={published} onEdit={(latest) => {
              if (latest) setDraft(latest);
              setPublished(null);
            }} />
          </>
        ) : (
          machine.uninstalled ? (
            <p className="subtle">机器已卸载，请先重新接入。</p>
          ) : (
            <ConfigurationEditor
              key={id}
              machine={machine}
              initial={draft ?? configuration}
              onPublished={async (publication, settings) => {
                setDraft({ ...configuration, settings, version: publication.version });
                setPublished(publication);
                refresh();
              }}
            />
          )
        )}
      </div>
    </div>
  );
}

function ConfigurationEditor({
  machine: initialMachine,
  initial,
  onPublished,
}: {
  machine: MachineDetail;
  initial: MachineConfiguration;
  onPublished: (publication: PublishConfigurationResponse, settings: MachineConfigurationInput) => Promise<void>;
}) {
  const machineResource = useResource(
    resourceKeys.machine(initialMachine.id),
    () => panel.machines.getMachine({ machineId: initialMachine.id }).then((r) => r.machine!),
    { refreshInterval: 5_000 },
  );
  const machine = machineResource.data ?? initialMachine;
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
  const [advancedOpen, setAdvancedOpen] = useState(Object.keys(existing?.baseJson ?? {}).length > 0);
  const customBase = baseJson.trim() !== "{}";
  const editorValues = JSON.stringify([
    listen, trojanPort, hysteria2Port, mode, serverName, acmeEmail,
    certificatePath, privateKeyPath, certificatePem, privateKeyPem, baseJson,
  ]);
  const [savedValues, setSavedValues] = useState(editorValues);
  const dirty = editorValues !== savedValues;
  const [preview, setPreview] = useState<ConfigurationPreview | null>(null);
  const [expiredPreviewId, setExpiredPreviewId] = useState("");
  const previewExpired = !!preview && expiredPreviewId === preview.previewId;
  const previewHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!preview) return;
    previewHeading.current?.focus();
    const timer = window.setTimeout(
      () => setExpiredPreviewId(preview.previewId),
      Math.max(0, Number(preview.expiresAt) - Date.now()),
    );
    return () => window.clearTimeout(timer);
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
      setAdvancedOpen(true);
      throw new Error("基础配置不是有效 JSON，请修正后重新预览。");
    }
    if (!base || typeof base !== "object" || Array.isArray(base)) {
      setAdvancedOpen(true);
      throw new Error("基础配置必须是 JSON 对象。");
    }
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
  async function createPreview(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault();
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
        setExpiredPreviewId(preview.previewId);
        return;
      }
      const publication = await panel.configuration.publishConfiguration({
        machineId: machine.id,
        previewId: preview.previewId,
        expectedVersion: preview.expectedVersion,
        requestKey: publishRequestKey,
      });
      setSavedValues(editorValues);
      await onPublished(publication, settings());
    } catch (e) {
      await handleError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <UnsavedChanges dirty={dirty} />
      <ConfigurationSteps current={preview ? 1 : 0} />
      <ResourceFeedback {...machineResource} onRetry={machineResource.refresh} />
      {!machine.installationId ? (
        <Banner variant="secondary" role="status">
          <div>
            <p className="font-medium">先接入机器，再发布配置</p>
            <p className="mt-2">可以先填写并预览配置。发布需要在 Linux 机器上执行安装命令，等待节点接入。</p>
            <LinkButton className="mt-3" variant="secondary" href={`/admin/machines/${machine.id}?tab=maintenance`}>查看安装命令</LinkButton>
          </div>
        </Banner>
      ) : !supported ? (
        <Banner variant="alert" role="status">
          <div>
            <p className="font-medium">此节点需要先升级 daemon</p>
            <p className="mt-2">当前 daemon 不支持配置发布。可以先准备配置，升级后再发布。</p>
            <LinkButton className="mt-3" variant="secondary" href={`/admin/machines/${machine.id}?tab=maintenance`}>查看接入与维护</LinkButton>
          </div>
        </Banner>
      ) : null}
      <LayerCard render={<section />} className="configuration-card">
        <div className="stack">
          <p className="subtle">
            {machine.name} · 当前版本 {version}{dirty ? " · 有未发布修改" : ""}
          </p>
          <form onSubmit={createPreview} onChange={() => setPreview(null)}>
            <fieldset disabled={busy} className="configuration-fields">
              <section className="configuration-form-section" aria-labelledby="configuration-listen-heading">
                <h2 id="configuration-listen-heading">监听</h2>
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
              </section>
              <section className="configuration-form-section" aria-labelledby="configuration-tls-heading">
                <h2 id="configuration-tls-heading">TLS 证书</h2>
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
                  onValueChange={(value) => {
                    setMode(value as "path" | "pem" | "acme");
                    setPreview(null);
                  }}
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
                      className="font-mono text-sm"
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
                      className="font-mono text-sm"
                      required
                    />
                  </>
                )}
              </section>
              <Collapsible.Root className="configuration-advanced" open={advancedOpen} onOpenChange={setAdvancedOpen}>
                <Collapsible.DefaultTrigger className="py-2 text-left">高级基础配置（可选）<span className="subtle mt-1 block font-normal sm:ml-2 sm:mt-0 sm:inline">{customBase ? "含自定义配置" : "使用默认日志与直连出站"}</span></Collapsible.DefaultTrigger>
                <Collapsible.DefaultPanel>
                <div className="stack">
                  <p className="subtle">
                    这是运行在节点上的 sing-box
                    服务端补充配置，用于设置日志、DNS、路由和出站。没有额外需求时保留{" "}
                    <code>{"{}"}</code> 即可。
                  </p>
                  <ul className="list-disc pl-5 space-y-2 text-kumo-subtle">
                    <li>
                      默认提供 <code>log</code>（info 级别、带时间戳）和{" "}
                      <code>outbounds</code>（direct
                      直连出站）。填写同名顶层字段会整项替换默认值，不会逐项合并。
                    </li>
                    <li>
                      监听地址、端口、TLS 和用户凭据由平台生成。基础 JSON 不能包含{" "}
                      <code>inbounds</code> 或 <code>services</code>，也不支持{" "}
                      <code>experimental.clash_api</code>、
                      <code>experimental.v2ray_api</code>。
                    </li>
                  </ul>
                  <Collapsible.Root>
                    <Collapsible.DefaultTrigger>
                      示例：调整日志级别
                    </Collapsible.DefaultTrigger>
                    <Collapsible.DefaultPanel>
                    <CodeDocument label="调整日志级别示例 JSON" code={'{\n  "log": {\n    "level": "warn",\n    "timestamp": true\n  }\n}'} />
                    <p className="subtle">
                      此示例仅替换日志设置，保留默认直连出站。其他允许的顶层字段原样保留，最终是否可运行由节点检查。
                    </p>
                    </Collapsible.DefaultPanel>
                  </Collapsible.Root>
                  {advancedOpen && <JsonEditor
                    label="基础配置 JSON"
                    value={baseJson}
                    onChange={(value) => {
                      setBaseJson(value);
                      setPreview(null);
                    }}
                    rows={12}
                    disabled={busy}
                    description="请输入 JSON 对象。生成预览不会应用配置；修改后需要重新预览。"
                  />}
                </div>
                </Collapsible.DefaultPanel>
              </Collapsible.Root>
              <div className="configuration-form-actions">
                {!preview && <LinkButton variant="secondary" disabled={busy} href={`/admin/machines/${machine.id}`}>取消</LinkButton>}
                <Button type="submit" variant={preview ? "secondary" : "primary"} loading={busy}>
                  生成预览
                </Button>
              </div>
            </fieldset>
          </form>
          <FormError message={error} />
          {preview && (
            <div className="configuration-preview">
              <div className="panel-header mb-0">
                <h2 ref={previewHeading} tabIndex={-1}>
                  最终 sing-box JSON
                </h2>
                <Badge variant="secondary">策略 {preview.policyRevision}</Badge>
              </div>
              {previewExpired ? (
                <Banner role="status" variant="alert">
                  预览已过期。编辑内容已保留，请重新生成预览后再发布。
                </Banner>
              ) : (
                <p className="subtle">
                  有效至 {new Intl.DateTimeFormat("zh-CN", {
                    hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Asia/Shanghai",
                  }).format(Number(preview.expiresAt))}（上海时间）。修改配置后需重新生成预览。
                </p>
              )}
              <JsonDocument
                key={preview.previewId}
                value={preview.finalJson}
                filename={`sing-box-${machine.id}.json`}
              />
              <p className="subtle break-all text-xs">
                SHA-256 · {preview.digest}
              </p>
              <Banner
                variant="alert"
                title="发布可能短暂中断连接"
                description="机器会先检查候选配置，失败时恢复上一可用配置。"
              />
              {!machine.installationId && (
                <p className="subtle">机器接入后才能发布配置。</p>
              )}
              {machine.installationId && !supported && (
                <p className="subtle">
                  当前 daemon 不支持此配置任务，请先升级 daemon。
                </p>
              )}
              <div className="configuration-form-actions">
                <Link
                  href={`/admin/machines/${machine.id}`}
                  className="subtle underline"
                >
                  返回机器详情
                </Link>
                {previewExpired ? (
                  <Button variant="primary" loading={busy} onClick={() => void createPreview()}>
                    重新生成预览
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    loading={busy}
                    disabled={!machine.installationId || !supported || machine.uninstalled || !!machineResource.error}
                    onClick={publish}
                  >
                    检查并发布
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </LayerCard>
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
