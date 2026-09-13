# 运维指南

## 环境与配置

面板以 Docker Compose 单实例运行。公开入口使用 HTTPS；daemon 支持 Linux amd64/arm64，安装和维护需要 root 与 systemd。

| 变量 | 用途 |
| --- | --- |
| BIFURCATION_PUBLIC_URL | 无末尾路径的公开 origin；Passkey 和链接生成使用它 |
| BIFURCATION_APP_KEY | 固定的 64 位十六进制应用密钥 |
| BIFURCATION_PORT | 宿主机回环监听端口，默认 3000 |
| BIFURCATION_DATABASE_PATH | 本地数据库路径；Compose 固定为 /data/bifurcation.sqlite |
| BIFURCATION_ARTIFACT_DIRECTORY | daemon 制品目录；镜像已配置 |

```sh
docker compose up -d --build
docker compose exec panel node scripts/admin.mjs init admin
docker compose ps
docker compose logs --tail 100 panel
```

初始化链接只能使用一次。管理员丢失登录凭据时执行 `docker compose exec panel node scripts/admin.mjs recover admin`。

数据卷和应用密钥必须保留。备份应复制到数据卷之外，具体命令见 [备份与恢复](BACKUP-AND-RESTORE.md)。

## HTTPS 反向代理

以下为 Nginx 服务器配置示例，替换域名和证书路径。证书申请与续期由部署方管理。

```nginx
server {
    listen 443 ssl;
    server_name panel.example.com;
    ssl_certificate /etc/ssl/panel/fullchain.pem;
    ssl_certificate_key /etc/ssl/panel/privkey.pem;
    client_max_body_size 4m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;
        proxy_read_timeout 90s;
        proxy_send_timeout 90s;
    }
}
```

RPC 流需要关闭响应缓冲，并容许超过心跳间隔的空闲时间。反向代理和面板的公开 origin 必须一致。更换域名还涉及 Passkey 的 RP/origin 与已有节点地址，不能仅修改 DNS。

## 节点接入

创建机器后使用详情页生成的安装命令。安装器下载白名单制品并校验 SHA-256，持久保存面板地址、Token 和安装身份。重复安装保持状态；更换同一面板的 Token 需要显式接管并生成备份。跨面板或更换状态目录不自动接管。

确认机器已经连接，再发布监听地址、端口与 TLS 配置。端口需按所用协议开放：Trojan 使用 TCP，Hysteria2 使用 UDP。证书可以使用节点上的绝对文件路径或面板分发的 PEM。

```sh
systemctl status bifurcation-daemon.service
journalctl -u bifurcation-daemon.service --since '15 minutes ago'
```

本地服务 active 只证明进程状态；接入、配置 revision 和核心健康以面板实际回报为准。

## 更新与卸载

面板更新前完成数据库和密钥备份，然后重建容器：

```sh
docker compose up -d --build
docker compose logs --tail 100 panel
```

daemon 更新从机器详情发起。界面显示目标 daemon 和内嵌核心版本，执行前确认 SHA。维护期间代理连接会中断，恢复后客户端重新连接。不要在同一安装上并发使用手工文件替换与面板更新。

卸载先停止核心并结算用量，再由持久 helper 补报和清理。网络不可达时保留所需身份与数据等待确认。面板“移除记录”不替代本地卸载；安装备份和操作者的无关文件不自动删除。

## 排查

| 现象 | 检查 |
| --- | --- |
| 节点未连接 | 公开 URL、证书信任、Token、DNS、反向代理流超时、daemon journal |
| 配置待同步 | 实际 revision/policy、任务错误、节点连通性 |
| 核心启动失败 | TLS 文件/密钥、端口冲突、基础 JSON、最新授权下的回退结果 |
| 用量不完整 | 核心崩溃、时钟倒退、存储空间、outbox 积压、面板高水位 |
| 更新未确认 | 实际 daemon 版本、本地就绪证据、重连和任务结果 |
| 数据库锁冲突 | 是否有第二个面板实例或恢复进程；不要删除正在使用的锁文件 |

保留错误现场及数据库一致备份后再处理恢复。不要通过清空节点 journal/outbox、降低授权下限或修改迁移校验值绕过错误。
