# Bifurcation 文档

本文档用于项目自身的开发、部署和维护。

面向不超过 10 位用户的自托管代理管理平台。Next.js 提供管理界面与控制平面，Go daemon 内嵌 sing-box，支持 Trojan 和 Hysteria2。

- 管理员创建账号，用户通过 Passkey 或后备密码登录；无公开注册。
- 长期 API Key、机器 Token，以及独立的订阅链接和代理凭据管理。
- 配置预览与发布、用户流量统计、月度额度和节点资源状态。
- daemon 整体升级、失败回滚、本地卸载和面板备份恢复。

## 部署

需要 Docker Compose、公开 HTTPS 域名，以及运行 systemd 的 Linux 节点。面板保持单实例，节点支持 amd64 和 arm64。

1. 将 [.env.example](../.env.example) 复制为 `.env`，设置公开地址与应用密钥。
2. 构建并启动面板，初始化管理员：

```sh
docker compose up -d --build
docker compose exec panel node scripts/admin.mjs init admin
```

初始化命令输出一次性激活链接。完成 Passkey 与后备密码设置后，在管理界面创建机器，按详情中的安装命令接入节点，再发布代理配置。

应用密钥使用一次生成的 32 字节随机值，以 64 位十六进制表示。密钥与数据库必须一起保留，不能在重启时重新生成。面板默认仅监听宿主机回环地址，由 HTTPS 反向代理提供入口。

完整配置、反向代理、升级和故障处理见 [运维指南](OPERATIONS.md)。

## 开发

使用 Node.js 24、pnpm 12.4.1 和 Go 1.27。依赖及生成工具由锁文件固定。

```sh
pnpm install --frozen-lockfile
pnpm dev
```

开发前按 [开发指南](DEVELOPMENT.md) 设置环境变量并初始化独立的开发数据库。该指南也包含测试、代码生成和提交检查。

## 文档

| 文档 | 内容 |
| --- | --- |
| [产品说明](PRODUCT.md) | 角色、功能和运行边界 |
| [架构](ARCHITECTURE.md) | 模块职责、运行生命周期和一致性 |
| [数据与协议](DATA-AND-PROTOCOL.md) | 存储模型、HTTP 与 Connect 契约 |
| [开发指南](DEVELOPMENT.md) | 环境、生成、测试与代码维护 |
| [运维指南](OPERATIONS.md) | 部署、节点维护、诊断 |
| [备份与恢复](BACKUP-AND-RESTORE.md) | 一致快照、离线恢复和恢复边界 |
| [安全模型](SECURITY.md) | 凭据、授权和部署信任边界 |
| [贡献指南](../CONTRIBUTING.md) | 变更与验证要求 |
| [第三方声明](../THIRD_PARTY_NOTICES.md) | 上游源代码与许可证 |

## 目录

`apps/web` 为 Next.js 应用，`services/daemon` 为节点程序，`proto` 定义机器协议，`packages/rpc` 保存 TypeScript 生成契约，`deploy` 提供构建、安装与部署测试。

daemon 与内嵌核心共享进程：daemon 重启或升级会中断已有代理连接。面板暂时离线不会停止本地代理。
