import React, { useState, useEffect, useRef, useCallback } from "react";
import type { PptxSlidePayload, PptxSlideImagePayload } from "../types";
import { Markdown } from "./Markdown";
import { appUrl } from "../base-url";
import {
	FiChevronLeft,
	FiChevronRight,
	FiMaximize,
	FiMinimize,
	FiList,
	FiFileText,
	FiLayout,
	FiImage,
	FiX,
} from "react-icons/fi";

export interface PptViewerProps {
	file: { path: string; name: string };
	slides: PptxSlidePayload[];
	rawMarkdown: string;
}

export function PptViewer({ file, slides, rawMarkdown }: PptViewerProps) {
	const [mode, setMode] = useState<"slide" | "deck" | "outline">("slide");
	const [current, setCurrent] = useState(1);
	const [showNotes, setShowNotes] = useState(true);
	const [showThumbnails, setShowThumbnails] = useState(true);
	const [lightboxImage, setLightboxImage] = useState<PptxSlideImagePayload | null>(null);
	const [isFullscreen, setIsFullscreen] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);
	const thumbnailsRef = useRef<HTMLDivElement>(null);

	const total = slides.length;
	const slide = slides[Math.max(0, Math.min(slides.length - 1, current - 1))] ?? slides[0];

	// 键盘快捷键翻页
	const handleKeyDown = useCallback(
		(e: KeyboardEvent) => {
			if (mode !== "slide") return;
			if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

			if (e.key === "ArrowLeft" || e.key === "PageUp") {
				e.preventDefault();
				setCurrent((p) => Math.max(1, p - 1));
			} else if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
				e.preventDefault();
				setCurrent((p) => Math.min(total, p + 1));
			} else if (e.key === "Home") {
				e.preventDefault();
				setCurrent(1);
			} else if (e.key === "End") {
				e.preventDefault();
				setCurrent(total);
			} else if (e.key.toLowerCase() === "f") {
				e.preventDefault();
				toggleFullscreen();
			}
		},
		[mode, total],
	);

	useEffect(() => {
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [handleKeyDown]);

	// 切换页码时，自动将左侧缩略图滚动到视口中央
	useEffect(() => {
		if (mode !== "slide" || !showThumbnails || !thumbnailsRef.current) return;
		const thumb = thumbnailsRef.current.querySelector(`[data-thumb-index="${current}"]`);
		if (thumb && typeof (thumb as HTMLElement).scrollIntoView === "function") {
			(thumb as HTMLElement).scrollIntoView({ behavior: "smooth", block: "nearest" });
		}
	}, [current, mode, showThumbnails]);

	const toggleFullscreen = () => {
		if (!containerRef.current) return;
		if (!document.fullscreenElement) {
			containerRef.current
				.requestFullscreen()
				.then(() => setIsFullscreen(true))
				.catch(() => {});
		} else {
			document
				.exitFullscreen()
				.then(() => setIsFullscreen(false))
				.catch(() => {});
		}
	};

	useEffect(() => {
		const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
		document.addEventListener("fullscreenchange", onFsChange);
		return () => document.removeEventListener("fullscreenchange", onFsChange);
	}, []);

	const mediaUrl = (mediaName: string) => {
		return appUrl(`/api/office-media?path=${encodeURIComponent(file.path)}&media=${encodeURIComponent(mediaName)}`);
	};

	if (!slides || slides.length === 0) {
		return <div className="fp-empty">暂无幻灯片数据</div>;
	}

	return (
		<div className={`ppt-viewer ${isFullscreen ? "fullscreen" : ""}`} ref={containerRef}>
			{/* 顶部控制栏 */}
			<div className="ppt-toolbar">
				<div className="ppt-toolbar-group">
					<button
						type="button"
						className={`ppt-btn ${mode === "slide" ? "active" : ""}`}
						onClick={() => setMode("slide")}
						title="单页放映模式（按左右键翻页）"
					>
						<FiLayout /> 单页放映
					</button>
					<button
						type="button"
						className={`ppt-btn ${mode === "deck" ? "active" : ""}`}
						onClick={() => setMode("deck")}
						title="全部卡片流式滚动"
					>
						<FiFileText /> 连续平铺
					</button>
					<button
						type="button"
						className={`ppt-btn ${mode === "outline" ? "active" : ""}`}
						onClick={() => setMode("outline")}
						title="文本大纲视图（方便一键复制全文）"
					>
						<FiList /> 文本大纲
					</button>
				</div>

				{mode === "slide" && (
					<div className="ppt-toolbar-group ppt-nav-group">
						<button
							type="button"
							className={`ppt-btn ppt-btn-icon ${showThumbnails ? "active" : ""}`}
							onClick={() => setShowThumbnails((v) => !v)}
							title="显示/隐藏左侧缩略图导航"
						>
							<FiList />
						</button>
						<button
							type="button"
							className="ppt-btn ppt-btn-icon"
							disabled={current <= 1}
							onClick={() => setCurrent((p) => Math.max(1, p - 1))}
							title="上一页（←）"
						>
							<FiChevronLeft />
						</button>
						<span className="ppt-page-indicator">
							<input
								type="number"
								min={1}
								max={total}
								value={current}
								onChange={(e) => {
									const v = parseInt(e.target.value, 10);
									if (!isNaN(v) && v >= 1 && v <= total) setCurrent(v);
								}}
								className="ppt-page-input"
							/>
							<span className="ppt-page-total">/ {total}</span>
						</span>
						<button
							type="button"
							className="ppt-btn ppt-btn-icon"
							disabled={current >= total}
							onClick={() => setCurrent((p) => Math.min(total, p + 1))}
							title="下一页（→ / 空格）"
						>
							<FiChevronRight />
						</button>
					</div>
				)}

				<div className="ppt-toolbar-group">
					<button
						type="button"
						className={`ppt-btn ${showNotes ? "active" : ""}`}
						onClick={() => setShowNotes((v) => !v)}
						title="展开/收起演讲者备注提词器"
					>
						📝 备注
					</button>
					<button
						type="button"
						className="ppt-btn ppt-btn-icon"
						onClick={toggleFullscreen}
						title={isFullscreen ? "退出全屏" : "全屏放映（F键）"}
					>
						{isFullscreen ? <FiMinimize /> : <FiMaximize />}
					</button>
				</div>
			</div>

			{/* 主视图区 */}
			<div className="ppt-workspace">
				{mode === "outline" ? (
					/* 文本大纲视图：保留原有 Markdown 排版，方便快速复制/阅读全文 */
					<div className="ppt-outline-view fp-markdown msg-text fp-office">
						<Markdown text={rawMarkdown} />
					</div>
				) : (
					<div className="ppt-stage-layout">
						{/* 左侧幻灯片缩略大纲栏 */}
						{mode === "slide" && showThumbnails && (
							<aside className="ppt-thumbnails" ref={thumbnailsRef}>
								{slides.map((s) => (
									<div
										key={s.index}
										data-thumb-index={s.index}
										className={`ppt-thumb-card ${s.index === current ? "active" : ""}`}
										onClick={() => setCurrent(s.index)}
									>
										<div className="ppt-thumb-num">{s.index}</div>
										<div className="ppt-thumb-content">
											<div className="ppt-thumb-title">{s.title || `幻灯片 ${s.index}`}</div>
											<div className="ppt-thumb-badges">
												{s.images && s.images.length > 0 && (
													<span title={`${s.images.length} 张图片`}>🖼️ {s.images.length}</span>
												)}
												{s.tables && s.tables.length > 0 && <span title={`${s.tables.length} 张表格`}>📊</span>}
												{s.notes && <span title="包含演讲者备注">📝</span>}
											</div>
										</div>
									</div>
								))}
							</aside>
						)}

						{/* 幻灯片主舞台 */}
						<main className={`ppt-stage-wrap ${mode === "deck" ? "deck-mode" : ""}`}>
							{mode === "slide" ? (
								/* 单页放映模式 */
								<div className="ppt-slide-container">
									<SlideCard
										slide={slide}
										total={total}
										showNotes={showNotes}
										onImageClick={(img) => setLightboxImage(img)}
										mediaUrl={mediaUrl}
									/>
								</div>
							) : (
								/* 全部平铺连续滚动模式 */
								<div className="ppt-deck-list">
									{slides.map((s) => (
										<div key={s.index} className="ppt-deck-item">
											<SlideCard
												slide={s}
												total={total}
												showNotes={showNotes}
												onImageClick={(img) => setLightboxImage(img)}
												mediaUrl={mediaUrl}
											/>
										</div>
									))}
								</div>
							)}
						</main>
					</div>
				)}
			</div>

			{/* 图片大图灯箱 */}
			{lightboxImage && (
				<div className="ppt-lightbox" onClick={() => setLightboxImage(null)}>
					<div className="ppt-lightbox-dialog" onClick={(e) => e.stopPropagation()}>
						<div className="ppt-lightbox-header">
							<span>{lightboxImage.descr || lightboxImage.name || lightboxImage.media}</span>
							<button type="button" className="ppt-lightbox-close" onClick={() => setLightboxImage(null)}>
								<FiX />
							</button>
						</div>
						<div className="ppt-lightbox-body">
							<img src={mediaUrl(lightboxImage.media)} alt={lightboxImage.descr || lightboxImage.media} />
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

/** 单张 PPT 幻灯片渲染卡片（16:9 标准比例） */
interface SlideCardProps {
	slide: PptxSlidePayload;
	total: number;
	showNotes: boolean;
	onImageClick: (img: PptxSlideImagePayload) => void;
	mediaUrl: (media: string) => string;
}

function SlideCard({ slide, total, showNotes, onImageClick, mediaUrl }: SlideCardProps) {
	const isCover = slide.index === 1 && !slide.images?.length;
	const bgStyle = slide.bg ? { backgroundColor: slide.bg } : undefined;

	return (
		<div className="ppt-slide-card-wrap">
			<div className={`ppt-slide-card ${isCover ? "is-cover" : ""}`} style={bgStyle}>
				{/* 幻灯片顶部标头 */}
				<header className="ppt-card-header">
					{slide.subtitle && <div className="ppt-card-badge">{slide.subtitle}</div>}
					<h2 className="ppt-card-title">{slide.title || `幻灯片 ${slide.index}`}</h2>
				</header>

				{/* 幻灯片正文主区域 */}
				<div className="ppt-card-body">
					{/* 图片展示区：河北环卫平台的 ER 图、系统实拍图等在此呈现 */}
					{slide.images && slide.images.length > 0 && (
						<div className={`ppt-card-images ${slide.images.length > 1 ? "grid" : "single"}`}>
							{slide.images.map((img, idx) => (
								<figure key={idx} className="ppt-img-figure" onClick={() => onImageClick(img)}>
									<div className="ppt-img-wrapper">
										<img src={mediaUrl(img.media)} alt={img.descr || img.media} loading="lazy" />
										<div className="ppt-img-zoom-hint">
											<FiImage /> 点击放大
										</div>
									</div>
									{img.descr && <figcaption className="ppt-img-caption">{img.descr}</figcaption>}
								</figure>
							))}
						</div>
					)}

					{/* 文本列表与段落 */}
					{slide.paragraphs && slide.paragraphs.length > 0 && (
						<div className="ppt-card-text">
							{slide.paragraphs.map((p, idx) => {
								const isBullet = p.startsWith("- ");
								if (isBullet) {
									// 计算缩进层级
									const indentLevel = (p.match(/^\s*/)?.[0].length ?? 0) / 2;
									const clean = p.replace(/^[\s-]+\s*/, "");
									return (
										<div
											key={idx}
											className={`ppt-bullet-item lvl-${Math.min(indentLevel, 3)}`}
											style={{ paddingLeft: `${indentLevel * 1.4 + 1.2}em` }}
										>
											<span className="ppt-bullet-dot" />
											<span className="ppt-bullet-text">{clean}</span>
										</div>
									);
								}
								return (
									<p key={idx} className="ppt-para">
										{p}
									</p>
								);
							})}
						</div>
					)}

					{/* 表格数据 */}
					{slide.tables && slide.tables.length > 0 && (
						<div className="ppt-card-tables">
							{slide.tables.map((table, tIdx) => (
								<div key={tIdx} className="ppt-table-wrap">
									<table className="ppt-table">
										<tbody>
											{table.map((row, rIdx) => (
												<tr key={rIdx} className={rIdx === 0 ? "ppt-tr-head" : "ppt-tr-body"}>
													{row.map((cell, cIdx) =>
														rIdx === 0 ? <th key={cIdx}>{cell}</th> : <td key={cIdx}>{cell}</td>,
													)}
												</tr>
											))}
										</tbody>
									</table>
								</div>
							))}
						</div>
					)}
				</div>

				{/* 幻灯片右下角页码 */}
				<footer className="ppt-card-footer">
					<span className="ppt-card-pagenum">
						{slide.index} / {total}
					</span>
				</footer>
			</div>

			{/* 演讲者备注栏：抽屉式展示在幻灯片下方，保证不污染幻灯片画面 */}
			{showNotes && slide.notes && (
				<div className="ppt-notes-drawer">
					<div className="ppt-notes-header">
						<span className="ppt-notes-icon">💡</span>
						<span className="ppt-notes-title">演讲者备注 / 提词</span>
					</div>
					<div className="ppt-notes-body">{slide.notes}</div>
				</div>
			)}
		</div>
	);
}
