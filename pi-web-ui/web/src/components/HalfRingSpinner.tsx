import type { SVGProps } from "react";

/**
 * 半圆环转动等待指示器（Half-Ring Spinner）。
 *
 * 采用 180° 半圆弧结合圆润端点（round linecap），平滑旋转无卡顿，
 * 取代传统辐射状多短线菊花（FiLoader）或双箭头，呈现现代极简高级质感。
 */
export function HalfRingSpinner({ className, width = "1em", height = "1em", ...props }: SVGProps<SVGSVGElement>) {
	const cls = ["half-ring-spin", className].filter(Boolean).join(" ");
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			width={width}
			height={height}
			className={cls}
			aria-hidden="true"
			{...props}
		>
			<path d="M 12 2 A 10 10 0 0 1 12 22" />
		</svg>
	);
}
