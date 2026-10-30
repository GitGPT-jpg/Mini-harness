/**
 * client-id-utils — 伪客户端 ID 判断。
 *
 * 负责：
 * - isPseudoClientId: 判断是否为定时任务的无头伪客户端（sink 常驻）
 *
 * 从 agent-service.ts 抽出为独立模块。
 */

/** 调度伪客户端：sink 常驻的后台辅助专用通道，不参与聊天会话认领与感知。 */
export function isPseudoClientId(id: string): boolean {
	return id.startsWith("scheduler:");
}
