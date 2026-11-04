# 内置 UI 布局与多根工作区

> 沿用历史文件名以保留引用入口。界面插件运行时、plugin-sdk、MCP bridge 和插件市场已删除。
> 本文只保留并核对仍在使用的宿主布局、工作区协议和定时任务基础设施；pi 扩展另见
> [系统提示词与扩展链](architecture-system-prompt.md)。

## 内置 slot 的事实源

- `server/ui-slots.ts`：slot/kind 类型与归一化；`server/protocol.ts` 引用这些类型。
- `web/src/ui-slots.ts`：`BUILTIN_UI_ITEMS`、`UI_SLOT_SPECS`、`buildUiSlots()`、排序与恢复纯函数。
- `web/src/components/BarItem.tsx`：内置顶栏/底栏条目的实际渲染与动作。
- `web/src/slot-toolbar.tsx`：内置节点与 slot 顺序的组合。
- `web/src/components/SettingsModal.tsx`：布局偏好编辑。

槽位枚举中仍可能保留旧名称；存在一个槽位类型，不代表对应产品面板仍挂载。
新增入口须同时核对条目表、渲染组件、能力门控和图标登记，不能只改目录表。

## 合并与恢复

当前签名为 `buildUiSlots({ t, layout, diagnostics? })`，只有两层：

1. 从 `BUILTIN_UI_ITEMS` 建宿主默认条目。
2. 应用 `UiLayoutPrefs`：hidden/shown、groups、align、labels、slots、order。

同一条目同时出现在 hidden/shown 时，后应用的 shown 胜出。旧偏好里不存在的条目被忽略，
不据此创建插件条目。`restoreUiItem()` 清理该项的用户覆盖，`restoreAllUi()` 清空布局偏好。
`source` 为 host；原来的插件贡献与 arrange 合并层已移除。

`host:settings` 与 `host:history` 保持可见；左栏分区条目只能留在 `leftpanel.sections`，
非法移动被纠正并产生诊断。单占位槽位通过 `applyUiSlotCardinality()` 选出赢家，
其余冲突项隐藏；传入 diagnostics 时返回可定位到 slot/entryId 的诊断。

布局页和实际界面必须使用同一份计算结果。用户显式改名设置 `labelExplicit`：
名字型条目替换内置文案，数值型条目加名称但保留实时值，避免只在设置页改名。
`host:task-desk` 打开任务台，`host:cluster` 展示集群状态，`host:loop` 打开当前运行详情或任务台。

## 溢出、浮层与交互

`splitOverflow()` 按既有顺序分割条目；顶栏的实际宽度判断由 `topbar-fit.ts` 负责。
条目隐藏与溢出菜单的可操作性需一起验证，不可让设置入口失联。
组件自身保留业务逻辑，slot 只负责位置、顺序和偏好。

下拉/右键菜单 Portal 到 body 并 fixed 定位；浮层复用 `useFloatingPanel`。
scroll/resize 只重算锚点，点击外部或 Escape 关闭，避免滚动时菜单无故消失。
相关回归入口：`tests/unit/ui-slots.test.ts`、`tests/unit/bar-item-unified.test.ts`、
`tests/unit/topbar-fit.test.ts`、`tests/ui-layout-ui-test.mjs`。
测试是否进入冒烟以 `tests/run-smoke.mjs` 为准，不维护固定通过数量。

## 多根工作区

当前仍保留上行 `set_workspace_roots { roots? }` 和快照 `UiState.workspaceRoots`。
处理在 `ClientSession.setWorkspaceRoots()`；归一化与持久化在 `server/client-state.ts`：

- 只接收绝对路径，归一化并去重，最多 8 个额外根。
- 按 clientId 和项目 cwd 保存；传入的是整份替换列表，空数组清空。
- 不校验目录当前是否在线，暂时断开的盘/挂载点不应被静默清除。
- 重复写入相同列表不额外推快照；切项目读取对应项目的列表。

pi SDK 仍是单 cwd 会话，多根记录不会把模型运行目录改成多个目录。
旧右栏文件树已移除，不再描述其“添加工作区”按钮，也不存在插件读目录免授权机制。
不要把设置了额外根理解为绕过文件 HTTP 路由的授权；具体访问仍由各路由的路径检查决定。
相关测试：`tests/unit/workspace-roots.test.ts` 与 `tests/workspace-roots-test.mjs`。

## 保留的调度基础设施

`server/scheduler-tasks.ts` 是内置定时任务，`server/cron-spec.ts` 提供 cron 解析，
`server/conversation-view.ts` 和 `readConversationForScheduler` 提供读取会话的路径。
这些模块由原插件相关模块改名保留下来，不依赖插件运行时。
远期任务使用 `armDelay` 分段计时，避免超过 Node 定时器范围后触发忙循环。
