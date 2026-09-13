import "server-only";
import { resolve } from "node:path";
import { z } from "zod";

const settings = z.object({
  BIFURCATION_PUBLIC_URL: z.url().default("http://localhost:3000"),
  BIFURCATION_DATABASE_PATH: z.string().default("./data/bifurcation.sqlite"),
  BIFURCATION_APP_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/, "必须提供 32 字节十六进制应用密钥"),
});

export function getEnvironment() {
  const env = settings.parse(process.env);
  const url = new URL(env.BIFURCATION_PUBLIC_URL);
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("BIFURCATION_PUBLIC_URL 必须是站点 origin");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("公开部署必须使用 HTTPS");
  }
  return { publicUrl: url.origin, rpId: url.hostname, secureCookies: url.protocol === "https:", databasePath: resolve(env.BIFURCATION_DATABASE_PATH), appKey: Buffer.from(env.BIFURCATION_APP_KEY, "hex") };
}
