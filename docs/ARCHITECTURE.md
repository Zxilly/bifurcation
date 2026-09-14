# 架构

Bifurcation 由单实例 Next.js 控制平面和各节点的 Go daemon 构成。控制平面拥有账号、授权、目标配置和汇总账目；daemon 拥有本地执行、核心实例和未确认用量。

## 部署边界

浏览器通过 HTTPS 访问 Next.js。daemon 主动建立 Connect 服务端流，状态、配置、计量和结果使用 unary RPC。代理客户端直接连接 daemon 内嵌的 sing-box。

面板使用 Drizzle + better-sqlite3；节点使用 Ent + modernc SQLite。两端数据库都启用 WAL。数据库和应用密钥由部署方持久保存，运行期凭据不进入构建产物。

控制平面的任务唤醒、订阅表和调度器属于一个 Node 进程。部署入口通过数据库文件锁防止多个实例同时拥有该库。当前架构不支持用多副本或 Node cluster 横向扩展。

## Web 应用

| 目录 | 职责 |
| --- | --- |
| `app` | 页面、布局和薄 HTTP/RPC 入口 |
| `features` | 业务界面、交互和可见状态刷新 |
| `components` | 跨业务呈现与 Kumo 组件组合 |
| `contracts` | 不依赖运行环境的 DTO 和输入类型 |
| `server/identity`、`users` | 认证、凭据、账号策略 |
| `server/modules/machines` | 安装绑定、状态和持久任务 |
| `server/configuration`、`subscription` | 配置、授权协调、订阅与代理凭据 |
| `server/usage` | 用量去重、聚合和额度 |
| `server/releases`、`artifacts` | 确定制品的元数据与受限文件下载 |
| `server/rpc`、`runtime` | Connect 适配、任务流和进程生命周期 |
| `server/db`、`crypto`、`backup` | 持久化、密钥处理和恢复 |

Server Components 直接调用经过鉴权的查询，不经 HTTP 请求自身。每个领域的 `queries.ts` 是页面与 Connect 处理器共用的读用例：以 `React.cache` 按请求去重，自带授权下限，返回物化的 protobuf 消息。首屏纯读的页面把结果作为 props 传入；需要持续轮询的视图由页面在 `<SWRConfig fallback>` 下按 `features/shared/keys.ts` 的键提供首个快照，SWR 只负责 hydration 后的刷新。Client Components 处理表单、Passkey、复制、图表与局部刷新，不能导入服务端数据库或解密工具。浏览器变更通过 Connect 入口复用服务端用例，成功后调用 `router.refresh()` 让服务端重新渲染。

UI 使用 Kumo 语义样式。用户可见的升级进度来自持久任务回报；提交成功不代表执行成功。账号激活、创建确认和首次密钥展示是临时流程，机器 Token 则长期可见。

## daemon

| 模块 | 职责 |
| --- | --- |
| `identity` | 面板地址、Token、安装 ID 和绑定 epoch |
| `panelclient` | 任务流、执行、采样、状态与结果重报 |
| `core` | 核心操作与计量契约 |
| `adapters/singbox` | 库实例、配置校验/切换、直接计量和日志 |
| `state` | Ent 数据层、任务 journal、cursor/outbox、授权下限 |
| `updater` | 独立切换、就绪证据、回滚和卸载 |
| `system`、`systemmetrics` | 有界命令、文件操作和主机指标 |

核心生命周期操作串行执行。短时读锁保护当前实例，数据库事务不跨越网络请求或核心启停。旧实例关闭并结算 I/O 后，采样接收器持久化最终计数；新实例开始监听前写入零基线。更新器独立于被替换的 daemon 进程。

## 一致性

任务流仅通知已持久化的任务。daemon 接受任务后记录其 ID、原始 payload 和 SHA-256；终态结果可重复发送，但不能重新执行。流重连使用新的 session epoch，旧流不能覆盖新状态或清理新订阅。

配置保留目标与实际 revision。排队的配置任务可以合并，已接受的任务保留身份。授权版本下限单调增加，旧配置回退也必须叠加最新授权；服务端未知的离线状态不能推断为已同步。

计量的 cursor 与 outbox 同事务写入。面板对上报流维护高水位，在同一事务中去重并更新各粒度汇总，提交后 ACK。分钟、日、月数据是同一账目的不同投影，不能相加。

## 后台生命周期

Node instrumentation 初始化共享运行期。身份过期状态定期清理，配置和额度独立于浏览器持续协调。任务流提供心跳与数据库兜底扫描。退出时取消流和定时器，已授权请求仍可完成短事务。

daemon 对临时断线退避重连。普通采样、执行和最终结算使用明确的锁顺序；停止进程前等待工作循环退出。无法持久化最终数据时不能记录成功关闭证据。

持久化和传输细节见 [数据与协议](DATA-AND-PROTOCOL.md)，部署约束见 [运维指南](OPERATIONS.md)。
