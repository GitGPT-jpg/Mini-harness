import { memo } from "react";
import { FiAlertCircle, FiAlertTriangle, FiCheckCircle, FiHelpCircle, FiInfo, FiX } from "react-icons/fi";
import { dismissBanner, useBanners, type BannerNotice, type BannerType } from "../banner-notice";
import { useT } from "../i18n";

function BannerIcon({ type }: { type?: BannerType }) {
	switch (type) {
		case "question":
			return <FiHelpCircle className="banner-icon banner-icon-question" />;
		case "warning":
			return <FiAlertTriangle className="banner-icon banner-icon-warning" />;
		case "error":
			return <FiAlertCircle className="banner-icon banner-icon-error" />;
		case "success":
			return <FiCheckCircle className="banner-icon banner-icon-success" />;
		case "info":
		default:
			return <FiInfo className="banner-icon banner-icon-info" />;
	}
}

const BannerCard = memo(function BannerCard({ banner }: { banner: BannerNotice }) {
	const t = useT();
	const hasAction = typeof banner.onClick === "function";

	return (
		<div
			className={`banner-card banner-type-${banner.type || "info"} ${hasAction ? "banner-clickable" : ""}`}
			onClick={hasAction ? banner.onClick : undefined}
			role={hasAction ? "button" : "status"}
			tabIndex={hasAction ? 0 : undefined}
			onKeyDown={
				hasAction
					? (e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								banner.onClick?.();
							}
						}
					: undefined
			}
		>
			<div className="banner-icon-col">
				<BannerIcon type={banner.type} />
			</div>
			<div className="banner-content-col">
				{banner.title && (
					<div className="banner-title" title={banner.title}>
						{banner.title}
					</div>
				)}
				<div className="banner-message" title={banner.message}>
					{banner.message}
				</div>
			</div>
			{banner.dismissible && (
				<button
					type="button"
					className="banner-close"
					onClick={(e) => {
						e.stopPropagation();
						dismissBanner(banner.id);
					}}
					aria-label="Close banner"
					title={t("close")}
				>
					<FiX />
				</button>
			)}
		</div>
	);
});

export const BannerContainer = memo(function BannerContainer() {
	const banners = useBanners();

	if (banners.length === 0) return null;

	return (
		<aside className="banner-container" aria-label="Notifications">
			{banners.map((b) => (
				<BannerCard key={b.id} banner={b} />
			))}
		</aside>
	);
});
