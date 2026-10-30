import { memo, useEffect, useState } from "react";
import { LuWorkflow } from "react-icons/lu";
import { useT } from "../i18n";
import {
	closeCluster,
	mhPost,
	openCluster,
	refreshCluster,
	setClusterStatus,
	useClusterPolling,
	useCockpit,
	type ClusterStatus,
} from "../loop-cockpit";
import { Modal } from "./Modal";

type T = ReturnType<typeof useT>;

function clusterLabel(t: T, c: ClusterStatus | null): string {
	if (c?.connected) return t("clusterConnected");
	return c?.configured ? t("clusterUnreachable") : t("clusterNotConnected");
}

function clusterTip(t: T, c: ClusterStatus | null): string {
	if (c?.connected) return t("clusterTipConnected");
	return c?.configured ? t("clusterTipUnreachable") : t("clusterTipNone");
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
	const tip = c?.connected ? t("clusterTipConnected") : `${c?.message ? `${c.message} · ` : ""}${clusterTip(t, c)}`;
	return (
		<button
			type="button"
			className={`bar-item status-item status-cluster${c?.connected ? " ok" : ""}`}
			title={tip}
			data-tip={tip}
			data-bar-item="host:cluster"
			onClick={openCluster}
		>
			<span className={`status-dot ${c?.connected ? "ok" : "error"}`} />
			<span className="bar-item-text">{name ? `${name} ${label}` : label}</span>
		</button>
	);
});

/** 连接集群弹窗：粘贴 kubeconfig → 服务端存 0600 并立刻 kubectl cluster-info 实测。 */
export const ClusterModal = memo(function ClusterModal() {
	// 弹窗常驻挂在 App 上（关着时画 null）：集群状态轮询挂这里，全局只一份，
	// 输入框按钮与底栏指示只读状态（单测单独渲染它们时不会起常驻定时器）。
	useClusterPolling();
	const open = useCockpit("clusterOpen");
	const t = useT();
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<{ tone: "ok" | "bad" | "info"; text: string } | null>(null);

	useEffect(() => {
		if (open) setResult(null);
	}, [open]);

	if (!open) return null;

	const describe = (j: ClusterStatus): { tone: "ok" | "bad"; text: string } => {
		if (j.connected) return { tone: "ok", text: `${t("clusterOk")}\n${j.message}` };
		if (j.code === "no-kubectl") return { tone: "bad", text: t("clusterNoKubectl") };
		return { tone: "bad", text: `${t("clusterFailed")}\n${j.message || ""}`.trim() };
	};
	const save = async () => {
		const body = text.trim();
		if (!body) {
			setResult({ tone: "bad", text: t("clusterEmpty") });
			return;
		}
		setBusy(true);
		setResult({ tone: "info", text: t("clusterTesting") });
		const r = await mhPost<ClusterStatus & { error?: string }>("cluster", { kubeconfig: body });
		setBusy(false);
		if (!r?.data) {
			setResult({ tone: "bad", text: t("clusterFailed") });
			return;
		}
		if (!r.ok) {
			setResult({ tone: "bad", text: `${t("clusterFailed")}\n${r.data.error ?? ""}`.trim() });
			return;
		}
		setClusterStatus(r.data);
		setResult(describe(r.data));
	};
	const clear = async () => {
		if (!window.confirm(t("clusterClearConfirm"))) return;
		await mhPost("cluster/clear", {});
		setResult({ tone: "info", text: t("clusterCleared") });
		await refreshCluster();
	};

	return (
		<Modal
			className="cockpit-modal cluster-modal"
			onClose={closeCluster}
			title={t("clusterConnect")}
			icon={<LuWorkflow />}
		>
			<div className="cockpit-body">
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
					<button type="button" className="btn sm danger cockpit-row-start" onClick={() => void clear()}>
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
