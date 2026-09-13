import { build } from "esbuild";

await build({
  entryPoints: { admin: "scripts/admin.ts", backup: "scripts/backup.ts" },
  outdir: "scripts",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  packages: "external",
  plugins: [{
    name: "server-only-cli",
    setup(build) {
      build.onResolve({ filter: /^server-only$/ }, () => ({ path: "server-only", namespace: "empty-marker" }));
      build.onLoad({ filter: /.*/, namespace: "empty-marker" }, () => ({ contents: "export {};", loader: "js" }));
    },
  }],
});
