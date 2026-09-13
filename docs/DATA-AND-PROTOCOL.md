# 数据与协议

类型和字段的权威来源是 [Web schema](../apps/web/src/server/db/schema.ts)、[代理 schema](../apps/web/src/server/db/schema-proxy.ts)、[机器 schema](../apps/web/src/server/db/schema-machines.ts)、[Ent schema](../services/daemon/internal/state/ent/schema) 和 [Protobuf](../proto/bifurcation/v1/machine.proto)。生成代码不能手工修改。

## 数据约定

ID 为稳定的不透明字符串。时间为 UTC 毫秒，日/月聚合按 Asia/Shanghai 计算，区间左闭右开。字节为非负整数；Web 存储十进制 TEXT 并使用 BigInt 计算，HTTP 返回十进制字符串，protobuf 使用 int64。图表浮点数只用于显示。

API Key、Session 和一次性 token 按摘要验证。可恢复的机器 Token、订阅链接、配置及代理凭据使用应用密钥认证加密。密码使用 Argon2id。加密密钥本身不存入数据库。

## 面板持久状态

| 表 | 用途 |
| --- | --- |
| `users`、`password_credentials`、`passkeys` | 账号策略与登录凭据 |
| `sessions`、`auth_flows`、`rate_limits`、`api_keys` | 会话、一次性流程、限速与自动化认证 |
| `machines` | 机器、Token、绑定/会话 epoch、最新状态和移除标记 |
| `tasks` | payload/hash、幂等键、执行与终态回报 |
| `proxy_credentials`、`subscription_tokens` | 代理凭据和订阅 token 的独立代次 |
| `policy_state` | 授权版本、当前月份和策略指纹 |
| `machine_configs`、`config_previews`、`config_revisions` | 设置、预览、不可变配置与目标版本 |
| `machine_user_history` | 历史用户与机器归属 |
| `usage_streams` | 每机器/安装实例/上报流的确认高水位 |
| `usage_buckets`、`quota_states` | minute/day/month 投影与当月额度状态 |

机器移除保留历史引用；用户通过禁用控制访问。分钟明细清理不能删除去重高水位。估算和缺口作为汇总标记保存，不创建虚构的流量值。

## 节点持久状态

`daemon.json` 保存本地安装配置，`identity.json` 保存安装 ID 与绑定 epoch。SQLite 的 `tasks` 保存执行 journal，`cursors` 保存累计值与 closed 标记，`batches` 保存不可变 outbox，`streams` 保存序号/确认状态，`cores` 保存批准配置、授权下限和切换阶段。

每次核心启动产生新 runtime ID；上报流及其序号跨正常进程重启保留。零基线标记运行期已经开始，Final 标记该运行期已完整结算。dirty 运行期消失时记录缺口。已确认并删除的 outbox 不能从旧面板备份中凭空恢复。

## HTTP

认证交换位于 `/api/auth`，业务接口位于 `/api/v1`。浏览器使用 HttpOnly Session，自动化使用 Bearer API Key；二者都按账号当前角色与状态授权。Cookie 写请求验证公开 origin，Bearer 请求不回退为 Cookie 身份。

| 接口族 | 用途 |
| --- | --- |
| `/api/auth/{passkey,password,activation,recovery,reauth,logout}` | 登录、激活、恢复、近期认证 |
| `/api/v1/me` | 个人信息、用量、API Key、Passkey、密码和订阅 |
| `/api/v1/admin/users` | 账号创建、额度/角色/状态及恢复 |
| `/api/v1/admin/machines` | 机器管理、token、重绑、诊断、配置、升级和卸载 |
| `/api/v1/admin/usage` | 跨用户/节点用量 |
| `/s/:token` | 只读订阅配置 |
| `/install.sh`、`/artifacts/:id` | 安装函数与白名单制品 |

具体路由以 [app/api](../apps/web/src/app/api) 为准，请求和响应类型位于 [contracts](../apps/web/src/contracts)。写入采用版本检查或请求幂等键；错误以稳定 code 和 HTTP 状态表示。账户及机器数据不进入公共缓存。

## Connect

`bifurcation.v1.MachineService` 位于 `/rpc/[...connect]`，所有调用使用机器 Bearer Token。机器 ID 从 Token 派生，不能由请求体选择。

| RPC | 语义 |
| --- | --- |
| `WatchTasks` | 服务端流：会话、任务通知与心跳 |
| `AcceptTask` | 确认当前安装/会话接受任务，返回原始 payload |
| `GetConfig` | 获取本机指定配置和最新授权层 |
| `ReportStatus` | 按 session epoch/序号提交实际状态 |
| `ReportUsage` | 按流序号去重入账并返回确认高水位 |
| `ReportTask` | 提交阶段/结果并确认持久终态 |

任务仅有 INSPECT、APPLY_CONFIG、UPGRADE_DAEMON、UNINSTALL。首次配置也使用 APPLY_CONFIG；核心随 daemon 升级。

首次连接绑定安装 ID，相同实例重连提升 session epoch。管理员重绑提升 binding epoch 并更换 Token，普通 Token 重置不改变安装身份。旧会话不能覆盖新状态，旧绑定不能执行新任务。计量和终态重报不依赖临时会话，仍须属于正确安装与任务。

TaskSpec 和 UsageBatch 的 SHA-256 针对持久化的原始 protobuf 字节；不能跨语言重新序列化后比较。重复终态须保持相同内容。daemon 升级成功还要求当前会话已独立报告目标版本。

配置 SHA 对应批准的字节内容。若收到更高授权版本，daemon 先保存授权下限；旧配置不能将其降低。回退生成的新实际配置报告自己的 digest，不冒充原 revision 的原始字节。

更新器保存切换计划及匹配 PID、启动标识、版本和 SHA 的就绪/退出证据。启动恢复器可处理 transient updater 丢失的切换。卸载 helper 保持可重启，最终 ACK 前保留重报所需身份和数据。
