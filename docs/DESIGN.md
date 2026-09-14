# 界面设计规范

## 统一主页面宽度

所有面板主页面共用 AppShell 的 `.page-frame`：宽度占满可用空间、最大 1480px、在侧栏以外的区域居中。左右留白统一由 `.page-content` 提供，桌面为 40px，窄屏沿用 20px。账号、概览、列表、机器详情及两种配置编辑页不得再设置独立页面宽度上限；内部字段、代码区和弹窗可以按内容限制尺寸，但不能改变主页面边界。根文档预留稳定滚动条空间，避免长短页面切换引起横移。

Figma 的 28 个桌面主画板使用相同的「页面内容框」和 Layout 变量；默认侧栏 224px，内容上限 1480px。页面主体和内容使用 Fill，宽屏下按上限居中；表格名称列和配置主栏随内容框伸展。[1920px 八页对照](https://www.figma.com/design/IKaSuhU32hlyWYqxPUMUsg?node-id=114-356) 中，内容左右边界统一为 x=332 与 x=1812。画板尺寸表示可用布局宽度，不含浏览器滚动条；用户调整侧栏宽度后，代码仍按剩余空间使用同一规则。

`e2e/layout.spec.ts` 对 9 个真实路由逐一检查 1920、1440、390px 视口下的内容左右边界、内部容器宽度、标题左对齐和水平溢出，共 27 组页面/视口组合。

## 全站审视增量 · 2026-09-14

本次审视覆盖登录、激活/恢复、管理与个人概览、用户管理、账号设置及移动端对应视图。已对照本地页面和 Figma 实现对应调整，继续使用 Kumo 原生组件。机器工作区的实现说明仍见本文后段。

主要调整：

- 概览先呈现需处理的状态，再显示指标和趋势。统计期间明确上海时区、上下行口径；分钟平均峰值不称为瞬时速率。无上报显示未知，不补成零；刷新失败保留带时间的最近数据并提供重试，不能把旧在线状态当作当前状态。
- 个人概览提供多订阅管理入口；移动概览不再默认展示一条完整订阅 URL。额度用尽说明重置时间和联系管理员的路径，并明确手工禁用不会随额度重置解除。
- 用户管理区分启用账号、调整额度和恢复登录凭据。操作说明区分账号目标状态与节点确认，列表不推测节点已执行完成；不能禁用或降级最后一个启用管理员，客户端禁用对应入口并保留服务端保护。
- 账号设置把添加操作放在各区域标题行，说明 Passkey、后备密码和 API Key 的用途。API Key 仍继承账号当前权限、长期有效、仅创建时展示完整值。移除 Passkey 和撤销 API Key 分别确认影响。
- 激活和恢复流程允许直接完成密码设置，Passkey 为可选步骤。恢复替换旧登录凭据并撤销旧会话，但保留 API Key。补充 Passkey 不可用时的密码登录入口。
- 首次使用采用紧凑说明与就近操作，不重复堆叠大块空白。移动用户/账号页保留状态、额度、凭据前缀及操作。

### 参考与取舍

参考 [Tailscale 用户停用与恢复](https://tailscale.com/docs/features/sharing/how-to/remove-team-members) 对操作结果的区分、[Cloudflare API Token 创建](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/) 对用途命名和创建后保存步骤的组织，以及 [Grafana Time series](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/visualizations/time-series/) 对时间范围和空值的表达。只借鉴交互说明，不引入对应产品的服务账号、权限范围、设备删除或授权生效规则。

### 新增状态与入口

| 视图 | Figma |
| --- | --- |
| 审视结论、来源与验收边界 | [审视说明](https://www.figma.com/design/IKaSuhU32hlyWYqxPUMUsg?node-id=107-367) |
| 管理概览：尚无上报 | [空状态](https://www.figma.com/design/IKaSuhU32hlyWYqxPUMUsg?node-id=104-321) |
| 管理概览：刷新失败 | [最近值与重试](https://www.figma.com/design/IKaSuhU32hlyWYqxPUMUsg?node-id=104-474) |
| 个人概览：额度用尽 | [额度阻断](https://www.figma.com/design/IKaSuhU32hlyWYqxPUMUsg?node-id=104-625) |
| 账号设置：首次使用 | [尚未添加凭据](https://www.figma.com/design/IKaSuhU32hlyWYqxPUMUsg?node-id=104-750) |
| 登录：Passkey 不可用 | [密码入口](https://www.figma.com/design/IKaSuhU32hlyWYqxPUMUsg?node-id=105-335) |
| 撤销 API Key | [影响确认](https://www.figma.com/design/IKaSuhU32hlyWYqxPUMUsg?node-id=105-345) |
| 移除 Passkey | [影响确认](https://www.figma.com/design/IKaSuhU32hlyWYqxPUMUsg?node-id=105-360) |
| 移动账号设置 | [390px 账号页](https://www.figma.com/design/IKaSuhU32hlyWYqxPUMUsg?node-id=106-342) |
| 移动用户管理 | [390px 用户页](https://www.figma.com/design/IKaSuhU32hlyWYqxPUMUsg?node-id=106-412) |

原有主要画板 ID 保留。已逐图查看新增状态和主要更新画板，修正多行文本高度与移动操作重叠；18 个本轮核心画板的文字裁切检查通过，新增分区无画板重叠。原型连接主要页面与确认入口，不模拟真实网络和凭据变更；键盘焦点、移动弹窗尺寸、请求重试、最后管理员保护和授权传播应在实现阶段按真实行为验证。

代码使用 SWR 在同一个缓存项内保存结果和成功时间；切换统计范围使用独立键。普通请求失败显示最近成功时间和重试，认证失效或权限拒绝时隐藏缓存结果。尚无明细时不重复呈现空统计区，空表不保留无意义的表头或横向滚动。账号和用户表在窄屏将次级字段移入名称单元格，保留所有操作；危险确认使用原生 alertdialog，取消恢复触发按钮焦点，重新打开表单不沿用已取消的输入。浏览器回归位于 `e2e/page-states.spec.ts`，认证、订阅和机器流程保留各自的真实端到端用例。

## 多订阅设计基线

2026-09-14 增量：多订阅、完整客户端配置及 Kumo Table/Dialog 一致性。业务规则以 [多订阅 PRD](PRD-SUBSCRIPTIONS.md) 为准；本轮是设计与文档更新，不表示线上界面已经变更。

## 来源与组件使用

- [Kumo Table](https://kumo-ui.com/components/table/)
- [Kumo Dialog](https://kumo-ui.com/components/dialog/)
- [Kumo CLI](https://kumo-ui.com/cli/)
- [Kumo design skill](https://kumo-ui.com/skill/)
- [Kumo 样式导入](https://kumo-ui.com/installation/#import-styles)
- [Bifurcation Figma](https://www.figma.com/design/IKaSuhU32hlyWYqxPUMUsg)

Table、Dialog、LayerCard、Input、Button、Tabs 等都是 `@cloudflare/kumo` 的原生 npm exports。直接从包导入，不用 CLI `init`/`add` 复制安装组件，不自行重写 React Table/Dialog。CLI 只用于 `ls`、`doc <name>`、`ai` 等只读文档查询；本轮实际查询了已安装 2.13.2 的 Table/Dialog 文档。

```tsx
import { Table, LayerCard, Dialog, Button } from "@cloudflare/kumo";
```

Figma 中的外观规格、原型和实例用于映射 npm 组件；Figma 库搜索无结果不代表 npm 组件不存在，也不能作为新建实现的理由。

## 样式接入与覆盖边界

应用使用 Tailwind v4；按官方顺序注册源码扫描和主题。对 `apps/web/src/app/globals.css`，扫描相对路径为：

```css
@source "../../node_modules/@cloudflare/kumo/dist/**/*.{js,jsx,ts,tsx}";
@import "@cloudflare/kumo/styles/tailwind";
@import "tailwindcss";
```

验证该路径在本地和 Docker 构建上下文均指向实际的包。不要混入 standalone 全量样式。现有全局 `table`、`th`、`td`、`.dialog-title` 以及泛化布局覆盖需要在实现阶段审查；不要用无层级的全局 CSS 覆盖 Kumo 内部样式后再手工补偿。

正文、表格数据、表单、按钮使用 14px；标题按层级使用 16–28px。正文强调 medium，标题 semibold，不用 bold，不修改 tracking。英文使用 Inter，中文使用 Noto Sans SC。代码可使用等宽字体，行内代码约正文的 0.9 倍。颜色用 Kumo 语义 token；浅深色通过主题切换，不手写 `dark:` 颜色。Hover 颜色立即变化。

## Table

使用 `LayerCard`（p-0）包住原生 `Table`；不再套一层带 24px 内边距的大卡片。容器使用 Kumo 的圆角、ring 和轻阴影，不叠加实色 border 与 drop shadow。

表格只保留这一层可见外框。其上用于组合标题、工具栏和表格的容器必须是无背景、无边框、无阴影、无额外内边距的布局容器；标题与工具栏通过 gap 排列。验收时检查表格的全部祖先，而不只检查表格本身。Dialog 内的表单控件、独立代码编辑区可以有各自必要的边界，不能机械地删除。

默认表头为 base 底色、semibold、12px 单元格内边距和底部分隔，数据行使用默认交替底色（base/elevated）。只有明确选择 `Table.Header variant="compact"` 时才用紧凑表头，不能把全站灰底 12px 自定义表头当作默认 Table。

行选中使用原生 selected/tint 样式；数据不以低对比度灰字呈现。数字列右对齐并使用等宽数字；名称可换行，长地址截断但提供完整显示/复制。操作列含明确按钮和更多菜单，不依赖整行点击才可操作。表头与数据列保持相同宽度定义。

空状态放在表格容器内部、跨全部列，说明原因和下一步；搜索无结果、加载 skeleton 和请求失败重试分别设计。移动端保留数据与操作，横向滚动或改为等价列表，不能简单隐藏重要列。

## Dialog

使用 `Dialog.Root`、`Dialog`、`Dialog.Title`、`Dialog.Description`、`Dialog.Close`。危险确认使用 `role="alertdialog"`。官方宽度：sm 288px、base 384px、lg 512px、xl 768px；订阅创建/确认采用 lg，配置预览采用 xl，大型配置编辑用独立页。

Dialog 采用 `p-8`；标题行横向排列，标题 24px semibold，右侧为 secondary square 关闭按钮。描述与标题的间距 16px，操作区与正文相隔 32px，按钮横向右对齐、间隔 8px，取消在前、主要操作在后。不把确认和取消纵向堆在左侧。

保持组件原生的位置和遮罩：桌面距视口顶端 64px、水平居中；窄屏距顶 32px，最大宽度为视口减 32px。遮罩使用 recessed 的 80% 透明效果，不强制改为深黑中心弹窗。圆角 xl、Kumo ring/阴影；长文本换行，滚动区不得使标题、关闭或主要操作不可达。

背景 inert、焦点限制、Esc、关闭后焦点恢复由原生组件处理。提交失败保留输入，错误与字段/操作关联；提交中显示 loading，避免重复提交。危险操作需要显式点击确认，关闭/取消不执行操作。Figma 原型只表达交互，不代替键盘和屏幕阅读器的真实组件验收。

保持 `Dialog.Root` 挂载，通过 `open`/`onOpenChange` 控制显示；不要以 `{open && <Dialog...>}` 条件卸载破坏原生开关动画。

## 订阅设计范围

原有普通用户和管理员「接入与订阅」页面改为多订阅列表；管理员个人视图只列自己的订阅。补齐创建、配置编辑（基础配置/节点组/Patch）、最终预览、独立重置链接、暂停/生成失败/空状态及移动端。

默认列表不展示完整秘密 URL。配置编辑页明确草稿与已发布版本，不在输入期间改变下载结果。节点组与补丁的错误显示具体位置；无节点时仍可保存草稿。代理凭据属于整个账号，必须在独立区域解释它影响所有订阅。

所有 Figma 示例使用虚构名称、示意掩码和文档域名，不把用户截图中的真实订阅 URL 或本机配置凭据复制进设计文件。

## 本轮 Figma 入口

| 设计 | 链接 |
| --- | --- |
| 多订阅列表（普通用户） | [接入与订阅](https://www.figma.com/design/IKaSuhU32hlyWYqxPUMUsg?node-id=28-79) |
| 多订阅列表（管理员个人视图） | [接入与订阅 · 管理员](https://www.figma.com/design/IKaSuhU32hlyWYqxPUMUsg?node-id=30-351) |
| 完整基础配置 | [配置编辑](https://www.figma.com/design/IKaSuhU32hlyWYqxPUMUsg?node-id=77-193) |
| 节点组 | [组绑定](https://www.figma.com/design/IKaSuhU32hlyWYqxPUMUsg?node-id=79-208) |
| 可选 JSON Patch | [Patch 编辑](https://www.figma.com/design/IKaSuhU32hlyWYqxPUMUsg?node-id=78-201) |
| 校验失败 | [Patch 错误](https://www.figma.com/design/IKaSuhU32hlyWYqxPUMUsg?node-id=86-276) |
| 创建订阅 | [创建 Dialog](https://www.figma.com/design/IKaSuhU32hlyWYqxPUMUsg?node-id=84-236) |
| 预览与发布 | [最终配置预览](https://www.figma.com/design/IKaSuhU32hlyWYqxPUMUsg?node-id=85-244) |
| 独立重置链接 | [重置 Dialog](https://www.figma.com/design/IKaSuhU32hlyWYqxPUMUsg?node-id=35-164) |
| 删除订阅 | [删除 Dialog](https://www.figma.com/design/IKaSuhU32hlyWYqxPUMUsg?node-id=86-260) |
| 暂停一条订阅 | [独立暂停结果](https://www.figma.com/design/IKaSuhU32hlyWYqxPUMUsg?node-id=90-296) |
| 删除一条订阅 | [保留其余订阅](https://www.figma.com/design/IKaSuhU32hlyWYqxPUMUsg?node-id=90-446) |
| 首次使用 / 无节点 | [空状态](https://www.figma.com/design/IKaSuhU32hlyWYqxPUMUsg?node-id=87-283) |
| 移动端 | [390px 订阅列表](https://www.figma.com/design/IKaSuhU32hlyWYqxPUMUsg?node-id=87-442) |

本轮还调整了原有 13 处表格和 18 个表单/确认 Dialog，保留原有业务页面与主要目标 frame ID。原型用于演示创建→编辑→预览→发布，以及首条示例订阅的操作；JSON 代码区为设计摘录，完整模板以评审附件为准。

已检查本轮 15 个核心视图的字体族及容器裁切边界，并对桌面列表、配置编辑、节点组、Patch、预览 Dialog、创建/重置 Dialog、移动列表及原有用户表格/创建用户 Dialog 做了截图检查。此验证针对 Figma 设计；线上 CSS、真实焦点行为、JSON Patch 执行和客户端兼容性留待实现阶段按 PRD 验收。

后续完整页面审查发现：原有表格换用 Kumo 外框后仍保留外层卡片，造成重复边框和 24px 额外留白。已移除机器、用户、用量、状态/操作历史及普通用户/管理员账号设置共 13 处表格外层装饰，并把表格和标题栏扩展至内容宽度。截图验收必须同时包含完整页面与组件局部，避免局部截图遗漏祖先容器叠加问题。

## 已实现：属性驱动的多订阅

订阅列表用单层 Kumo Table/LayerCard 展示命名订阅；完整 URL 默认不占用列表，复制失败时仅显示一个可选中的 Input。移动端将状态与节点数移到名称下方，所有操作仍可达。共享节点及账号代理凭据为次级区域。

`/subscription/[id]` 是独立编辑页，使用 Kumo Input/InputArea/Button 编辑完整客户端模板和按 tag 定位的节点组。地区、标签、协议和机器 ID 选择与 JSON 模板分开保存；平台元数据不进入客户端下载结果。草稿、预览、发布状态明确区分；预览包含凭据的完整 JSON 默认折叠。创建、单链接生命周期与账号凭据重置保留确认弹窗。

## 已实现：机器工作区

`/admin/machines` 与 `/admin/machines/[id]` 沿用现有 Kumo 语义颜色、字体及组件，以先查看运行状况、再进入维护为页面顺序。这里记录已实现界面，不改变前述订阅设计规格的范围。

列表使用单层 LayerCard/Table；工具栏提供名称、地址、地区、标签搜索，在线、失联、待接入、已卸载筛选，以及刷新、清除筛选和结果数量。机器名称是明确的详情链接。移动端将系统、版本、资源、代理连接数和最近上报移至名称下方的带标签字段，状态仍单列可见，保留地区、标签与进行中任务数。

详情头部集中显示名称、管理连接、代理状态、地址和标签，并提供信息编辑和配置入口。用户确定的四个标签为「概览、用量、操作记录、接入与维护」，使用原生 Kumo 下划线 Tabs。选择写入 URL 的 `tab` 参数，概览省略参数，未知值回到概览；刷新、直接访问及浏览器前进后退保留对应视图。保留原生键盘切换，标签与可聚焦的 tabpanel 相互关联；窄屏由原生滚动导航保持标签可达。进行中的任务和全局问题位于标签内容之外，切换视图仍然可见。

概览先展示 CPU、内存、磁盘剩余、代理连接数；CPU 与内存使用原生 Meter，未知值明确显示「未上报」。最近上报时间与失联时的最近值提示紧邻数据；网卡累计接收/发送另列，并说明不计入代理用量。下方以两组定义列表并列展示机器信息及配置版本、授权同步、端口、TLS 域名。待接入机器直接显示首次安装命令；已卸载状态提供历史保留与后续操作说明。用量保留独立统计视图，操作记录提供任务结果和最近日志入口。

接入与维护将版本对照表和长期可查看、复制的机器 Token 并列放置，安装与绑定、卸载与移除依次排列在后。维护说明依据节点报告区分在线维护、容器更新镜像、手动维护、安装需要修复及待确认；禁用操作附近解释具体原因，不从缺失信息推测部署方式。升级说明连接中断；Token 重置说明旧凭据失效及节点同步要求；替换实例说明旧实例失去访问权限；卸载程序与移除面板记录分别说明结果，并保留显式确认和任务互斥状态。

布局仅在机器页面作用域内调整：详情最大宽度 1480px，内容间距 16px；资源由四列在 1200px 以下改为两列，概览与维护的双列在 960px 以下改为单列，600px 以下内边距从 20px 收至 16px、操作行纵向排列。组件外观仍由 Kumo 提供，不增加全局 Table/Tabs/Meter 覆盖。

构图参考为 [Cockpit 概览](https://cockpit-project.org/images/screenshot/overview.webp)、[Cockpit 性能监测介绍](https://cockpit-project.org/blog/pcp-grafana.html)，以及 Tailscale 的[设备管理](https://tailscale.com/docs/features/access-control/device-management/how-to/set-up)与[标签](https://tailscale.com/docs/features/tags)文档；这些参考不引入对应产品的功能或授权语义。本轮未增加随产品发布的位图资产。桌面和移动端的列表、概览、维护共六张最终截图已通过独立完成度审查，结论为可交付、无实质性修正项；业务与自动化检查以开发验证结果为准。
