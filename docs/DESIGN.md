# 界面设计规范

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
