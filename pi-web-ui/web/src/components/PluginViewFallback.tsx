import { useState } from "react";
import type { JSX } from "react";
import { retryPluginViewLoad } from "../plugin-loader";
import { useT } from "../i18n";
import type { UiPluginInfo } from "../types";

interface PluginViewFallbackProps {
	/** 当前切到的插件视图 id（`plugin:<id>` 里的 id 部分）。 */
	pluginId: string;
	/** 清单里的插件信息（名字展示用；找不到时只显示 id）。 */
	info?: UiPluginInfo;
	/** 服务端重载纪元（重试时拼 bundle URL 的 ?e=）。 */
	epoch: number;
	/** 该 id 是否已在 loader 的失败集合里（是 = 明确失败；否 = 还在加载中）。 */
	failed: boolean;
}

/**
 * issue #225：切到 bundle 没加载出来的插件视图时的占位 pane —— 以前这里什么都
 * 不渲染（顶栏还在、下面整片空白，用户以为卡死）。现在给明确状态：
 * 加载中给等待行；明确失败给原因 + 重试按钮（修好文件/重装后不用等服务端重载）。
 */
export function PluginViewFallback({ pluginId, info, epoch, failed }: PluginViewFallbackProps): JSX.Element {
	const t = useT();
	const [retrying, setRetrying] = useState(false);
	const name = info?.name || pluginId;
	if (!failed) {
		return (
			<div className="view-pane">
				<div className="plugin-view-fallback" role="status">
					{t("pluginViewLoading")}
				</div>
			</div>
		);
	}
	const onRetry = () => {
		if (!info || retrying) return;
		setRetrying(true);
		void retryPluginViewLoad(info, epoch).finally(() => setRetrying(false));
	};
	return (
		<div className="view-pane">
			<div className="plugin-view-fallback" role="alert">
				<div className="plugin-view-fallback-title">
					{t("pluginViewLoadFailed")}：{name}
				</div>
				<div className="plugin-view-fallback-hint">{t("pluginViewLoadFailedHint")}</div>
				{info && (
					<button type="button" className="plugin-view-fallback-retry" onClick={onRetry} disabled={retrying}>
						{retrying ? t("pluginViewLoading") : t("pluginViewRetry")}
					</button>
				)}
			</div>
		</div>
	);
}
