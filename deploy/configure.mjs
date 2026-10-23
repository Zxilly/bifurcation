import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";

function publicOrigin(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error("请通过 --url 指定完整公开地址，例如 https://panel.example.com"); }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("公开地址必须是站点 origin，不能包含路径、查询参数、片段或登录凭据");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("公开地址必须使用 HTTPS；仅 localhost 和 127.0.0.1 支持 HTTP 本地试用");
  }
  return url.origin;
}

function listenPort(value) {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error("监听端口必须是 1 到 65535 之间的整数");
  }
  return String(Number(value));
}

try {
  const { values } = parseArgs({ options: {
    url: { type: "string" }, port: { type: "string" },
    output: { type: "string", default: ".env" }, check: { type: "boolean" }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.log("新建配置：node deploy/configure.mjs --url https://panel.example.com [--port 3000] [--output .env]");
    console.log("检查配置：node deploy/configure.mjs --check [--output .env]");
  } else {
    const path = resolve(values.output);
    let origin, port;
    if (values.check) {
      if (values.url || values.port) throw new Error("--check 读取已有文件，不能同时指定 --url 或 --port");
      const env = parseEnv(readFileSync(path, "utf8"));
      origin = publicOrigin(env.BIFURCATION_PUBLIC_URL);
      port = listenPort(env.BIFURCATION_PORT ?? "3000");
      if (!/^[a-fA-F0-9]{64}$/.test(env.BIFURCATION_APP_KEY ?? "")) {
        throw new Error("BIFURCATION_APP_KEY 必须是固定的 64 位十六进制密钥；已有数据库请使用原密钥");
      }
      console.log(`配置格式有效：${path}`);
    } else {
      origin = publicOrigin(values.url);
      port = listenPort(values.port ?? "3000");
      let file;
      try { file = openSync(path, "wx", 0o600); }
      catch (error) {
        if (error.code === "EEXIST") throw new Error("配置文件已存在，未覆盖文件或更换应用密钥。使用 --check 检查；更新部署时保留原密钥。");
        throw error;
      }
      try {
        writeFileSync(file, `# Keep this file with the database backups. Do not regenerate the application key.\nBIFURCATION_PUBLIC_URL=${origin}\nBIFURCATION_APP_KEY=${randomBytes(32).toString("hex")}\nBIFURCATION_PORT=${port}\n`);
        fsyncSync(file);
      } finally { closeSync(file); }
      if (process.platform === "linux") {
        const directory = openSync(dirname(path), "r");
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
      console.log(`配置已写入 ${path}；请将该文件另行安全备份。`);
    }
    console.log(`公开地址：${origin}\n宿主机监听：127.0.0.1:${port}\n应用密钥已配置，未输出密钥内容。`);
    if (values.check) console.log("本检查只验证配置文件格式；HTTPS、数据库密钥匹配和容器健康仍需启动后确认。");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
