import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { FiFileText } from "react-icons/fi";
import type { LoopUiState } from "../types";
import { useT, type Translate } from "../i18n";
import { appSend } from "../app-globals";
import { bumpRunsVersion, closeRunDetail, mhGet, mhPost, openTaskModal, useCockpit } from "../loop-cockpit";
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
	/** 任务工作树的只读状态；dirty = null 表示服务端没能确认。旧服务端没有这个字段。 */
	worktree?: { path: string; exists: boolean; dirty: boolean | null; uncommitted: number } | null;
	/** 集群绑定（白名单字段）；pinned = 任务固定了一份集群配置快照。 */
	clusterBinding?: { status?: string; context?: string | null } | null;
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

/** 停止待确认时还在等什么：取最近一次停止核对写进过程记录的未确认项。 */
export function stopWaitsOf(detail: Pick<RunDetail, "journal">, t: Translate): string {
	const last = [...detail.journal].reverse().find((j) => j.event === "stop-requested" || j.event === "stop-confirmed");
	const items: string[] = [];
	if (last?.event === "stop-requested") {
		const turn = last.turn as { inFlight?: boolean; abortError?: string | null } | undefined;
		const blocked = (last.cancellation as { blockedReasons?: unknown[] } | undefined)?.blockedReasons?.length ?? 0;
		const legacy = Array.isArray(last.legacyUnverified) ? last.legacyUnverified : [];
		if (turn?.inFlight) items.push(t("runDeleteWaitTurn"));
		if (turn?.abortError) items.push(t("runDeleteWaitAbortError", { error: String(turn.abortError) }));
		if (blocked) items.push(t("runDeleteWaitOps", { count: blocked }));
		if (legacy.length) items.push(t("runDeleteWaitLegacy", { pids: legacy.join(", ") }));
	}
	return items.length ? items.join(" · ") : t("runDeleteWaitGeneric");
}

/** 删除前的界面侧拦截：停止待确认、运行中、工作树有未提交改动或状态不明；null = 可以删。 */
export function deleteBlockOf(
	detail: RunDetail,
	t: Translate,
): { reason: string; keep?: { hint: string; command: string } } | null {
	if ((detail.stopRequestedAt && !detail.stopConfirmedAt) || detail.stage === "stopping")
		return { reason: t("runDeleteWaitStop", { at: clock(detail.stopRequestedAt), waits: stopWaitsOf(detail, t) }) };
	if (detail.status === "active") return { reason: t("runDeleteActive") };
	const tree = detail.worktree;
	if (tree?.exists && tree.dirty === null) return { reason: t("runDeleteTreeUnknown", { path: tree.path }) };
	if (tree?.exists && tree.dirty) {
		const message = t("runDeleteKeepCommitMsg");
		return {
			reason: t("runDeleteDirty", { path: tree.path, count: tree.uncommitted }),
			keep: {
				hint: t("runDeleteKeepHint", { branch: detail.worktreeBranch || "—" }),
				command: `git -C "${tree.path}" add -A && git -C "${tree.path}" commit -m "${message}"`,
			},
		};
	}
	return null;
}

/** 删除接口的失败响应（server/loop/extension.ts 的 DeleteLoopRunResult）→ 给用户看的原因。 */
export function deleteFailureText(
	r: {
		ok: boolean;
		data: { code?: string; error?: string; worktreeRemoved?: boolean; checkpointRefsRemoved?: string[] } | null;
	} | null,
	t: Translate,
): string {
	if (!r) return t("runDeleteNetwork");
	const code = r.data?.code || "error";
	const error = r.data?.error || "";
	const reason =
		code === "active"
			? t("runDeleteRejectActive", { code })
			: code === "missing"
				? t("runDeleteRejectMissing", { code })
				: code === "cleanup-error"
					? t("runDeleteRejectCleanup", { code, error })
					: t("runDeleteRejectOther", { code, error: error || "—" });
	const parts = [
		...(r.data?.worktreeRemoved ? [t("runDeletePartWorktree")] : []),
		...(r.data?.checkpointRefsRemoved?.length
			? [t("runDeletePartRefs", { count: r.data.checkpointRefsRemoved.length })]
			: []),
	];
	return (
		t("runDeleteFailed", { reason }) + (parts.length ? " " + t("runDeletePartial", { parts: parts.join(" · ") }) : "")
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
	const intent = useCockpit("runDetailIntent");
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [deleteFailure, setDeleteFailure] = useState("");
	const deleteRef = useRef<HTMLDivElement>(null);
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
		setDeleting(false);
		setDeleteFailure("");
		view.current = {};
		return () => {
			view.current = {};
		};
	}, [runId]);

	// 任务台的「删除」：打开详情时直接展开删除确认
	useEffect(() => {
		setDeleteOpen(intent === "delete");
	}, [runId, intent]);

	// 确认页在长详情的末尾：展开时滚到它
	const hasDetail = !!detail;
	useEffect(() => {
		if (deleteOpen && hasDetail) deleteRef.current?.scrollIntoView?.({ block: "start" });
	}, [deleteOpen, hasDetail]);

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

	// 删除前在界面上拦下：运行中、停止待确认、工作树有未提交改动（或状态不明）都不发删除请求
	const tree = detail?.worktree ?? null;
	const deleteBlock = detail ? deleteBlockOf(detail, t) : null;
	const remove = async () => {
		if (!detail || deleteBlock || deleting) return;
		const scope = view.current;
		setDeleting(true);
		setDeleteFailure("");
		// 发请求前重拉详情：确认页打开之后，工作树或停止状态可能已经变了
		const fresh = await mhGet<RunDetail>(`runs/${encodeURIComponent(detail.runId)}/detail`);
		if (view.current !== scope) return;
		if (fresh) {
			setDetail(fresh);
			if (deleteBlockOf(fresh, t)) {
				setDeleting(false);
				return;
			}
		}
		const response = await mhPost<{
			ok: boolean;
			code?: string;
			error?: string;
			worktreeRemoved?: boolean;
			checkpointRefsRemoved?: string[];
		}>("runs/delete", { runId: detail.runId });
		if (view.current !== scope) return;
		setDeleting(false);
		if (response?.ok && response.data?.ok) {
			bumpRunsVersion();
			// 任务工作树已移除：首页工作树横幅重新读取
			appSend({ type: "refresh_worktree" });
			closeRunDetail();
			return;
		}
		// 删除失败：记录留在原处，重拉详情显示当前状态
		setDeleteFailure(deleteFailureText(response, t));
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
				{detail && deleteOpen && (
					<div ref={deleteRef} className="run-detail-delete" role="region" aria-label={t("runDeleteTitle")}>
						<div className="run-detail-delete-title">{t("runDeleteTitle")}</div>
						<div className="run-detail-delete-sub">{t("runDeleteWillRemove")}</div>
						<ul className="run-detail-delete-list">
							<li>{t("runDeleteItemRecord")}</li>
							{tree?.exists && <li>{t("runDeleteItemWorktree", { path: tree.path })}</li>}
							<li>{t("runDeleteItemRefs", { runId: detail.runId })}</li>
							{detail.clusterBinding?.status === "pinned" && (
								<li>{t("runDeleteItemCluster", { context: detail.clusterBinding.context || "—" })}</li>
							)}
						</ul>
						<div className="run-detail-delete-sub">
							{detail.worktreeBranch
								? t("runDeleteKeepsBranch", { branch: detail.worktreeBranch, workspace: detail.workspace })
								: t("runDeleteKeepsWorkspace", { workspace: detail.workspace })}
						</div>
						{deleteBlock ? (
							<div className="run-detail-delete-block" role="status">
								<div>{deleteBlock.reason}</div>
								{deleteBlock.keep && (
									<>
										<div>{deleteBlock.keep.hint}</div>
										<pre className="run-detail-pre run-detail-delete-cmd">{deleteBlock.keep.command}</pre>
									</>
								)}
								{!active && !stopPending && (
									<button
										type="button"
										className="btn sm run-detail-delete-recheck"
										onClick={() => setReload((value) => value + 1)}
									>
										{t("runDeleteRecheck")}
									</button>
								)}
							</div>
						) : (
							<div className="run-detail-delete-sub">{t("runDeleteIrreversible")}</div>
						)}
						{deleteFailure && (
							<div className="run-detail-delete-error" role="alert">
								{deleteFailure}
							</div>
						)}
						<div className="cockpit-row run-detail-delete-acts">
							<button
								type="button"
								className="btn sm danger run-detail-delete-confirm"
								disabled={!!deleteBlock || deleting}
								onClick={() => void remove()}
							>
								{deleting ? t("runDeleteSending") : t("runDeleteConfirm")}
							</button>
							<button type="button" className="btn sm" disabled={deleting} onClick={() => setDeleteOpen(false)}>
								{t("cancel")}
							</button>
						</div>
					</div>
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
					{detail && !deleteOpen && (
						<button
							type="button"
							className="btn sm run-detail-delete-open"
							onClick={() => {
								setDeleteFailure("");
								setDeleteOpen(true);
								setReload((value) => value + 1);
							}}
						>
							{t("runDelete")}
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
