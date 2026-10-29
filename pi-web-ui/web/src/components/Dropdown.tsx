import {
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type CSSProperties,
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
	type Ref,
} from "react";
import { createPortal } from "react-dom";
import { FiChevronDown } from "react-icons/fi";
import { useClickOutside } from "../use-click-outside";
import { useEscapeKey } from "../shortcut-stack";

interface DropdownProps {
	/** The clickable trigger (chip/button). */
	trigger: ReactNode;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	children: ReactNode;
	/** Align the menu edge with the trigger's edge (default right, since the
	 * toolbar sits at the top-right of the window). */
	align?: "left" | "right";
	/** Let the menu grow to fit its content instead of capping at the default
	 * max-height with a scrollbar (e.g. small fixed panels like the update
	 * dropdown). */
	fit?: boolean;
	/** Which side of the trigger the menu opens on. "down" (default) drops below;
	 * "up" floats above it; "left" / "right" pop to the side (e.g. for side docks). */
	direction?: "down" | "up" | "left" | "right";
	/** 是否将下拉菜单 portal 到 document.body（彻底脱离父级 overflow 截断与包含块约束，默认 true） */
	portal?: boolean;
	/** 即时说明（只有 data-tip：顶栏本体 hover 立刻出气泡，见 styles.css；
	 *  不再挂 title，免得原生延迟提示跟气泡叠两层。
	 *  搬进 ⋯ 溢出菜单的同款节点退回原生 title（portal 纵向滚动会裁掉气泡）。 */
	tip?: string;
	/** Extra class(es) for the .dd-menu panel itself (e.g. "dd-menu-model"
	 * makes only the inner scroll band scroll, keeping header/footer fixed). */
	menuClassName?: string;
	/** Ref to the menu panel (for measuring/sizing it). */
	menuRef?: Ref<HTMLDivElement>;
	/** Custom class for the outer dropdown container (default undefined). */
	className?: string;
	/** Custom class for the trigger button (default "chip"). */
	triggerClassName?: string;
	/** Optional contextmenu handler for the trigger button (e.g. BarItem layout menu). */
	onContextMenu?: (e: ReactMouseEvent<HTMLElement>) => void;
	/** Optional data-bar-item attribute for the trigger button. */
	dataBarItem?: string;
	/** Whether to render the trailing dropdown caret arrow (default true). */
	caret?: boolean;
	/** Inline style for the menu panel — used to LOCK a measured width/height
	 * so the panel doesn't resize as its content changes (e.g. filtering). */
	menuStyle?: CSSProperties;
}

interface DropdownShiftParams {
	align: "left" | "right";
	triggerLeft: number;
	triggerRight: number;
	menuWidth: number;
	viewportWidth: number;
	margin?: number;
}

/**
 * 计算 Dropdown 菜单在桌面端视口内的水平平移量（防溢出截断）。
 *
 * 保证菜单左右两侧均保留 `margin` 间距；当菜单宽度大于可用视口时，优先保证左侧在视野内。
 */
export function computeDropdownShift({
	align,
	triggerLeft,
	triggerRight,
	menuWidth,
	viewportWidth,
	margin = 8,
}: DropdownShiftParams): number {
	if (menuWidth <= 0 || viewportWidth <= 0) return 0;
	// 自然无平移位置：由触发器容器与对齐方向决定
	const naturalLeft = align === "left" ? triggerLeft : triggerRight - menuWidth;
	// 计算理想的视口 left：两边留 margin，且左侧优先（maxLeft < margin 时取 margin）
	const maxLeft = Math.max(margin, viewportWidth - margin - menuWidth);
	const clampedLeft = Math.max(margin, Math.min(naturalLeft, maxLeft));
	return Math.round(clampedLeft - naturalLeft);
}

export interface PortalDropdownParams {
	triggerRect: { left: number; right: number; top: number; bottom: number };
	menuWidth: number;
	menuHeight: number;
	viewportWidth: number;
	viewportHeight: number;
	direction?: "down" | "up" | "left" | "right";
	align?: "left" | "right";
	gap?: number;
	margin?: number;
}

/**
 * 纯函数：计算 Portal 模式下下拉菜单在视口内的固定定位坐标（position: fixed）。
 *
 * 支持 4 个展开方向：
 * - right: 靠右侧弹出（左侧停靠栏），右侧不足时自动翻转到左侧，垂直与触发器平齐并贴底钳制；
 * - left: 靠左侧弹出（右侧停靠栏），左侧不足时自动翻转到右侧，垂直与触发器平齐并贴底钳制；
 * - up: 向上方弹出（底栏），上方不足时自动翻转到下方；
 * - down: 向下方弹出（顶栏），下方不足时自动翻转到上方。
 */
export function computePortalDropdownPosition({
	triggerRect,
	menuWidth,
	menuHeight,
	viewportWidth,
	viewportHeight,
	direction = "down",
	align = "right",
	gap = 6,
	margin = 8,
}: PortalDropdownParams): { left: number; top: number; maxHeight?: number } {
	if (menuWidth <= 0 || viewportWidth <= 0 || viewportHeight <= 0) {
		return { left: Math.round(triggerRect.left), top: Math.round(triggerRect.bottom + gap) };
	}

	const maxLeft = Math.max(margin, viewportWidth - margin - menuWidth);
	const maxTop = Math.max(margin, viewportHeight - margin - menuHeight);

	let left = margin;
	let top = margin;
	let maxHeight: number | undefined;

	const spaceAbove = Math.max(0, triggerRect.top - gap - margin);
	const spaceBelow = Math.max(0, viewportHeight - triggerRect.bottom - gap - margin);

	if (direction === "right") {
		// 向右展开（左侧停靠栏）：默认挂在触发器右侧
		left = triggerRect.right + gap;
		// 右侧放不下且左侧放得下时翻到左侧
		if (left + menuWidth > viewportWidth - margin && triggerRect.left - menuWidth - gap >= margin) {
			left = triggerRect.left - menuWidth - gap;
		}
		left = Math.max(margin, Math.min(left, maxLeft));

		// 垂直方向：默认与触发器顶部平齐，下方超出视口时向上贴底
		top = triggerRect.top;
		if (top + menuHeight > viewportHeight - margin) {
			top = viewportHeight - margin - menuHeight;
		}
		top = Math.max(margin, Math.min(top, maxTop));
		maxHeight = Math.max(0, viewportHeight - 2 * margin);
	} else if (direction === "left") {
		// 向左展开（右侧停靠栏）：默认挂在触发器左侧
		left = triggerRect.left - menuWidth - gap;
		// 左侧放不下且右侧放得下时翻到右侧
		if (left < margin && triggerRect.right + gap + menuWidth <= viewportWidth - margin) {
			left = triggerRect.right + gap;
		}
		left = Math.max(margin, Math.min(left, maxLeft));

		// 垂直方向：默认与触发器顶部平齐，下方超出视口时向上贴底
		top = triggerRect.top;
		if (top + menuHeight > viewportHeight - margin) {
			top = viewportHeight - margin - menuHeight;
		}
		top = Math.max(margin, Math.min(top, maxTop));
		maxHeight = Math.max(0, viewportHeight - 2 * margin);
	} else if (direction === "up") {
		// 向上展开（底栏/居中输入框）：默认挂在触发器上方
		if (spaceAbove >= menuHeight) {
			// 上方空间充足
			top = triggerRect.top - menuHeight - gap;
			maxHeight = spaceAbove;
		} else if (spaceBelow >= menuHeight) {
			// 上方不足但下方充足，翻转到下方
			top = triggerRect.bottom + gap;
			maxHeight = spaceBelow;
		} else if (spaceBelow > spaceAbove) {
			// 两边都不足以容纳原尺寸，但下方空间更大，翻转到下方并限制高度
			top = triggerRect.bottom + gap;
			maxHeight = spaceBelow;
		} else {
			// 两边都不足，上方空间更大或相等，留在上方并限制高度
			maxHeight = spaceAbove;
			top = triggerRect.top - Math.min(menuHeight, spaceAbove) - gap;
		}
		const boundedMaxTop = Math.max(margin, viewportHeight - margin - Math.min(menuHeight, maxHeight));
		top = Math.max(margin, Math.min(top, boundedMaxTop));

		// 水平方向：由 align 决定
		const naturalLeft = align === "left" ? triggerRect.left : triggerRect.right - menuWidth;
		left = Math.max(margin, Math.min(naturalLeft, maxLeft));
	} else {
		// 默认向下展开（顶栏）
		if (spaceBelow >= menuHeight) {
			// 下方空间充足
			top = triggerRect.bottom + gap;
			maxHeight = spaceBelow;
		} else if (spaceAbove >= menuHeight) {
			// 下方不足但上方充足，翻转到上方
			top = triggerRect.top - menuHeight - gap;
			maxHeight = spaceAbove;
		} else if (spaceAbove > spaceBelow) {
			// 两边都不足以容纳原尺寸，但上方空间更大，翻转到上方并限制高度
			top = triggerRect.top - Math.min(menuHeight, spaceAbove) - gap;
			maxHeight = spaceAbove;
		} else {
			// 两边都不足，下方空间更大或相等，留在下方并限制高度
			top = triggerRect.bottom + gap;
			maxHeight = spaceBelow;
		}
		const boundedMaxTop = Math.max(margin, viewportHeight - margin - Math.min(menuHeight, maxHeight));
		top = Math.max(margin, Math.min(top, boundedMaxTop));

		// 水平方向：由 align 决定
		const naturalLeft = align === "left" ? triggerRect.left : triggerRect.right - menuWidth;
		left = Math.max(margin, Math.min(naturalLeft, maxLeft));
	}

	return {
		left: Math.round(left),
		top: Math.round(top),
		...(maxHeight !== undefined ? { maxHeight: Math.round(maxHeight) } : {}),
	};
}

/** Click-outside-aware dropdown menu. */
export function Dropdown({
	trigger,
	open,
	onOpenChange,
	children,
	align = "right",
	fit = false,
	direction = "down",
	portal = false,
	tip,
	caret = true,
	menuClassName,
	triggerClassName,
	onContextMenu,
	dataBarItem,
	menuRef,
	menuStyle,
	className,
}: DropdownProps) {
	const ref = useRef<HTMLDivElement>(null);
	const internalMenuRef = useRef<HTMLDivElement | null>(null);
	const [shift, setShift] = useState(0);
	const [portalPos, setPortalPos] = useState<{ left: number; top: number; maxHeight?: number } | null>(null);

	const setMenuNode = (node: HTMLDivElement | null) => {
		internalMenuRef.current = node;
		if (typeof menuRef === "function") {
			menuRef(node);
		} else if (menuRef && "current" in menuRef) {
			(menuRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
		}
	};

	const measure = () => {
		const triggerEl = ref.current;
		const menuEl = internalMenuRef.current;
		if (!triggerEl || !menuEl) return;
		// 移动端（≤768px）由 CSS 固化为 bottom sheet（left: 12px; right: 12px; fixed），不参与水平偏移
		if (window.innerWidth <= 768) {
			if (shift !== 0) setShift(0);
			return;
		}
		const menuRect = menuEl.getBoundingClientRect();
		const triggerRect = triggerEl.getBoundingClientRect();
		// jsdom / 未挂载环境无几何尺寸，不计算偏移
		if ((triggerRect.width === 0 && triggerRect.height === 0) || menuRect.width === 0) {
			if (shift !== 0) setShift(0);
			return;
		}

		if (portal) {
			const nextPos = computePortalDropdownPosition({
				triggerRect,
				menuWidth: menuRect.width,
				menuHeight: menuRect.height,
				viewportWidth: window.innerWidth,
				viewportHeight: window.innerHeight,
				direction,
				align,
				gap: 6,
				margin: 8,
			});
			setPortalPos((prev) =>
				prev?.left === nextPos.left && prev?.top === nextPos.top && prev?.maxHeight === nextPos.maxHeight
					? prev
					: nextPos,
			);
		} else {
			const w = menuRect.width;
			const MARGIN = 8;
			const nextShift = computeDropdownShift({
				align,
				triggerLeft: triggerRect.left,
				triggerRight: triggerRect.right,
				menuWidth: w,
				viewportWidth: window.innerWidth,
				margin: MARGIN,
			});
			if (nextShift !== shift) {
				setShift(nextShift);
			}
		}
	};

	useLayoutEffect(() => {
		if (open) measure();
		else {
			if (shift !== 0) setShift(0);
			if (portalPos !== null) setPortalPos(null);
		}
	});

	useEffect(() => {
		if (!open) return;
		window.addEventListener("resize", measure);
		if (portal) {
			window.addEventListener("scroll", measure, true);
		}
		return () => {
			window.removeEventListener("resize", measure);
			if (portal) {
				window.removeEventListener("scroll", measure, true);
			}
		};
	}, [open, shift, portal, direction, align]);

	// 外部点击与触屏关闭（Portal 模式下忽略菜单自身，防止点击菜单内部被误判为点击外部）
	useClickOutside(ref, () => onOpenChange(false), { enabled: open, ignore: internalMenuRef });
	// Esc 键栈调度（优先消费，避免误关外层 Modal）
	useEscapeKey(() => onOpenChange(false), open);

	const isMobile = typeof window !== "undefined" && window.innerWidth <= 768;
	const portalStyle: CSSProperties = isMobile
		? {
				...menuStyle,
				pointerEvents: "auto",
			}
		: {
				...menuStyle,
				position: "fixed",
				left: portalPos ? `${portalPos.left}px` : "-9999px",
				top: portalPos ? `${portalPos.top}px` : "-9999px",
				maxHeight:
					portalPos?.maxHeight != null
						? menuStyle?.maxHeight != null
							? `min(${portalPos.maxHeight}px, ${menuStyle.maxHeight})`
							: `${portalPos.maxHeight}px`
						: menuStyle?.maxHeight,
				right: "auto",
				bottom: "auto",
				pointerEvents: "auto",
				visibility: portalPos ? "visible" : "hidden",
			};

	const isPortalUp =
		portalPos != null && ref.current ? portalPos.top < ref.current.getBoundingClientRect().top : direction === "up";

	return (
		<div
			className={`dropdown ${align} ${fit ? "fit" : ""} ${direction === "up" ? "dd-up" : ""} ${className ?? ""}`.trim()}
			ref={ref}
		>
			<button
				type="button"
				className={triggerClassName ?? "chip"}
				onClick={() => onOpenChange(!open)}
				onContextMenu={onContextMenu}
				aria-expanded={open}
				data-tip={tip}
				data-bar-item={dataBarItem}
			>
				{trigger}
				{caret && <FiChevronDown className={`dd-caret ${open ? "up" : ""}`} />}
			</button>
			{open &&
				(portal ? (
					createPortal(
						<div
							className={`dd-portal-wrapper dropdown ${align} ${fit ? "fit" : ""} ${isPortalUp ? "dd-up" : ""}`}
							style={{
								position: "fixed",
								left: 0,
								top: 0,
								width: "100%",
								height: "100%",
								pointerEvents: "none",
								zIndex: 9999,
							}}
						>
							<div
								className={`dd-menu ${menuClassName ?? ""}`}
								ref={setMenuNode}
								style={portalStyle}
								onPointerDown={(e) => e.stopPropagation()}
								onMouseDown={(e) => e.stopPropagation()}
								onWheel={(e) => e.stopPropagation()}
							>
								{children}
							</div>
						</div>,
						document.body,
					)
				) : (
					<div
						className={`dd-menu ${menuClassName ?? ""}`}
						ref={setMenuNode}
						onPointerDown={(e) => e.stopPropagation()}
						onMouseDown={(e) => e.stopPropagation()}
						onWheel={(e) => e.stopPropagation()}
						style={
							shift !== 0
								? {
										...menuStyle,
										transform: menuStyle?.transform
											? `${menuStyle.transform} translateX(${shift}px)`
											: `translateX(${shift}px)`,
									}
								: menuStyle
						}
					>
						{children}
					</div>
				))}
		</div>
	);
}

export function DropdownItem({
	active,
	disabled = false,
	title,
	onClick,
	children,
}: {
	active?: boolean;
	disabled?: boolean;
	/** Tooltip shown when the item is disabled (e.g. why a level is off-limits). */
	title?: string;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			className={`dd-item ${active ? "active" : ""}`}
			disabled={disabled}
			title={title}
			onClick={onClick}
		>
			{children}
		</button>
	);
}
