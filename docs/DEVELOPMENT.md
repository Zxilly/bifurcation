# 开发指南

## 工具与工作区

使用 Node.js 24、pnpm 12.4.1、Go 1.27。JavaScript 依赖以根 pnpm-lock.yaml 为准，Go 依赖与生成器由 services/daemon/go.mod 和 go.sum 固定。不要通过强制 peer override 掩盖版本不兼容。

```sh
pnpm install --frozen-lockfile
```

没有匹配的全局 pnpm 时，可用 `npx --yes pnpm@12.4.1` 替代命令前缀。

在 `apps/web/.env.local` 设置 `BIFURCATION_PUBLIC_URL=http://localhost:3000` 与独立开发密钥。默认数据库为 `apps/web/data/bifurcation.sqlite`。CLI 不自动加载 Next 的环境文件，运行初始化命令时需向环境提供同样的变量。

```sh
pnpm --filter @bifurcation/web admin:init admin
pnpm dev
```

开发数据库、凭据和临时产物不提交。不要让开发服务使用生产数据库。节点运行方式见 [daemon README](../services/daemon/README.md)。

## 检查

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
go -C services/daemon test -tags=with_quic ./...
go -C services/daemon vet -tags=with_quic ./...
```

Playwright 浏览器安装与用例说明见 [E2E](../apps/web/e2e/README.md)。Go race 检查用于状态并发、核心生命周期和计量变更；运行环境须支持 race 工具链。

```sh
go -C services/daemon test -race -tags=with_quic ./internal/adapters/singbox ./internal/state ./internal/panelclient
```

## 生成代码和数据库

```sh
pnpm generate:rpc
go -C services/daemon generate ./internal/state
pnpm --filter @bifurcation/web db:generate
```

Protobuf 定义位于 proto，生成的 Go/TypeScript 随源代码维护。Ent schema 位于 internal/state/ent/schema，生成客户端同样入库。修改定义与生成产物应在同一变更交付，重新生成不能产生意外差异。

数据库当前使用初始 schema。新增持久字段需同步模型、经过审阅的 SQL 和行为测试；已部署的迁移不能原位改写。二进制回滚不应覆盖数据库快照，发布涉及 schema 时必须明确其兼容性。

## 测试层次

| 层次 | 覆盖 |
| --- | --- |
| Web 单元/集成 | 真实 SQLite、身份签名、权限、配置、计量和 Connect 边界 |
| 浏览器 | 真实页面/API、虚拟认证器、移动布局、任务状态 |
| Go | 真实数据事务、连接跟踪、协议流量和关闭结算 |
| Docker | standalone、原生依赖、初始化 CLI、重建和备份恢复 |
| systemd | 实际服务切换、启动失败、确认丢失与卸载保留 |

[部署测试](../deploy/tests/README.md) 使用独立容器和数据卷。普通 Go 测试会跳过需要明确隔离标记的系统服务用例；交叉编译不能代替目标运行测试。

## 变更要求

按实际执行边界补回归，保留能防止行为退化的测试。不要为实现细节添加镜像式测试，也不把测试替身当作生产验收。

保持前端/服务端边界、任务幂等、授权下限及 cursor/outbox 原子性。下载、哈希和核心启停不占用长期数据库事务。诊断输出应有界，凭据不能进入 URL、构建产物或测试快照。

CI 覆盖 Web、Go 多平台、代码生成、Docker 和隔离 systemd 测试。提交前检查完整改动、锁文件和生成产物，提交消息遵循最近一致的仓库风格。
