import "server-only";
import { createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import type { AuthorizationLayer, MachineConfigurationInput, TlsSettings } from "@/contracts/configuration";
import { AppError } from "@/server/http/errors";

export const CONFIG_FORMAT_VERSION = "1.14.0";
const MANAGED_TAGS = { trojan: "bifurcation-trojan", hysteria2: "bifurcation-hysteria2" } as const;
const serverName = z.string().trim().min(1).max(253).regex(/^[a-zA-Z0-9.:-]+$/, "填写证书对应的域名或 IP");
const pemTls = z.object({ mode: z.literal("pem"), serverName, certificatePem: z.string().min(1).max(128 * 1024), privateKeyPem: z.string().min(1).max(32 * 1024) });
const absolutePath = z.string().min(2).max(1024).regex(/^\/(?!.*(?:\x00|\r|\n))/, "需要节点上的绝对文件路径");
const pathTls = z.object({ mode: z.literal("path"), serverName, certificatePath: absolutePath, privateKeyPath: absolutePath });
const acmeTls = z.object({ mode: z.literal("acme"), serverName: serverName.refine((value) => isIP(value) === 0 && !value.includes(":"), "ACME 签发需要公网域名，不能是 IP 地址"), email: z.string().trim().min(3).max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "填写有效的 ACME 联系邮箱") });
const port = z.number().int().min(1).max(65535);
const configurationInput = z.object({ listen: z.string().refine((value) => isIP(value) !== 0, "监听地址必须是 IPv4 或 IPv6 地址").default("::"), trojanPort: port, hysteria2Port: port, tls: z.discriminatedUnion("mode", [pemTls, pathTls, acmeTls]), baseJson: z.record(z.string(), z.unknown()).default({}) });

export function validateSettings(input: unknown): MachineConfigurationInput {
  const settings = configurationInput.parse(input);
  const extra = settings.baseJson;
  const experimental = extra.experimental;
  const conflicts = ["inbounds", "services"].filter((field) => Object.hasOwn(extra, field));
  if (experimental !== undefined && (typeof experimental !== "object" || experimental === null || Array.isArray(experimental))) throw new AppError("INVALID_BASE_CONFIG", "experimental 必须是对象", 422);
  if (experimental && ["v2ray_api", "clash_api"].some((field) => Object.hasOwn(experimental, field))) throw new AppError("UNSUPPORTED_CONTROL_API", "内嵌核心不提供本机控制 API", 422);
  if (conflicts.length) throw new AppError("MANAGED_FIELD_CONFLICT", `这些字段由平台管理，不能在基础 JSON 中覆盖：${conflicts.join("、")}`, 422);
  if (JSON.stringify(settings).length > 3 * 1024 * 1024) throw new AppError("CONFIG_TOO_LARGE", "配置超过大小限制", 413);
  if (settings.tls.mode === "pem") validateCertificate(settings.tls);
  return settings;
}
function validateCertificate(tls: Extract<TlsSettings, { mode: "pem" }>) {
  try {
    const certificate = new X509Certificate(tls.certificatePem);
    const certificatePublicKey = certificate.publicKey.export({ type: "spki", format: "der" });
    const privatePublicKey = createPublicKey(createPrivateKey(tls.privateKeyPem)).export({ type: "spki", format: "der" });
    if (!certificatePublicKey.equals(privatePublicKey)) throw new Error("证书与私钥不匹配");
    if (Date.parse(certificate.validTo) <= Date.now()) throw new Error("证书已过期");
    if (Date.parse(certificate.validFrom) > Date.now()) throw new Error("证书尚未生效");
    const matches = isIP(tls.serverName) ? certificate.checkIP(tls.serverName) : certificate.checkHost(tls.serverName);
    if (!matches) throw new Error("证书与服务器名称不匹配");
  } catch (error) {
    throw new AppError("INVALID_CERTIFICATE", error instanceof Error ? `证书校验失败：${error.message}` : "证书校验失败", 422);
  }
}
function inboundTls(tls: TlsSettings) {
  if (tls.mode === "acme") return { enabled: true, server_name: tls.serverName, min_version: "1.3", certificate_provider: { type: "acme", domain: [tls.serverName], email: tls.email } };
  return { enabled: true, server_name: tls.serverName, min_version: "1.3", ...(tls.mode === "pem" ? { certificate: tls.certificatePem.trim().split(/\r?\n/), key: tls.privateKeyPem.trim().split(/\r?\n/) } : { certificate_path: tls.certificatePath, key_path: tls.privateKeyPath }) };
}
function outboundTls(tls: TlsSettings) {
  return { enabled: true, server_name: tls.serverName, ...(tls.mode === "pem" ? { certificate: tls.certificatePem.trim().split(/\r?\n/) } : {}) };
}
export function renderServer(settings: MachineConfigurationInput, authorization: AuthorizationLayer): Record<string, unknown> {
  const extra = structuredClone(settings.baseJson);
  return {
    log: { level: "info", timestamp: true },
    outbounds: [{ type: "direct", tag: "direct" }],
    ...extra,
    inbounds: [
      { type: "trojan", tag: MANAGED_TAGS.trojan, listen: settings.listen ?? "::", listen_port: settings.trojanPort, users: authorization.users.map((user) => ({ name: user.id, password: user.trojanPassword })), tls: inboundTls(settings.tls) },
      { type: "hysteria2", tag: MANAGED_TAGS.hysteria2, listen: settings.listen ?? "::", listen_port: settings.hysteria2Port, users: authorization.users.map((user) => ({ name: user.id, password: user.hysteria2Password })), tls: inboundTls(settings.tls) },
    ],
  };
}
type ClientNode = { id: string; name: string; address: string; settings: MachineConfigurationInput };
export function renderClient(nodes: ClientNode[], credentials: { trojanPassword: string; hysteria2Password: string }, blocked: boolean): Record<string, unknown> {
  const outbounds = blocked ? [] : nodes.flatMap((node) => [
    { type: "trojan", tag: `${node.name} / Trojan / ${node.id.slice(0, 8)}`, server: node.address, server_port: node.settings.trojanPort, password: credentials.trojanPassword, tls: outboundTls(node.settings.tls) },
    { type: "hysteria2", tag: `${node.name} / Hysteria2 / ${node.id.slice(0, 8)}`, server: node.address, server_port: node.settings.hysteria2Port, password: credentials.hysteria2Password, tls: outboundTls(node.settings.tls) },
  ]);
  return {
    log: { level: "info" },
    dns: { servers: [{ type: "local", tag: "dns-local" }] },
    inbounds: [{ type: "mixed", tag: "mixed-in", listen: "127.0.0.1", listen_port: 2080 }],
    outbounds: [...(outbounds.length ? [
      { type: "selector", tag: "proxy", outbounds: ["auto", ...outbounds.map((outbound) => outbound.tag)], default: "auto" },
      { type: "urltest", tag: "auto", outbounds: outbounds.map((outbound) => outbound.tag), url: "https://www.gstatic.com/generate_204", interval: "3m", tolerance: 50 },
    ] : []), ...outbounds, { type: "direct", tag: "direct" }],
    route: { default_domain_resolver: "dns-local", ...(outbounds.length ? { final: "proxy" } : { rules: [{ action: "reject" }], final: "direct" }) },
  };
}
export function jsonBytes(value: unknown) { return Buffer.from(JSON.stringify(value, null, 2) + "\n"); }
