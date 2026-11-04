import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { FiFileText } from "react-icons/fi";
import type { LoopUiState } from "../types";
import { useT } from "../i18n";
import { appSend } from "../app-globals";
import { closeRunDetail, mhGet, mhPost, openTaskModal, useCockpit } from "../loop-cockpit";
import {
	canAcceptValidatorOnly,
	loopRoundText,
	loopStatus,
	retryPrefillOf,
	reviewerLine,
	validatorLine,
} from "../loop-status";
import { Modal } from "./Modal";

/** GET /api/mini-harness/runs/:runId/detail 的返回（server/loop/routes.ts 的 LoopRunDetail）。 */
export interface RunDetail {
	runId: string;
	goal: string;
	criteria: string | null;
	mode: "code" | "llm";
	status: string;
	stage: string;
	round: number;
	maxRounds: number;
	stopReason: string | null;
	stopRequestedAt?: string | null;
	stopConfirmedAt?: string | null;
	acceptance: string | null;
	setupError: string | null;
	validator: {
		started?: boolean;
		precheckCmd?: string | null;
		cmd: string | null;
		verdict: string | null;
		code: number | null;
		evidenceTail: string;
	};
	review: { enabled: boolean; verdict: string | null; reasons: string[] };
	models: { main: string | null; planner: string | null; reviewer: string | null };
	project: string;
	workspace: string;
	worktreeBranch: string | null;
	worktreeCommitted: boolean;
	plannerOutput: string;
	plan: string;
	summary: string;
	history: Array<{
		round: number;
		verdict: string;
		code: number | null;
		at: string;
		metrics?: Record<string, number>;
		commitSha?: string | null;
		precheckFailed?: boolean;
	}>;
	lastMetrics?: Record<string, number> | null;
	bestRound?: {
		round: number;
		verdict: string;
		commitSha: string | null;
		metrics?: Record<string, number>;
		at: string;
	} | null;
	rounds: Array<{ round: number; review: string | null; logs: Array<{ file: string; tail: string }> }>;
	diff: string;
	journal: Array<Record<string, unknown>>;
	createdAt: string;
	updatedAt: string | null;
}

/** 进行中的 run 每 3s 刷一次详情（页面隐藏时只排队不请求）。 */
const POLL_MS = 3000;
/** 时间线只画最后这么多条（接口最多给 200 条）。 */
const JOURNAL_SHOWN = 40;

/** ISO 时间 → 本地「MM-DD HH:MM:SS」。 */
function clock(at: unknown): string {
	const ms = Date.parse(String(at ?? ""));
	if (!ms) return "";
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** diff 按行上色：+ 绿 / - 红 / @@ 暗（文件头 +++ / --- 不算增删）。 */
function DiffBlock({ text }: { text: string }) {
	const lines = text.split("\n");
	return (
		<pre className="run-detail-pre run-detail-diff">
			{lines.map((line, i) => {
				const cls =
					line.startsWith("+") && !line.startsWith("+++")
						? "add"
						: line.startsWith("-") && !line.startsWith("---")
							? "del"
							: line.startsWith("@@")
								? "hunk"
								: undefined;
				return (
					<span key={i} className={cls}>
						{line}
						{i < lines.length - 1 ? "\n" : ""}
					</span>
				);
			})}
		</pre>
	);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<>
			<div className="run-detail-sec">{title}</div>
			{children}
		</>
	);
}

interface Props {
	/** 当前对话归属仅限制重试评审/按代码验证收下；恢复和停止由服务端校验控制权。 */
	currentLoop: LoopUiState | null;
}

/** 任务详情（成果与证据查看器，D-12-3）：任务台的行、状态条的结果都能打开。
 *  目标与验收标准 → 人话状态 → 代码验证 / 模型评审两行结论（附理由）→ 各轮记录 → 最近一次验收
 *  输出 → 改动 → 过程记录 → 模型 / 项目 / 分支。进行中的 run 每 3s 刷新，关掉即停。 */
export const RunDetailModal = memo(function RunDetailModal({ currentLoop }: Props) {
	const runId = useCockpit("runDetail");
	const t = useT();
	// undefined = 加载中；null = 拿不到（400 / 404 / 网络），画友好的空状态
	const [detail, setDetail] = useState<RunDetail | null | undefined>(undefined);
	const [stopping, setStopping] = useState(false);
	const [actionMessage, setActionMessage] = useState("");
	const [reload, setReload] = useState(0);
	const view = useRef({});
	const owned = !!runId && currentLoop?.kind === "run" && currentLoop.runId === runId;
	// 本对话的 run：快照里状态一变（停止 / 重试评审 / 收下 / 进下一轮）就立刻重拉，不等轮询
	const liveKey =
		owned && currentLoop
			? [currentLoop.status, currentLoop.stage, currentLoop.round, currentLoop.stopReason, currentLoop.acceptance].join(
					"|",
				)
			: "";

	useEffect(() => {
		setDetail(undefined);
		setStopping(false);
		setActionMessage("");
		view.current = {};
		return () => {
			view.current = {};
		};
	}, [runId]);

	useEffect(() => {
		if (!runId || stopping) return;
		let alive = true;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const schedule = () => {
			timer = setTimeout(() => {
				if (!alive) return;
				if (document.hidden) schedule();
				else void load();
			}, POLL_MS);
		};
		async function load() {
			const d = await mhGet<RunDetail>(`runs/${encodeURIComponent(runId ?? "")}/detail`);
			if (!alive) return;
			if (d) setDetail(d);
			else setDetail((previous) => previous ?? null);
			if (!d || d.status === "active" || (d.stopRequestedAt && !d.stopConfirmedAt) || d.stage === "stopping") {
				schedule();
			}
		}
		void load();
		return () => {
			alive = false;
			if (timer) clearTimeout(timer);
		};
	}, [runId, liveKey, reload, stopping]);

	if (!runId) return null;

	const st = detail ? loopStatus(detail, t) : null;
	const active = detail?.status === "active";
	const stopPending =
		!!detail && ((!!detail.stopRequestedAt && !detail.stopConfirmedAt) || detail.stage === "stopping");
	const reviewerDown = detail?.status === "stopped" && detail.stopReason === "reviewer-error";
	const canAccept =
		!!detail &&
		canAcceptValidatorOnly({
			status: detail.status,
			stopReason: detail.stopReason,
			mode: detail.mode,
			lastVerdict: detail.validator?.verdict ?? null,
		});
	const restart = () => {
		if (!detail) return;
		closeRunDetail();
		openTaskModal(
			retryPrefillOf({
				goal: detail.goal,
				criteria: detail.criteria,
				mode: detail.mode,
				reviewerEnabled: detail.review?.enabled ?? null,
			}),
		);
	};
	const stop = async () => {
		if (stopping || !window.confirm(t("runDetailStopConfirm"))) return;
		const scope = view.current;
		setStopping(true);
		setActionMessage("");
		const response = await mhPost<{
			ok: boolean;
			error?: string;
			stopRequestedAt?: string | null;
			stopConfirmedAt?: string | null;
		}>(`runs/${encodeURIComponent(runId)}/stop`, {});
		if (view.current !== scope) return;
		if (!response?.ok || !response.data?.ok) {
			setActionMessage(response?.data?.error || t("runDetailControlFailed"));
		} else {
			const result = response.data;
			// Only the server's confirmed timestamp permits a stopped label.
			setDetail(
				(previous) =>
					previous && {
						...previous,
						stopRequestedAt: result.stopRequestedAt ?? previous.stopRequestedAt,
						stopConfirmedAt: result.stopConfirmedAt ?? previous.stopConfirmedAt,
						...(result.stopConfirmedAt ? { status: "stopped", stage: "stopped" } : {}),
					},
			);
		}
		setStopping(false);
		setReload((value) => value + 1);
	};

	const title = (
		<span className="run-detail-head">
			<span>{t("runDetailTitle")}</span>
			{st && <span className={`run-detail-status tone-${st.tone}`}>{st.text}</span>}
		</span>
	);

	return (
		<Modal
			className="cockpit-modal run-detail"
			onClose={closeRunDetail}
			title={title}
			ariaLabel={t("runDetailTitle")}
			icon={<FiFileText />}
		>
			<div className="cockpit-body run-detail-body">
				{detail === undefined ? (
					<div className="task-desk-empty">{t("taskDeskLoading")}</div>
				) : detail === null ? (
					<div className="task-desk-empty run-detail-missing">{t("runDetailMissing")}</div>
				) : (
					<DetailBody detail={detail} />
				)}
				<div className="cockpit-row run-detail-acts">
					{actionMessage && (
						<span className="run-detail-hint" role="status">
							{actionMessage}
						</span>
					)}
					{detail && !owned && reviewerDown && !stopPending && (
						<span className="run-detail-hint">{t("runDetailNotMine")}</span>
					)}
					{detail && active && !stopPending && (
						<button
							type="button"
							className="btn"
							disabled={stopping}
							onClick={() => {
								setActionMessage(
									appSend({ type: "loop_resume", runId }) ? t("runDetailResumeRequested") : t("runDetailControlFailed"),
								);
								setReload((value) => value + 1);
							}}
						>
							{t("runDetailResume")}
						</button>
					)}
					{detail && (active || stopPending) && (
						<button type="button" className="btn sm danger" disabled={stopping} onClick={() => void stop()}>
							{stopping ? t("runDetailStopSending") : stopPending ? t("runDetailStopRecheck") : t("runDetailStop")}
						</button>
					)}
					{detail && owned && reviewerDown && !stopPending && (
						<>
							<button
								type="button"
								className="btn primary"
								title={t("loopRetryReviewTip")}
								onClick={() => appSend({ type: "loop_resume", runId })}
							>
								{t("loopRetryReview")}
							</button>
							{canAccept && (
								<button
									type="button"
									className="btn"
									title={t("loopAcceptCodeTip")}
									onClick={() => appSend({ type: "loop_accept", runId })}
								>
									{t("loopAcceptCode")}
								</button>
							)}
						</>
					)}
					{detail && !active && !stopPending && (
						<button type="button" className="btn run-detail-restart" onClick={restart}>
							{t("runDetailRestart")}
						</button>
					)}
					<button type="button" className="btn" onClick={closeRunDetail}>
						{t("close")}
					</button>
				</div>
			</div>
		</Modal>
	);
});

function formatMetricsInline(m?: Record<string, number> | null): string {
	if (!m) return "";
	return Object.entries(m)
		.map(([k, v]) => `${k}=${v}`)
		.join(" · ");
}

function DetailBody({ detail }: { detail: RunDetail }) {
	const t = useT();
	const [distilling, setDistilling] = useState(false);
	const [distilledPath, setDistilledPath] = useState<string | null>(null);
	const vl =
		detail.mode !== "llm" && detail.validator?.started && !detail.validator.verdict
			? {
					text: detail.stopConfirmedAt ? t("runDetailValidatorStopped") : t("runDetailValidatorUnfinished"),
					tone: "warn",
				}
			: validatorLine(detail, t);
	const rl = reviewerLine(detail, t);
	const reasons = detail.review?.reasons ?? [];
	const rounds = detail.rounds ?? [];
	const history = detail.history ?? [];
	const journal = (detail.journal ?? []).slice(-JOURNAL_SHOWN);
	const models = detail.models ?? { main: null, planner: null, reviewer: null };
	const roundVerdict = (n: number): string => {
		const h = history.filter((x) => x.round === n).at(-1);
		if (!h) return "";
		if (h.verdict === "pass") return t("runDetailPass");
		return typeof h.code === "number" ? t("runDetailFailExit", { code: h.code }) : t("runDetailFail");
	};
	const meta = [
		detail.runId,
		loopRoundText(t, detail),
		detail.mode === "llm" ? t("loopBarModeLlm") : t("loopBarModeCode"),
	].filter(Boolean);

	return (
		<>
			<Section title={t("runDetailGoal")}>
				<div className="run-detail-text">{detail.goal}</div>
				<div className="run-detail-meta">{meta.join(" · ")}</div>
			</Section>
			{detail.criteria && (
				<Section title={t("runDetailCriteria")}>
					<div className="run-detail-text">{detail.criteria}</div>
				</Section>
			)}

			<div className="run-detail-accept">
				{detail.stopRequestedAt && (
					<div className="run-detail-meta" data-stop-requested-at={detail.stopRequestedAt}>
						{t("runDetailStopRequestedAt", { at: detail.stopRequestedAt })}
					</div>
				)}
				{detail.stopConfirmedAt && (
					<div className="run-detail-meta" data-stop-confirmed-at={detail.stopConfirmedAt}>
						{t("runDetailStopConfirmedAt", { at: detail.stopConfirmedAt })}
					</div>
				)}
				<div className={`run-detail-line tone-${vl.tone}`}>{t("runDetailValidatorLine", { v: vl.text })}</div>
				<div className={`run-detail-line tone-${rl.tone}`}>{t("runDetailReviewerLine", { v: rl.text })}</div>
				{reasons.length > 0 && (
					<>
						<div className="run-detail-sub">
							{detail.review?.verdict === "error" ? t("runDetailErrorReasons") : t("runDetailReasons")}
						</div>
						<ul className="run-detail-reasons">
							{reasons.map((r, i) => (
								<li key={i}>{r}</li>
							))}
						</ul>
					</>
				)}
				{detail.lastMetrics && Object.keys(detail.lastMetrics).length > 0 && (
					<div className="run-detail-meta">{t("runDetailMetrics", { v: formatMetricsInline(detail.lastMetrics) })}</div>
				)}
				{detail.bestRound && (
					<div className="run-detail-meta">
						{t("runDetailBestRound", {
							n: detail.bestRound.round,
							extra: [
								detail.bestRound.commitSha ? `git ${detail.bestRound.commitSha.slice(0, 8)}` : "",
								formatMetricsInline(detail.bestRound.metrics),
							]
								.filter(Boolean)
								.map((s) => ` · ${s}`)
								.join(""),
						})}
					</div>
				)}
				{detail.setupError && (
					<>
						<div className="run-detail-sub">{t("runDetailSetupError")}</div>
						<div className="run-detail-text tone-bad">{detail.setupError}</div>
					</>
				)}
			</div>

			{rounds.length > 0 && (
				<Section title={t("runDetailRounds")}>
					{rounds.map((r, i) => {
						const verdict = roundVerdict(r.round);
						return (
							<details key={r.round} className="run-detail-round" open={i === rounds.length - 1}>
								<summary>
									{t("goalBarRound", { n: r.round })}
									{verdict ? ` · ${verdict}` : ""}
								</summary>
								{r.review && (
									<>
										<div className="run-detail-sub">{t("runDetailReviewReport")}</div>
										<pre className="run-detail-pre">{r.review}</pre>
									</>
								)}
								{r.logs.map((l) => (
									<div key={l.file}>
										<div className="run-detail-sub">{l.file}</div>
										<pre className="run-detail-pre">{l.tail}</pre>
									</div>
								))}
							</details>
						);
					})}
				</Section>
			)}

			{detail.mode !== "llm" &&
				(detail.validator?.evidenceTail || detail.validator?.cmd || detail.validator?.precheckCmd) && (
					<Section title={t("runDetailLatestOutput")}>
						{detail.validator.precheckCmd && (
							<div className="run-detail-meta">{t("runDetailPrecheck", { cmd: detail.validator.precheckCmd })}</div>
						)}
						{detail.validator.cmd && (
							<div className="run-detail-meta">{t("runDetailCmd", { cmd: detail.validator.cmd })}</div>
						)}
						{detail.validator.evidenceTail && (
							<pre className="run-detail-pre run-detail-validator">{detail.validator.evidenceTail}</pre>
						)}
					</Section>
				)}

			{detail.diff && (
				<Section title={t("runDetailDiff")}>
					<DiffBlock text={detail.diff} />
				</Section>
			)}

			{journal.length > 0 && (
				<Section title={t("runDetailJournal")}>
					<ol className="run-detail-journal">
						{journal.map((j, i) => (
							<li key={i}>
								<time>{clock(j.at)}</time>
								<span className="ev">{String(j.event ?? "")}</span>
								{typeof j.round === "number" && <span className="rd">{t("goalBarRound", { n: j.round })}</span>}
							</li>
						))}
					</ol>
				</Section>
			)}

			<div className="run-detail-meta run-detail-foot">
				<span>
					{t("runDetailModels", {
						main: models.main ?? "—",
						planner: models.planner ?? "—",
						reviewer: models.reviewer ?? "—",
					})}
				</span>
				{detail.project && <span>{t("runDetailProject", { name: detail.project })}</span>}
				{detail.worktreeBranch && (
					<span>
						{t("runDetailBranch", { name: detail.worktreeBranch })}
						{detail.worktreeCommitted ? ` · ${t("runDetailCommitted")}` : ""}
					</span>
				)}
				{distilledPath ? (
					<span className="run-detail-distilled">{t("runDetailDistilled", { path: distilledPath })}</span>
				) : (
					<button
						type="button"
						className="run-detail-distill-btn"
						disabled={distilling}
						onClick={async () => {
							setDistilling(true);
							const r = await mhPost<{ filePath?: string }>(`runs/${encodeURIComponent(detail.runId)}/distill`, {});
							setDistilling(false);
							if (r?.ok && r.data?.filePath) setDistilledPath(r.data.filePath);
						}}
					>
						{distilling ? t("runDetailDistilling") : t("runDetailDistill")}
					</button>
				)}
			</div>
		</>
	);
}
