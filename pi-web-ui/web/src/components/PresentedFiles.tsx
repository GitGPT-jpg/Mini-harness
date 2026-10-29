import { memo, useEffect, useMemo, useState } from "react";
import { FiCopy, FiDownload, FiExternalLink, FiEye, FiFolder } from "react-icons/fi";
import { useT } from "../i18n";
import { appSend } from "../app-globals";
import { DOWNLOAD_FILE_NOT_FOUND, downloadFile, downloadUrl } from "../download";
import { isFilePreviewOpen, openFilePreview } from "../file-preview-bridge";
import {
	focusPresentItem,
	formatPresentSize,
	inlineMediaKind,
	presentCardItems,
	presentKindIcon,
	presentNote,
	presentTitle,
	previewablePresentKind,
	type PresentArgs,
	type PresentCardItem,
} from "../present-items";
import { takeAutoOpen, usePresentAutoOpen } from "../present-settings";
import { Markdown } from "./Markdown";
import { useCopyFeedback } from "../use-copy-feedback";

/**
 * present_files 工具的卡片正文。
 *
 * 数据来自两处（见 present-items.ts）：工具参数（一定在）+ 工具结果 details
 * （更准，可能缺）。渲染规则：
 *   - 图片 <img>、视频 <video controls>、音频 <audio controls> 直接在卡片里
 *     播/看（用户说的「图片视频等直接看」），点媒体本体 = 打开预览弹窗（大图
 *     与缩放都在那边）；
 *   - 文本类给开头摘录（服务端读的头 1200 字符），整份内容点「预览」；
 *   - 每行都有「预览 / 本地打开 / 在文件夹中显示 / 下载 / 复制路径」——
 *     「本地打开」「在文件夹中显示」与右栏文件树右键菜单**同一套协议**
 *     （file_open_default / file_reveal，下载走 /api/file?download=1），
 *     服务器在别的机器上时由服务端回 notice 报错；
 *   - 路径不存在（服务端 stat 失败）→ 红字提示，不给动作按钮。
 *
 * 自动打开预览弹窗（AI 标了 focus: true 的条目）走 present-settings 的三道闸：
 * 用户开了开关、卡片是刚发生的、这个 toolCallId 没开过。
 */
interface PresentedFilesProps {
	args: PresentArgs;
	/** 工具结果 details（可能缺失/被体积闸门丢掉）。 */
	details?: unknown;
	/** 自动打开去重用的 toolCallId（工具结果消息的 toolCallId）。 */
	toolCallId: string;
	/** 工具结果时间戳：判断卡片是不是「刚发生」。 */
	resultTimestamp?: number;
}

export const PresentedFiles = memo(function PresentedFiles({
	args,
	details,
	toolCallId,
	resultTimestamp,
}: PresentedFilesProps) {
	const t = useT();
	const autoOpen = usePresentAutoOpen();
	const items = useMemo(() => presentCardItems(args, details), [args, details]);
	const title = presentTitle(args, details);
	const note = presentNote(args, details);
	const focus = useMemo(() => focusPresentItem(items), [items]);

	useEffect(() => {
		if (!autoOpen || !focus || !toolCallId) return;
		// 用户已经自己开着预览弹窗时不抢（只开一次、且只对刚发生的卡片）。
		if (isFilePreviewOpen()) return;
		if (!takeAutoOpen(toolCallId, resultTimestamp)) return;
		openFilePreview({ path: focus.target, name: focus.name });
	}, [autoOpen, focus, toolCallId, resultTimestamp]);

	if (items.length === 0) {
		return <div className="present-empty">{t("presentEmpty")}</div>;
	}

	return (
		<div className="present-card">
			{title && <div className="present-title">{title}</div>}
			{note && (
				<div className="present-note">
					<Markdown text={note} rawHtml />
				</div>
			)}
			<div className="present-items">
				{items.map((item) => (
					<PresentRow key={`${item.target}\u0000${item.path}`} item={item} />
				))}
			</div>
		</div>
	);
});

/** 文件名悬浮提示：路径 + 修改时间（有的话）。 */
function itemTitle(item: PresentCardItem): string {
	if (typeof item.mtime !== "number") return item.path;
	return `${item.path}\n${new Date(item.mtime).toLocaleString()}`;
}

/** 单行：文件头（图标/名字/说明/体积 + 动作）+ 媒体或摘录。 */
function PresentRow({ item }: { item: PresentCardItem }) {
	const t = useT();
	const { copied, copy } = useCopyFeedback({ duration: 1200 });
	const [mediaFailed, setMediaFailed] = useState(false);
	const [downloadError, setDownloadError] = useState("");

	const media = mediaFailed ? null : inlineMediaKind(item.kind);
	const size = formatPresentSize(item.size);
	const missing = item.kind === "missing";
	const target = { path: item.target, name: item.name };

	const copyPath = () => {
		void copy(item.path);
	};

	const download = () => {
		setDownloadError("");
		void downloadFile(item.target, item.name).then((r) => {
			if (r.ok || r.cancelled) return;
			setDownloadError(r.error === DOWNLOAD_FILE_NOT_FOUND ? t("fileNotFoundShort") : r.error);
		});
	};

	return (
		<div className={`present-item${missing ? " missing" : ""}`}>
			<div className="present-item-head">
				<span className="present-item-icon" aria-hidden="true">
					{presentKindIcon(item.kind)}
				</span>
				<span className="present-item-name" title={itemTitle(item)}>
					{item.name}
				</span>
				{item.caption && <span className="present-item-caption">{item.caption}</span>}
				{size && !missing && <span className="present-item-meta">{size}</span>}
				<span className="present-item-spacer" />
				{!missing && (
					<>
						{previewablePresentKind(item.kind) && (
							<button
								type="button"
								className="present-btn"
								title={t("previewFile")}
								aria-label={t("previewFile")}
								onClick={() => openFilePreview(target)}
							>
								<FiEye />
							</button>
						)}
						<button
							type="button"
							className="present-btn labeled"
							title={t("fileOpenDefault")}
							onClick={() => appSend({ type: "file_open_default", path: item.target })}
						>
							<FiExternalLink />
							<span>{t("presentOpenLocal")}</span>
						</button>
						<button
							type="button"
							className="present-btn"
							title={t("fileReveal")}
							aria-label={t("fileReveal")}
							onClick={() => appSend({ type: "file_reveal", path: item.target })}
						>
							<FiFolder />
						</button>
						<button
							type="button"
							className="present-btn"
							title={t("downloadFile")}
							aria-label={t("downloadFile")}
							onClick={download}
						>
							<FiDownload />
						</button>
						<button
							type="button"
							className={`present-btn${copied ? " on" : ""}`}
							title={t("copyPath")}
							aria-label={t("copyPath")}
							onClick={copyPath}
						>
							<FiCopy />
						</button>
					</>
				)}
			</div>

			{missing && <div className="present-item-warn">{t("presentMissing")}</div>}
			{downloadError && <div className="present-item-warn">{t("downloadFailed", { error: downloadError })}</div>}

			{media === "image" && (
				<button
					type="button"
					className="present-media"
					title={t("previewFile")}
					onClick={() => openFilePreview(target)}
				>
					<img
						src={downloadUrl(item.target, false)}
						alt={item.name}
						loading="lazy"
						onError={() => setMediaFailed(true)}
					/>
				</button>
			)}
			{media === "video" && (
				<video
					className="present-media-video"
					src={downloadUrl(item.target, false)}
					controls
					preload="metadata"
					onError={() => setMediaFailed(true)}
				/>
			)}
			{media === "audio" && (
				<audio
					className="present-media-audio"
					src={downloadUrl(item.target, false)}
					controls
					preload="metadata"
					onError={() => setMediaFailed(true)}
				/>
			)}

			{item.excerpt && (
				<pre className="present-excerpt">
					{item.excerpt}
					{item.excerptTruncated ? "…" : ""}
				</pre>
			)}
		</div>
	);
}
