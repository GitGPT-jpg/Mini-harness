import {
	useEffect,
	useRef,
	useState,
	type ButtonHTMLAttributes,
	type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { FiHelpCircle } from "react-icons/fi";
import { computeTipPosition } from "../tip-position";

function useInstantTip<T extends HTMLElement>(text: string) {
	const anchorRef = useRef<T>(null);
	const bubbleRef = useRef<HTMLSpanElement>(null);
	const [open, setOpen] = useState(false);
	const [pos, setPos] = useState({ left: 0, top: 0 });

	const show = () => {
		const r = anchorRef.current?.getBoundingClientRect();
		if (!r) return;
		// 先按向下展开摆位，实测尺寸后再翻转（见下 effect；文本长度不定估算不可靠）。
		setPos({ left: Math.max(8, r.left - 8), top: r.bottom + 8 });
		setOpen(true);
	};
	const hide = () => setOpen(false);

	// 打开后实测气泡尺寸再翻转/钳制。
	useEffect(() => {
		if (!open) return;
		const b = bubbleRef.current;
		const a = anchorRef.current;
		if (!b || !a) return;
		const r = b.getBoundingClientRect();
		const ar = a.getBoundingClientRect();
		const next = computeTipPosition(ar, r, { width: window.innerWidth, height: window.innerHeight });
		setPos((prev) => (prev.left === next.left && prev.top === next.top ? prev : next));
	}, [open, text]);

	// 打开期间滚动/缩放 → 跟随锚点重算位置（rAF 节流），不收起；
	// 锚点滚出视口才收起。Esc/失焦的收起走下面的 onMouseLeave/onBlur。
	useEffect(() => {
		if (!open) return;
		let raf = 0;
		const reposition = () => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(() => {
				const a = anchorRef.current;
				const b = bubbleRef.current;
				if (!a || !b) return;
				const ar = a.getBoundingClientRect();
				if (ar.bottom < 0 || ar.top > window.innerHeight || ar.right < 0 || ar.left > window.innerWidth) {
					setOpen(false);
					return;
				}
				const r = b.getBoundingClientRect();
				const next = computeTipPosition(ar, r, { width: window.innerWidth, height: window.innerHeight });
				setPos((prev) => (prev.left === next.left && prev.top === next.top ? prev : next));
			});
		};
		window.addEventListener("scroll", reposition, true);
		window.addEventListener("resize", reposition);
		return () => {
			cancelAnimationFrame(raf);
			window.removeEventListener("scroll", reposition, true);
			window.removeEventListener("resize", reposition);
		};
	}, [open]);

	const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
		if (e.key === "Escape") (e.target as HTMLElement).blur();
	};

	const tipPortal =
		open &&
		createPortal(
			<span
				ref={bubbleRef}
				className="set-tip-bubble open"
				role="tooltip"
				style={{ position: "fixed", left: pos.left, top: pos.top }}
			>
				{text}
			</span>,
			document.body,
		);

	return { anchorRef, show, hide, onKeyDown, tipPortal };
}

/**
 * 「？」悬浮提示（共享组件）：长解释默认不占版面，hover / 键盘聚焦时浮出全文。
 *
 * 顶层渲染：portal 到 document.body + fixed 定位，不受滚动容器 overflow 裁剪
 * （以前是 absolute 下挂在行内，贴底部的行气泡会被 modal-body 裁掉看不见）。
 * 打开后实测气泡尺寸：右侧/下侧空间不足自动翻转（左展/上展），四边钳制在视口内。
 * 滚动/缩放不收起 —— 跟随锚点重算位置（rAF 节流）；只有锚点滚出视口才收起
 * （指着空气的气泡没有意义）。Esc/失焦仍即时收起。
 */
export function HintTip({ text }: { text: string }) {
	const { anchorRef, show, hide, onKeyDown, tipPortal } = useInstantTip<HTMLSpanElement>(text);

	return (
		<span
			ref={anchorRef}
			className="set-tip"
			tabIndex={0}
			aria-label={text}
			onMouseEnter={show}
			onMouseLeave={hide}
			onFocus={show}
			onBlur={hide}
			onKeyDown={onKeyDown}
		>
			<FiHelpCircle />
			{tipPortal}
		</span>
	);
}

/**
 * 悬浮/聚焦立即弹出提示气泡的按钮（替代原生 `title` 的 500ms+ 延迟）。
 */
export function TipButton({
	tip,
	children,
	onMouseEnter,
	onMouseLeave,
	onFocus,
	onBlur,
	onKeyDown,
	...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { tip: string }) {
	const { anchorRef, show, hide, onKeyDown: handleKeyDown, tipPortal } = useInstantTip<HTMLButtonElement>(tip);

	return (
		<button
			ref={anchorRef}
			type="button"
			aria-label={rest["aria-label"] ?? tip}
			{...rest}
			onMouseEnter={(e) => {
				show();
				onMouseEnter?.(e);
			}}
			onMouseLeave={(e) => {
				hide();
				onMouseLeave?.(e);
			}}
			onFocus={(e) => {
				show();
				onFocus?.(e);
			}}
			onBlur={(e) => {
				hide();
				onBlur?.(e);
			}}
			onKeyDown={(e) => {
				handleKeyDown(e);
				onKeyDown?.(e);
			}}
		>
			{children}
			{tipPortal}
		</button>
	);
}
