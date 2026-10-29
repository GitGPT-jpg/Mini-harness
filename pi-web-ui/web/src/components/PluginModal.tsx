import type { UiSlotEntry } from "../ui-slots";
import type { LoadedPluginView } from "../plugin-loader";
import { PluginView } from "./PluginView";
import { Modal } from "./Modal";
import { useT } from "../i18n";

interface PluginModalProps {
	/** 已打开的 modal.dialog 条目（App 按 openModalId 解析，hidden 的打不开）。 */
	entry: UiSlotEntry;
	/** 该条目插件已加载的视图（kind="view" 用；还没加载好时为 undefined → 显示 loading）。 */
	pluginView?: LoadedPluginView;
	/** kind="action" 等非视图条目：点即分发（调用方决定关不关，一般是关）。 */
	onUiAction?: (item: UiSlotEntry, value?: string) => void;
	onClose: () => void;
}

/**
 * 插件弹窗壳（`modal.dialog` 槽位的渲染层）。
 *
 * 统一接入 `<Modal>` 原语：接管 Portal、Esc 栈调度、滚动防穿透与无障碍支持。
 */
export function PluginModal({ entry, pluginView, onUiAction, onClose }: PluginModalProps) {
	const t = useT();
	const label = entry.label || entry.id;
	const isView = entry.kind === "view";

	return (
		<Modal className="plugin-modal" title={label} icon={entry.icon} onClose={onClose}>
			<div className="modal-body plugin-modal-body">
				{isView ? (
					pluginView ? (
						<PluginView entry={pluginView} />
					) : (
						<div className="plugin-modal-loading">{t("loading")}</div>
					)
				) : entry.kind === "divider" ? (
					<hr className="plugin-modal-divider" />
				) : (
					<button type="button" className="btn primary plugin-modal-action" onClick={() => onUiAction?.(entry)}>
						{entry.badge ?? label}
					</button>
				)}
			</div>
		</Modal>
	);
}
