# Bifurcation Web

Bifurcation 的 Next.js 控制面与 Cloudflare Kumo 界面。面板使用 SQLite 持久化，通过 Connect RPC 管理主动接入的 Go daemon；sing-box 内嵌在 daemon 中，版本随 daemon 更新。

部署、首次管理员初始化及备份恢复见[运维指南](../../docs/OPERATIONS.md)。环境变量、工具链和完整开发流程见[开发指南](../../docs/DEVELOPMENT.md)。面板以 Docker Compose 自部署。

## 模块边界

| 目录             | 职责                                                                      |
| ---------------- | ------------------------------------------------------------------------- |
| `src/app`        | App Router 页面、布局、HTTP 与 Connect 入口；服务端布局执行登录及角色检查 |
| `src/features`   | 身份、用户、机器、配置、订阅、用量界面及交互                              |
| `src/components` | 共用导航、弹窗、JSON 和敏感值展示组件                                     |
| `src/contracts`  | 页面与接口共享的数据类型                                                  |
| `src/server`     | 认证、业务用例、数据库、配置生成和节点通信；仅在服务端导入                |
| `drizzle`        | SQLite 版本化迁移                                                         |
| `scripts`        | 数据库迁移与管理员命令                                                    |
| `tests`          | 服务端与协议回归                                                          |
| `e2e`            | 使用临时数据库和独立服务的浏览器回归                                      |

前端使用 Kumo 组件及语义样式。Next.js 根据 `src/app/icon.svg` 自动提供项目图标。节点命令、配置预览和升级结果使用实际 API 数据，操作是否完成以节点回报为准。

## 开发命令

在仓库根目录完成依赖安装与环境配置后运行：

```sh
pnpm --filter @bifurcation/web dev
pnpm --filter @bifurcation/web lint
pnpm --filter @bifurcation/web typecheck
pnpm --filter @bifurcation/web test
pnpm --filter @bifurcation/web build
```

构建会同时生成生产环境使用的管理员命令。迁移和原生依赖的准备步骤见开发指南。

## 浏览器回归

```sh
pnpm --filter @bifurcation/web build
pnpm --filter @bifurcation/web exec playwright install chromium
pnpm --filter @bifurcation/web test:e2e
```

测试覆盖账号、节点、配置、订阅、用量、daemon 升级与卸载流程。测试服务使用独立随机凭据和临时数据库，不复用开发数据库。节点协议测试与真实 Go 引擎、systemd 测试的边界见 [E2E 说明](e2e/README.md)。
