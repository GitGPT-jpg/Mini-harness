/**
 * 助手消息是否为「被中止」的回合（用户按停止 / 被新消息抢占），而不是真实报错（#575）。
 *
 * SDK 中止时 stopReason 为 "aborted"；用户停止长等待时也会落成 stopReason="error" +
 * errorMessage="This operation was aborted"。两者都是用户/系统主动结束，不该渲染成
 * 红色错误卡，更不该给「立刻重试」（重跑会重复已在执行的工具副作用）。
 * errorMessage 只认 SDK 的精确文案，避免把上游真实报错误判成中止。
 */
const SDK_ABORT_MESSAGES = /^(This operation was aborted|Request aborted)$/;

export function isAbortedTurn(m: { stopReason?: string; errorMessage?: string }): boolean {
	if (m.stopReason === "aborted") return true;
	return m.stopReason === "error" && SDK_ABORT_MESSAGES.test((m.errorMessage ?? "").trim());
}
