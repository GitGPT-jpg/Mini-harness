/**
 * UniversalModelPicker.tsx — 全项目通用的模型选择菜单内容（自包含）。
 *
 * 整合原来散在三处的重复实现：
 * 1. 主对话 ModelThinking 的模型下拉菜单；
 * 2. 插件 ModelPickerModal 的模型列表；
 * 3. 目标栏 GoalBar 的两个简化模型下拉（审查者 / 执行者）。
 *
 * 统一能力：全局默认模型块、启用范围切换、刷新/管理入口、搜索过滤、
 * 服务商侧栏（含多 key）、使用次数排序、reasoning/vision 徽标。
 * 触发器（Dropdown 胶囊 / 弹窗 chrome / 空选项行）由调用方自理。
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { FiRefreshCw, FiSearch, FiSettings } from "react-icons/fi";
import type { ModelInfo, ProviderKeyInfo } from "../types";
import { DropdownItem } from "./Dropdown";
import { useT } from "../i18n";
import { loadModelUsage, sortByUsage } from "../model-usage";
import { appSend } from "../app-globals";

/** 宽松匹配模型 id：裸 id / provider/id / 后缀一致（弹窗旧逻辑口径）。 */
export function matchesModelId(m: ModelInfo, currentModelId?: string | null): boolean {
	if (!currentModelId) return false;
	return (
		currentModelId === m.id ||
		`${m.provider}/${m.id}` === currentModelId ||
		(currentModelId.includes("/") && currentModelId.split("/")[1] === m.id)
	);
}

export interface UniversalModelPickerProps {
	models: ModelInfo[];
	modelsLoading?: boolean;
	providerKeys?: Record<string, ProviderKeyInfo[]>;
	/** undefined = 不展示默认模型块与星标列（如目标栏只选执行模型时） */
	defaultModel?: string | null;
	currentModelId?: string | null;
	/** 打开信号：true 的瞬间加载使用次数并触发 onEnsureModels，false 时重置过滤态 */
	active: boolean;
	onEnsureModels: () => void;
	/** 额外的加载态（如下拉首次 list_models 未回），与 modelsLoading 取或 */
	loading?: boolean;
	onRefresh: () => void;
	onManageModels?: () => void;
	/** 行点击后的处理（菜单：set_model；弹窗：onSelect+onClose；目标栏：set_goal_prefs） */
	onPickModel: (m: ModelInfo, key: ProviderKeyInfo | null) => void;
	/** 默认模型星标可交互（主菜单）；缺省只展示（弹窗旧口径） */
	onToggleDefault?: (m: ModelInfo, isDefault: boolean) => void;
	/** 行高亮判定（缺省：id 匹配且 key 须为 active） */
	isRowActive?: (m: ModelInfo, key: ProviderKeyInfo | null) => boolean;
	/** 列表顶部额外行（如目标栏的「跟随主对话」空选项） */
	extraTopRow?: ReactNode;
	/** 滚动容器 ref（调用方做 scroll-into-view 时透传） */
	listRef?: RefObject<HTMLDivElement | null>;
	autoFocusSearch?: boolean;
	/** 隐藏「可用模型」标题（弹窗 chrome 自带标题时） */
	hideTitle?: boolean;
	/** 弹窗式布局需要时覆盖 body / 滚动区样式 */
	bodyStyle?: CSSProperties;
	scrollStyle?: CSSProperties;
}

export function UniversalModelPicker({
	models,
	modelsLoading = false,
	providerKeys = {},
	defaultModel,
	currentModelId,
	active,
	onEnsureModels,
	loading = false,
	onRefresh,
	onManageModels,
	onPickModel,
	onToggleDefault,
	isRowActive,
	extraTopRow,
	listRef,
	autoFocusSearch = false,
	hideTitle = false,
	bodyStyle,
	scrollStyle,
}: UniversalModelPickerProps) {
	const t = useT();
	const [modelFilter, setModelFilter] = useState("");
	const [providerFilter, setProviderFilter] = useState<{ provider: string; keyName: string | null } | null>(null);
	const [usage, setUsage] = useState<Record<string, number>>({});
	const [showAllModels, setShowAllModels] = useState(false);
	const ensureRef = useRef(onEnsureModels);
	ensureRef.current = onEnsureModels;

	// 打开瞬间：加载使用次数 + 确保模型列表；关闭时重置过滤态
	useEffect(() => {
		if (!active) {
			setModelFilter("");
			setProviderFilter(null);
			setShowAllModels(false);
			return;
		}
		setUsage(loadModelUsage());
		ensureRef.current();
	}, [active]);

	const enabledCount = useMemo(() => models.filter((m) => m.enabled !== false).length, [models]);
	const hasEnabledScope = models.some((m) => m.enabled === false);

	const visibleModels = useMemo(() => {
		if (!hasEnabledScope || showAllModels) return models;
		return models.filter((m) => m.enabled !== false || matchesModelId(m, currentModelId));
	}, [models, hasEnabledScope, showAllModels, currentModelId]);

	const filteredModels = useMemo(() => {
		const q = modelFilter.trim().toLowerCase();
		let base = visibleModels;
		if (providerFilter) {
			base = base.filter((m) => m.provider === providerFilter.provider);
		}
		if (!q) return sortByUsage(base, usage);
		return sortByUsage(
			base.filter(
				(m) =>
					m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q),
			),
			usage,
		);
	}, [visibleModels, modelFilter, providerFilter, usage]);

	const providerEntries = useMemo(() => {
		const counts = new Map<string, number>();
		for (const m of visibleModels) {
			counts.set(m.provider, (counts.get(m.provider) ?? 0) + 1);
		}
		const out: Array<{ provider: string; count: number; keyName: string | null }> = [];
		// Sidebar filter entries sorted by provider name (与主菜单口径一致，确定性排序）。
		for (const [provider, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
			const keys = providerKeys[provider];
			if (keys && keys.length > 1) {
				for (const k of keys) {
					out.push({ provider, count, keyName: k.name });
				}
			} else {
				out.push({ provider, count, keyName: null });
			}
		}
		return out;
	}, [visibleModels, providerKeys]);

	const displayRows = useMemo(() => {
		const rows: Array<{ model: ModelInfo; key: ProviderKeyInfo | null; active: boolean }> = [];
		for (const m of filteredModels) {
			let key: ProviderKeyInfo | null = null;
			const keys = providerKeys[m.provider];
			if (keys && keys.length > 1) {
				key = keys.find((k) => k.active) ?? keys[0];
				if (providerFilter?.provider === m.provider && providerFilter.keyName) {
					const sel = keys.find((k) => k.name === providerFilter.keyName);
					if (sel) key = sel;
				}
			}
			const active = isRowActive ? isRowActive(m, key) : matchesModelId(m, currentModelId) && (!key || key.active);
			rows.push({ model: m, key, active });
		}
		return rows;
	}, [filteredModels, providerKeys, providerFilter, isRowActive, currentModelId]);

	return (
		<>
			<div className="dd-header dd-header-flex">
				{!hideTitle && <span className="dd-header-title">{t("availableModels")}</span>}
				<div className="dd-header-actions" style={hideTitle ? { marginLeft: "auto" } : undefined}>
					{Boolean(defaultModel) && (
						<div className="dd-header-default" title={`默认模型: ${defaultModel}`}>
							<span className="dd-header-default-star">★</span>
							<span className="dd-header-default-name">
								{defaultModel!.includes("/") ? defaultModel!.split("/").slice(1).join("/") : defaultModel}
							</span>
							<button
								type="button"
								className="dd-header-default-clear"
								title="清除全局默认模型"
								onClick={(e) => {
									e.stopPropagation();
									appSend({ type: "clear_default_model" });
								}}
							>
								✕
							</button>
						</div>
					)}
					{hasEnabledScope && (
						<button
							type="button"
							className={`dd-scope-toggle ${showAllModels ? "active" : ""}`}
							onClick={() => setShowAllModels((v) => !v)}
							title={
								showAllModels
									? t("showEnabledModelsTitle", { n: enabledCount })
									: t("showAllModelsTitle", { n: models.length })
							}
						>
							{showAllModels ? t("showEnabledModels", { n: enabledCount }) : t("showAllModels", { n: models.length })}
						</button>
					)}
					<button
						type="button"
						className="dd-header-btn dd-refresh-btn"
						onClick={onRefresh}
						title={t("refreshModels")}
						aria-label={t("refreshModels")}
					>
						<FiRefreshCw className={loading || modelsLoading ? "spin" : ""} />
					</button>
					{onManageModels && (
						<button
							type="button"
							className="dd-header-btn dd-manage-btn"
							onClick={onManageModels}
							title={t("manageModels")}
							aria-label={t("manageModels")}
						>
							<FiSettings />
						</button>
					)}
				</div>
			</div>
			<div className="dd-search-row">
				<FiSearch />
				<input
					className="dd-search"
					type="text"
					autoFocus={autoFocusSearch}
					placeholder={t("searchModels")}
					value={modelFilter}
					onChange={(e) => setModelFilter(e.target.value)}
				/>
			</div>
			{/* Scrollable middle band — provider sidebar (left) + model list
			    (right). The header/search above and footer below stay fixed. */}
			<div className="dd-model-body" style={bodyStyle}>
				{providerEntries.length > 1 && (
					<div className="dd-provider-col">
						<div className="dd-provider-head">{t("providers")}</div>
						<button
							type="button"
							className={`dd-provider-item ${providerFilter === null ? "active" : ""}`}
							onClick={() => setProviderFilter(null)}
						>
							<span>{t("allProviders")}</span>
						</button>
						{providerEntries.map((entry) => {
							const active = providerFilter?.provider === entry.provider && providerFilter?.keyName === entry.keyName;
							return (
								<button
									type="button"
									key={entry.keyName ? `${entry.provider}::${entry.keyName}` : entry.provider}
									className={`dd-provider-item ${active ? "active" : ""}`}
									onClick={() =>
										setProviderFilter(active ? null : { provider: entry.provider, keyName: entry.keyName })
									}
									title={entry.keyName ? `${entry.provider} · ${entry.keyName}` : `${entry.provider} · ${entry.count}`}
								>
									<span className="dd-provider-txt">
										<span className="dd-provider-name">{entry.provider}</span>
										{entry.keyName && <span className="dd-provider-key">{entry.keyName}</span>}
									</span>
									<span className="dd-provider-count">{entry.count}</span>
								</button>
							);
						})}
					</div>
				)}
				<div className="dd-model-scroll" ref={listRef} style={scrollStyle}>
					{(loading || modelsLoading) && <div className="dd-loading">{t("loading")}</div>}
					{models.length === 0 && !loading && !modelsLoading && <div className="dd-loading">{t("noModels")}</div>}
					{extraTopRow}
					{filteredModels.length === 0 && visibleModels.length > 0 && (
						<div className="dd-loading">
							<div>{t("noModelMatches")}</div>
							{hasEnabledScope && !showAllModels && (
								<button type="button" className="dd-scope-switch-link" onClick={() => setShowAllModels(true)}>
									{t("searchAllModelsHint", { n: models.length })}
								</button>
							)}
						</div>
					)}
					{displayRows.map((row) => {
						const m = row.model;
						const isDefault = defaultModel !== undefined && defaultModel === m.id;
						return (
							<DropdownItem
								key={row.key ? `${m.id}::${row.key.name}` : m.id}
								active={row.active}
								onClick={() => onPickModel(m, row.key)}
							>
								<span className="dd-model-cell">
									<span className="dd-model-name">{m.name}</span>
									<span className="dd-model-meta">
										<span className="dd-model-provider">{m.provider}</span>
										<span className="dd-model-id">
											{m.id.includes("/") ? m.id.split("/").slice(1).join("/") : m.id}
										</span>
										{row.key && (
											<span className={`dd-model-key ${row.key.active ? "active" : ""}`}>
												{row.key.active ? "●" : "○"} {row.key.name}
											</span>
										)}
										{(usage[m.id] ?? 0) > 0 && (
											<span className="dd-model-usage">{t("modelUsedCount", { n: usage[m.id] })}</span>
										)}
										{(m.reasoning || m.vision || (showAllModels && m.enabled === false)) && (
											<span className="dd-model-badges">
												{m.reasoning && <span className="dd-model-badge">{t("reasoning")}</span>}
												{m.vision && <span className="dd-model-badge">{t("vision")}</span>}
												{showAllModels && m.enabled === false && (
													<span className="dd-model-badge out-of-scope">{t("notInScopeBadge")}</span>
												)}
											</span>
										)}
									</span>
								</span>
								{defaultModel !== undefined &&
									(onToggleDefault ? (
										<button
											type="button"
											className={`dd-star-btn ${isDefault ? "active" : ""}`}
											title={isDefault ? "当前全局默认模型（点击取消默认）" : "设为全局默认模型"}
											onClick={(e) => {
												e.stopPropagation();
												onToggleDefault(m, isDefault);
											}}
										>
											{isDefault ? "★" : "☆"}
										</button>
									) : (
										<span className={`dd-star-btn ${isDefault ? "active" : ""}`}>{isDefault ? "★" : "☆"}</span>
									))}
							</DropdownItem>
						);
					})}
				</div>
			</div>
		</>
	);
}
