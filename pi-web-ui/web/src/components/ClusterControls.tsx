import { memo, useEffect, useState } from "react";
import { LuRefreshCw, LuWorkflow } from "react-icons/lu";
import { useT } from "../i18n";
import {
	closeCluster,
	mutateCluster,
	openCluster,
	refreshCluster,
	useClusterPolling,
	useCockpit,
	type ClusterStatus,
} from "../loop-cockpit";
import { Modal } from "./Modal";

type T = ReturnType<typeof useT>;

/** 401/403：API 有响应，但凭据被拒或权限受限（不是网络断开）。 */
const authLimited = (c: ClusterStatus | null) => c?.code === "unauthorized" || c?.code === "forbidden";

function dotClass(c: ClusterStatus | null): string {
	if (c?.connected) return "ok";
	return authLimited(c) ? "mid" : "error";
}

function clusterLabel(t: T, c: ClusterStatus | null): string {
	if (c?.connected) return t("clusterConnected");
	if (!c?.configured) return t("clusterNotConnected");
	return authLimited(c) ? t("clusterAuthLimited") : t("clusterUnreachable");
}

/** 按错误码出固定文案：不展示 kubectl 或服务端的原始输出。 */
function codeText(t: T, c: ClusterStatus): string {
	switch (c.code) {
		case "ok":
			return t("clusterCodeOk");
		case "not-configured":
			return t("clusterCodeNone");
		case "no-kubectl":
			return t("clusterNoKubectl");
		case "unauthorized":
			return t("clusterCodeUnauthorized");
		case "forbidden":
			return t("clusterCodeForbidden");
		case "tls":
			return t("clusterCodeTls");
		case "network":
			return t("clusterCodeNetwork");
		case "timeout":
			return t("clusterCodeTimeout");
		case "config-invalid":
			return t("clusterCodeConfig");
		default:
			return t("clusterCodeError");
	}
}

/** 服务实际使用的配置来源（与新任务同一套优先级）。 */
function sourceText(t: T, c: ClusterStatus): string {
	switch (c.source) {
		case "app":
			return t("clusterSourceApp");
		case "env":
			return t("clusterSourceEnv", { n: c.envPathCount ?? 1 });
		case "default":
			return t("clusterSourceDefault");
		default:
			return t("clusterSourceNone");
	}
}

function clusterTip(t: T, c: ClusterStatus | null): string {
	if (!c) return t("clusterTipNone");
	if (c.connected) return `${t("clusterTipConnected")} · ${sourceText(t, c)}`;
	return c.configured ? `${codeText(t, c)} · ${t("clusterTipUnreachable")}` : t("clusterTipNone");
}

/** 输入框里发送键左侧的小图标按钮：角标点 = 连通状态，点击打开 kubeconfig 弹窗。 */
export const ClusterButton = memo(function ClusterButton() {
	const t = useT();
	const c = useCockpit("cluster");
	const tip = clusterTip(t, c);
	return (
		<button
			type="button"
			className={`btn cluster-btn${c?.connected ? " ok" : ""}`}
			title={tip}
			aria-label={tip}
			onClick={openCluster}
		>
			<LuWorkflow />
		</button>
	);
});

/** 底栏「集群已连接 / 未连接」指示（与左侧「API 已连接」并列，点击同样打开弹窗）。 */
export const ClusterStatusItem = memo(function ClusterStatusItem({ name }: { name?: string }) {
	const t = useT();
	const c = useCockpit("cluster");
	const label = clusterLabel(t, c);
	const tip = clusterTip(t, c);
	return (
		<button
			type="button"
			className={`bar-item status-item status-cluster${c?.connected ? " ok" : ""}`}
			title={tip}
			data-tip={tip}
			data-bar-item="host:cluster"
			onClick={openCluster}
		>
			<span className={`status-dot ${dotClass(c)}`} />
			<span className="bar-item-text">{name ? `${name} ${label}` : label}</span>
		</button>
	);
});

/** 连接集群弹窗：显示服务当前实际使用的配置与探测结果；粘贴 kubeconfig → 服务端存新版本（0600）并立即探测。 */
export const ClusterModal = memo(function ClusterModal() {
	// 弹窗常驻挂在 App 上（关着时画 null）：集群状态轮询挂这里，全局只一份，
	// 输入框按钮与底栏指示只读状态（单测单独渲染它们时不会起常驻定时器）。
	useClusterPolling();
	const open = useCockpit("clusterOpen");
	const c = useCockpit("cluster");
	const checking = useCockpit("clusterChecking");
	const t = useT();
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<{ tone: "ok" | "bad" | "info"; text: string } | null>(null);

	useEffect(() => {
		if (!open) return;
		setResult(null);
		// 每次打开都按服务端当前配置重探（跳过缓存），不沿用上次的结果。
		void refreshCluster(true);
	}, [open]);

	if (!open) return null;

	const save = async () => {
		const body = text.trim();
		if (!body) {
			setResult({ tone: "bad", text: t("clusterEmpty") });
			return;
		}
		setBusy(true);
		setResult({ tone: "info", text: t("clusterTesting") });
		const r = await mutateCluster("cluster", { kubeconfig: body });
		setBusy(false);
		if (!r?.ok || !r.data) {
			const code = (r?.data as { code?: string } | null)?.code;
			setResult({
				tone: "bad",
				text:
					code === "write-failed"
						? t("clusterSaveFailed")
						: code === "too-large"
							? t("clusterTooLarge")
							: t("clusterFailed"),
			});
			return;
		}
		// 保存成功即清空输入框：凭据不在页面上停留。
		setText("");
		setResult(r.data.connected ? { tone: "ok", text: t("clusterOk") } : { tone: "bad", text: codeText(t, r.data) });
	};
	const clear = async () => {
		if (!window.confirm(t("clusterClearConfirm"))) return;
		setBusy(true);
		const r = await mutateCluster("cluster/clear", {});
		setBusy(false);
		setResult(
			r?.data
				? { tone: "info", text: t("clusterClearedFallback", { source: sourceText(t, r.data) }) }
				: { tone: "bad", text: t("clusterFailed") },
		);
	};

	return (
		<Modal
			className="cockpit-modal cluster-modal"
			onClose={closeCluster}
			title={t("clusterConnect")}
			icon={<LuWorkflow />}
		>
			<div className="cockpit-body">
				<div className="cockpit-note cluster-current" aria-live="polite">
					<div className="cockpit-row cluster-current-head">
						<span className={`status-dot ${dotClass(c)}`} />
						<strong>{c ? clusterLabel(t, c) : t("clusterChecking")}</strong>
						<button
							type="button"
							className="btn sm"
							disabled={checking || busy}
							title={t("clusterRefresh")}
							onClick={() => void refreshCluster(true)}
						>
							<LuRefreshCw /> {checking ? t("clusterChecking") : t("clusterRefresh")}
						</button>
					</div>
					{c && (
						<div className="cockpit-hint">
							{t("clusterSourceLabel")}
							{sourceText(t, c)}
							{c.context ? ` · context ${c.context}` : ""}
							{c.serverVersion ? ` · ${c.serverVersion}` : ""}
						</div>
					)}
					{c && c.configured && !c.connected && <div className="cockpit-hint">{codeText(t, c)}</div>}
					{c?.source === "app" && (c.shadowed?.length ?? 0) > 0 && (
						<div className="cockpit-hint">{t("clusterShadowed")}</div>
					)}
					<div className="cockpit-hint">{t("clusterProbeNote")}</div>
					<div className="cockpit-hint">{t("clusterEnvHint")}</div>
				</div>
				<p className="cockpit-sub">{t("clusterDesc")}</p>
				<textarea
					className="cockpit-input cockpit-code"
					rows={9}
					autoFocus
					spellCheck={false}
					value={text}
					placeholder={"apiVersion: v1\nkind: Config\nclusters:\n- cluster:\n    server: https://..."}
					onChange={(e) => setText(e.target.value)}
				/>
				{result && <div className={`cockpit-state ${result.tone}`}>{result.text}</div>}
				<div className="cockpit-row">
					<button
						type="button"
						className="btn sm danger cockpit-row-start"
						disabled={busy || c?.source !== "app"}
						onClick={() => void clear()}
					>
						{t("clusterClear")}
					</button>
					<button type="button" className="btn" onClick={closeCluster}>
						{t("cancel")}
					</button>
					<button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>
						{t("clusterSave")}
					</button>
				</div>
			</div>
		</Modal>
	);
});
