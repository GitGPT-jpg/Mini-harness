import {
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
} from "react";
import { FiX } from "react-icons/fi";
import { useT } from "../i18n";
import { appSend } from "../app-globals";
import type { UiAlign, UiLayoutPrefs, UiSlotId } from "../types";
import type { UiSlotEntry } from "../ui-slots";
import { useEscapeKey } from "../shortcut-stack";
import { hostEntryIcon } from "../host-icon";
import {
	ICON_EDIT_ALIGNS,
	ICON_EDIT_TRAY,
	ICON_EDIT_ZONES,
	applyIconDrop,
	applyIconHide,
	collectIconEditItems,
	visibleZoneEntries,
	zoneEntriesForAlign,
	sideAlignLabel,
} from "../ui-layout-edit";

interface IconEditorProps {
	/** 合并引擎算好的全部槽位（含 hidden：托盘要用）。 */
	slots: Record<UiSlotId, UiSlotEntry[]>;
	/** 当前用户布局偏好（回应后由快照回程刷新）。 */
	layout: UiLayoutPrefs | undefined;
	/** 不参与编辑的 id（宿主传 HIDDEN_FROM_LAYOUT_ITEM_IDS）。 */
	exclude?: ReadonlySet<string>;
	onClose: () => void;
}

/** 当前落点：目标落区 + 目标段 + 插入下标（去掉被拖条目之后的序列）。 */
interface DropTarget {
	slot: string;
	align?: UiAlign;
	index: number;
}

/**
 * 图标编辑模式（从顶栏「⋯」菜单进入）：**直接拖动**图标改位置。
 *
 * 能改四件事（都写进同一份 `uiLayout` 偏好，与设置 → 界面布局页互通，见 ui-layout-edit.ts）：
 *   · 栏内前后顺序（order）
 *   · 所在段落 start/center/end（align，仅顶栏/底栏这类真分段的栏）
 *   · 所在栏（slots：顶栏 ↔ 底栏 ↔ 左右悬浮栏）
 *   · 拖进「待放回」托盘 = 隐藏（hidden）
 *
 * 拖拽为什么用 pointer 事件而不是 HTML5 DnD：DnD 在触屏上根本不触发（`dragstart` 不会来），
 * 而这套界面手机端同样要能用。pointer 事件 + `elementFromPoint` 一套代码两端通用；
 * 代价是插入位置要自己按条目矩形的中点算（见 pointToTarget）。
 */
export function IconEditor({ slots, layout, exclude, onClose }: IconEditorProps) {
	const t = useT();
	const [dragId, setDragId] = useState<string | null>(null);
	const [drop, setDrop] = useState<DropTarget | null>(null);
	const buckets = useMemo(() => collectIconEditItems(slots, exclude), [slots, exclude]);

	/* 拖拽过程中 window 监听器的闭包不会随渲染更新 —— 一切会被 handler 读到的值都走 ref。
	   另外 pendingRef 是「乐观基线」：drop 后立刻再拖一次时，服务端快照可能还没回来，
	   拿旧的 layout 当基线会把这中间的改动整份覆盖掉（set_settings 是全量替换 uiLayout）。 */
	const dragRef = useRef<string | null>(null);
	const dropRef = useRef<DropTarget | null>(null);
	const bucketsRef = useRef(buckets);
	const layoutRef = useRef(layout);
	const pendingRef = useRef<UiLayoutPrefs | null>(null);
	// 事件处理器（window 监听器）只能读 ref：在绘制后同步，不在 render 里写。
	useLayoutEffect(() => {
		bucketsRef.current = buckets;
		layoutRef.current = layout;
	});
	// 快照回程 = 服务端已经吃下我们上一次的改动，乐观基线作废。
	useEffect(() => {
		pendingRef.current = null;
	}, [layout]);

	/** 指针下的落点：先在 DOM 里找落区，再按条目矩形中点算插入下标。 */
	const pointToTarget = (x: number, y: number): DropTarget | null => {
		const el = document.elementFromPoint(x, y) as HTMLElement | null;
		const strip = el?.closest<HTMLElement>("[data-drop-slot]");
		if (!strip) return null;
		const slot = strip.dataset.dropSlot;
		if (!slot) return null;
		const align = strip.dataset.dropAlign as UiAlign | undefined;
		const dragging = dragRef.current;
		const chips = Array.from(strip.querySelectorAll<HTMLElement>("[data-chip]")).filter(
			(c) => c.dataset.chip !== dragging,
		);
		let index = chips.length;
		for (let i = 0; i < chips.length; i++) {
			const r = chips[i]!.getBoundingClientRect();
			// 换行后要按「先比行、行内比列」判，只比 x 会在第二行把落点算回第一行。
			if (y < r.top) {
				index = i;
				break;
			}
			if (y <= r.bottom + 4 && x < r.left + r.width / 2) {
				index = i;
				break;
			}
		}
		return { slot, align, index };
	};

	const commitDrop = () => {
		const id = dragRef.current;
		const target = dropRef.current;
		dragRef.current = null;
		dropRef.current = null;
		setDragId(null);
		setDrop(null);
		if (!id || !target) return;
		const base = pendingRef.current ?? layoutRef.current;
		const next =
			target.slot === ICON_EDIT_TRAY
				? applyIconHide(base, id)
				: applyIconDrop(base, bucketsRef.current, {
						id,
						slot: target.slot as UiSlotId,
						...(target.align !== undefined ? { align: target.align } : {}),
						index: target.index,
					});
		pendingRef.current = next;
		appSend({ type: "set_settings", uiLayout: next });
	};

	// 拖拽期间的全局指针跟踪（只在真正按住某个条目时挂）。
	useEffect(() => {
		if (!dragId) return;
		const onMove = (e: PointerEvent) => {
			e.preventDefault();
			const target = pointToTarget(e.clientX, e.clientY);
			dropRef.current = target;
			setDrop(target);
		};
		const onUp = () => commitDrop();
		window.addEventListener("pointermove", onMove, { passive: false });
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
		return () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [dragId]);

	// Escape 关面板。不上 window 自建监听：走 useEscapeKey（shortcut-stack）才能与其它浮层同栈，
	// 「谁在最上面谁先吃 Esc」这套语义才成立。拖拽中吞掉这次 Esc（那一下是「放弃本次拖动」的意思更重）。
	useEscapeKey(() => {
		if (dragRef.current) return;
		onClose();
	});

	const startDrag = (e: ReactPointerEvent<HTMLElement>, id: string) => {
		if (e.pointerType === "mouse" && e.button !== 0) return;
		e.preventDefault();
		dragRef.current = id;
		dropRef.current = null;
		setDragId(id);
		setDrop(null);
	};

	const renderChip = (entry: UiSlotEntry): ReactNode => (
		<button
			key={entry.id}
			type="button"
			data-chip={entry.id}
			className={`icon-editor-chip${dragId === entry.id ? " dragging" : ""}`}
			title={entry.label}
			onPointerDown={(e) => startDrag(e, entry.id)}
		>
			<span className="icon-editor-chip-icon">{hostEntryIcon(entry)}</span>
			<span className="icon-editor-chip-label">{entry.label}</span>
		</button>
	);

	/** 一个落区（栏，或栏内的一个段落）。`align` 为 undefined = 不分段的栏。 */
	const renderStrip = (slot: string, align: UiAlign | undefined, hint: string | null, entries: UiSlotEntry[]) => {
		const active = drop?.slot === slot && (drop.align ?? null) === (align ?? null);
		const children: ReactNode[] = entries.map(renderChip);
		if (active && drop) {
			children.splice(
				Math.max(0, Math.min(drop.index, children.length)),
				0,
				<span key="__caret" className="icon-editor-caret" aria-hidden="true" />,
			);
		}
		return (
			<div
				key={align ?? "__all"}
				className={`icon-editor-strip${active ? " drop-over" : ""}${dragId ? " dragging-active" : ""}`}
				data-drop-slot={slot}
				{...(align !== undefined ? { "data-drop-align": align } : {})}
			>
				{hint !== null && <span className="icon-editor-strip-label">{hint}</span>}
				{children}
				{entries.length === 0 && <span className="icon-editor-empty">{t("uiIconEditDropHere")}</span>}
			</div>
		);
	};

	return (
		<>
			<div className="icon-editor-backdrop" onClick={onClose} />
			<div className="icon-editor" role="dialog" aria-modal="true" aria-label={t("uiIconEditTitle")}>
				<div className="icon-editor-head">
					<span className="icon-editor-title">{t("uiIconEditTitle")}</span>
					<span className="icon-editor-hint">{t("uiIconEditHint")}</span>
					<button
						type="button"
						className="icon-editor-close"
						onClick={onClose}
						aria-label={t("close")}
						title={t("close")}
					>
						<FiX />
					</button>
				</div>
				<div className="icon-editor-body">
					{ICON_EDIT_ZONES.map((zone) => {
						const zoneEntries = buckets.zones[zone.slot] ?? [];
						const visible = visibleZoneEntries(zoneEntries);
						return (
							<div className="icon-editor-zone" key={zone.slot}>
								<div className="icon-editor-zone-title">
									{t(zone.labelKey as Parameters<typeof t>[0])}
									{dragId && <span className="icon-editor-zone-count">{visible.length}</span>}
								</div>
								{zone.alignable
									? ICON_EDIT_ALIGNS.map((al) =>
											renderStrip(
												zone.slot,
												al,
												zone.vertical ? sideAlignLabel(t, al) : al,
												zoneEntriesForAlign(zoneEntries, al),
											),
										)
									: renderStrip(zone.slot, undefined, null, visible)}
							</div>
						);
					})}
					<div className="icon-editor-zone icon-editor-zone-tray">
						<div className="icon-editor-zone-title">
							{t("uiIconEditTray")}
							<span className="icon-editor-zone-count">{buckets.tray.length}</span>
						</div>
						{renderStrip(ICON_EDIT_TRAY, undefined, null, buckets.tray)}
					</div>
				</div>
			</div>
		</>
	);
}
