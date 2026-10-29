import { useRef, useState } from "react";
import { FiMonitor } from "react-icons/fi";
import { useT } from "../i18n";
import {
	PAGE_PICKER_ZIP_URL,
	compactPage,
	openExtensionOptions,
	pageCitation,
	useBrowserControl,
	type BrowserControlPage,
	type BrowserControlStatus,
} from "../browser-control";
import { composeToComposer } from "../composer-bridge";

/**
 * 顶栏的「浏览器操作」入口 + 状态面板。
 *
 * 这是**能力的发现入口**：工具与扩展做完之后，用户那边唯一的线索就是这个按钮。
 * 所以它必须回答三个问题，且不用去翻文档：
 *
 * 1. 现在什么状态？（扩展在不在 / 授权了几个页面 / 总开关开没开）
 * 2. 怎么开通？（一句话步骤 + 一个直接跳到扩展设置页的按钮）
 * 3. 能拿它干什么？（两句可照抄的例子）
 *
 * 面板里不做授权本身：`permissions.request` 要用户手势，而网页上的点击给不了 ——
 * 所以面板只负责「把人送到扩展设置页那一次点击」。
 *
 * 另外两个省事的地方（用户要求：输入网址太麻烦）：
 * - 只有一个已授权页面时，顶栏按钮**直接变成那个页面**（标题截断），点一下就把它
 *   作为「网页引用」附件放进输入框；右侧 ▾ 打开面板（状态 / 授权管理还在原处）。
 * - 面板里每个已授权页面都有一个「引用到对话」按钮 —— 多个页面时也能一键引用。
 */
export function BrowserControl() {
	const t = useT();
	const { status, refresh } = useBrowserControl();
	const [open, setOpen] = useState(false);
	/** 引用后的轻提示（引用不打开面板，得让用户知道东西去哪儿了）。 */
	const [flash, setFlash] = useState<string | null>(null);
	const flashTimer = useRef<number | null>(null);

	const pages = status?.pages ?? [];
	// 需要用户动手的情况：连上了但一个页面都没授权，或总开关被关了
	const attention = status?.available === true && (pages.length === 0 || status.aiControl === false);
	const single = compactPage(pages);

	const say = (text: string): void => {
		setFlash(text);
		if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
		flashTimer.current = window.setTimeout(() => setFlash(null), 2600);
	};

	/** 引用一个已授权页面到输入框草稿（不发送，用户补一句话再发）。 */
	const cite = (page: BrowserControlPage): void => {
		const ok = composeToComposer({ attachments: [pageCitation(page)] });
		say(ok ? t("browserControlCited") : t("browserControlCiteFailed"));
	};

	const openPanel = (): void => {
		setOpen(true);
		refresh();
	};

	return (
		<span className="bc-anchor">
			{single ? (
				<span className="browser-control-split">
					<button
						type="button"
						className={`chip browser-control single${attention ? " attention" : ""}`}
						data-tip={t("browserControlSingleTip", { name: single.title || single.origin })}
						title={t("browserControlSingleTip", { name: single.title || single.origin })}
						onClick={() => cite(single)}
					>
						<FiMonitor size={14} aria-hidden />
						<span className="bc-chip-label">{single.title || single.origin}</span>
					</button>
					<button
						type="button"
						className="chip browser-control caret"
						data-tip={t("browserControlOpenPanel")}
						title={t("browserControlOpenPanel")}
						aria-label={t("browserControlOpenPanel")}
						onClick={openPanel}
					>
						▾
					</button>
				</span>
			) : (
				<button
					type="button"
					className={`chip browser-control${attention ? " attention" : ""}`}
					data-tip={status?.error ?? (attention ? t("browserControlEmpty") : t("browserControlTip"))}
					title={status?.error ?? (attention ? t("browserControlEmpty") : t("browserControlTip"))}
					onClick={openPanel}
				>
					<FiMonitor size={14} aria-hidden />
					<span>
						{t("browserControl")}
						{pages.length > 0 ? ` · ${pages.length}` : ""}
					</span>
				</button>
			)}
			{flash && <span className="bc-flash">{flash}</span>}
			{open && <BrowserControlPanel status={status} onRefresh={refresh} onCite={cite} onClose={() => setOpen(false)} />}
		</span>
	);
}

function BrowserControlPanel({
	status,
	onRefresh,
	onCite,
	onClose,
}: {
	status: BrowserControlStatus | null;
	onRefresh: () => void;
	onCite: (page: BrowserControlPage) => void;
	onClose: () => void;
}) {
	const t = useT();
	const [busy, setBusy] = useState(false);
	const pages = status?.pages ?? [];

	const openOptions = async (): Promise<void> => {
		setBusy(true);
		try {
			const ok = await openExtensionOptions();
			if (!ok) onRefresh();
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal browser-control-modal" onClick={(e) => e.stopPropagation()}>
				<button type="button" className="modal-close" aria-label={t("close")} onClick={onClose}>
					✕
				</button>
				<div className="modal-head">
					<FiMonitor size={16} aria-hidden />
					<h2>{t("browserControl")}</h2>
				</div>
				<div className="modal-desc">{t("browserControlTip")}</div>

				{status === null && <div className="bc-note">{t("browserControlChecking")}</div>}
				{status?.available === false && !status.desktop && (
					<div className="bc-note warn">{t("browserControlOffline")}</div>
				)}
				{status?.desktop === true && (
					<>
						<div className="bc-note warn">{t("browserControlDesktop")}</div>
						<div className="bc-note">{t("browserControlDesktopLead")}</div>
						<div className="bc-actions" style={{ marginTop: 0 }}>
							<a className="btn primary" href={window.location.href} target="_blank" rel="noreferrer noopener">
								{t("browserControlOpenInBrowser")}
							</a>
						</div>
					</>
				)}
				{status?.available === false && !status.desktop && (
					<>
						<div className="bc-section">{t("browserControlInstall")}</div>
						<div className="bc-note">{t("browserControlInstallLead")}</div>
						<div className="bc-actions" style={{ marginTop: 0 }}>
							<a className="btn primary" href={PAGE_PICKER_ZIP_URL} target="_blank" rel="noreferrer noopener">
								{t("browserControlInstallDownload")}
							</a>
						</div>
						<ol className="bc-steps">
							<li>{t("browserControlInstallStep1")}</li>
							<li>{t("browserControlInstallStep2")}</li>
							<li>{t("browserControlInstallStep3")}</li>
							<li>{t("browserControlInstallStep4")}</li>
						</ol>
					</>
				)}
				{status?.available === true && status.aiControl === false && (
					<div className="bc-note warn">{t("browserControlDisabled")}</div>
				)}
				{status?.available === true && pages.length === 0 && (
					<div className="bc-note warn">{t("browserControlEmpty")}</div>
				)}

				{pages.length > 0 && (
					<>
						<div className="bc-section">{t("browserControlPages")}</div>
						<ul className="bc-pages">
							{pages.map((page) => (
								<li key={page.origin}>
									<span className="bc-title" title={page.title}>
										{page.title}
									</span>
									<span className="bc-origin" title={page.origin}>
										{page.origin}
									</span>
									<span className={`bc-open${page.open ? " on" : ""}`}>
										{page.open ? t("browserControlPageOpen") : t("browserControlPageClosed")}
									</span>
									<button
										type="button"
										className="bc-cite"
										title={t("browserControlCiteTip", { name: page.title || page.origin })}
										onClick={() => onCite(page)}
									>
										{t("browserControlCite")}
									</button>
								</li>
							))}
						</ul>
						<div className="bc-note">{t("browserControlCiteNote")}</div>
					</>
				)}

				{status?.desktop !== true && (
					<>
						<div className="bc-section">{t("browserControlExamples")}</div>
						<ul className="bc-examples">
							<li>{t("browserControlExample1")}</li>
							<li>{t("browserControlExample2")}</li>
						</ul>
					</>
				)}

				<div className="bc-actions">
					{status?.desktop !== true && (
						<button type="button" className="primary" disabled={busy} onClick={() => void openOptions()}>
							{t("browserControlOpenOptions")}
						</button>
					)}
					<button type="button" onClick={onRefresh}>
						{t("browserControlRefresh")}
					</button>
				</div>
			</div>
		</div>
	);
}
