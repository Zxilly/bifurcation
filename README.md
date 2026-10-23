# Bifurcation

为不超过 10 位用户共享代理节点提供自托管管理。一个 Next.js 面板管理账号、节点、订阅和流量额度；Linux 节点运行内嵌 sing-box 的 daemon，支持 Trojan 与 Hysteria2。

面板使用单实例 SQLite 和持久数据卷。节点主动连接面板，不需要开放额外管理端口。在线升级和卸载要求节点采用项目安装器管理的 systemd 服务。

## 部署面板

准备 Docker Engine、Docker Compose 插件、指向服务器的域名和 HTTPS 反向代理。在仓库根目录运行以下 Linux 命令，将示例地址替换为实际面板地址：

```sh
docker info
docker compose version
docker run --rm --network none --user "$(id -u):$(id -g)" \
  -v "$PWD:/workspace" -w /workspace node:24-bookworm-slim \
  node deploy/configure.mjs --url https://panel.example.com
docker compose config --quiet
docker compose up -d --build --wait --wait-timeout 180
```

配置工具会在仓库根目录新建 `.env`、生成应用密钥并检查地址和端口；已有文件时拒绝覆盖。把 `.env` 安全备份，后续升级继续使用原密钥。宿主机只监听 `127.0.0.1:3000`，按[运维指南](docs/OPERATIONS.md#https-反向代理)配置 HTTPS 转发后访问公开地址。首次开放访问前创建管理员。

已有 Node.js 24 时可直接运行 `node deploy/configure.mjs --url https://panel.example.com`，无需临时 Node 容器。本机试用可改用 `--url http://localhost:3000`；此地址不能用于远程节点接入。完整的配置检查、启动确认和排查步骤见[运维指南](docs/OPERATIONS.md)。

## 开始使用

1. 打开面板首页，设置首个管理员的用户名与后备密码；登录后可添加 Passkey。
2. 在机器管理中创建节点，在 Linux 节点执行详情页提供的安装命令，等待面板显示已连接。
3. 配置节点监听端口和 TLS，预览并发布配置；防火墙按协议开放 TCP 或 UDP 端口。
4. 创建用户并发送激活链接。用户创建订阅，预览并发布后，将订阅链接导入兼容的 sing-box 客户端。

## 文档

- [产品说明](docs/PRODUCT.md)：角色、凭据、订阅、用量与维护行为。
- [运维指南](docs/OPERATIONS.md)：环境配置、HTTPS、节点接入和更新。
- [备份与恢复](docs/BACKUP-AND-RESTORE.md)：在线快照、离线恢复及授权和计量边界。
- [开发指南](docs/DEVELOPMENT.md)：本地开发、代码生成和检查。
- [架构](docs/ARCHITECTURE.md)与[数据协议](docs/DATA-AND-PROTOCOL.md)：持久状态和一致性约束。
- [部署验收](deploy/tests/README.md)：容器重建、备份恢复、安装器和真实 systemd 测试。
