# 默认客户端配置的设计参考

这是 [多订阅 PRD](../PRD-SUBSCRIPTIONS.md) 的可评审附件，不是已发布功能或可直接运行的客户端配置。

`base.template.json` 从 2026-09-14 的 `E:\Tool\xx\config\config.json` 提取。源客户端的核心报告为 1.14.0-beta.9。保留 DNS、TUN、路由、规则集、Clash API、缓存和日志结构，去除真实代理出口、密码、节点 TLS 例外、个人进程/应用路由。远程规则集的下载 detour 改为 `auto`；AI 自动组改名为 `auto-ai`，不再用名称暗示系统会自动判断地区。

selector/urltest 的空成员是**模板绑定位置**，不是允许发布的空代理组。实现时根据下列声明填入当前用户的授权节点；完整组装、可选 Patch 和目标版本校验后才能导出。平台元数据仅在旁路声明中保存，不能出现在最终 sing-box JSON。

| 组 tag | 固定成员 | 动态成员 | 默认 |
| --- | --- | --- | --- |
| `select` | `auto`、`direct` | 全部授权且已发布的协议出口 | `auto` |
| `select-ai` | `auto-ai` | 默认全部，可在节点组页显式限定 | `auto-ai` |
| `select-game` | `auto-game` | 默认全部，可显式指定机器/协议 | `auto-game` |
| `auto` | 无 | 全部授权且已发布的协议出口 | 不适用 |
| `auto-ai` | 无 | 同 AI 组的显式选择 | 不适用 |
| `auto-game` | 无 | 同游戏组的显式选择 | 不适用 |

AI/游戏 selector 与其对应 urltest 使用同一节点选择集合。限定游戏节点时，自动测速也必须限定在该集合，不能通过共享的全局 `auto` 绕过用户选择。

动态成员 tag 使用 `bfc_<stable-machine-id>_<protocol>`，根据稳定 ID 排序，不依赖机器显示名称、供应商名称或原文件中的出口次序。模板中所有绑定组必须匹配，默认成员必须存在。没有可用代理节点时保存草稿并提示配置未就绪，不输出伪成功的纯直连订阅。

可以在每条订阅上单独应用以下 RFC 6902 补丁，例如为一个不由应用接管 TUN 的客户端改用本机 mixed 入站：

```json
[
  {
    "op": "replace",
    "path": "/inbounds",
    "value": [{"type": "mixed", "tag": "mixed-in", "listen": "127.0.0.1", "listen_port": 2080}]
  },
  {"op": "replace", "path": "/log/level", "value": "warn"}
]
```

文件导入不意味着任意应用都能使用。DNS evaluate/respond/race/optimistic、规则集 HTTP 配置、Clash API 和缓存字段须用目标核心验证；`sing-box check` 能力、规则集可达性、客户端实际导入、TUN 权限和网络连通性应分别报告。本轮只检查参考 JSON 结构与脱敏，不宣称最终配置已通过核心或真实客户端验证。
