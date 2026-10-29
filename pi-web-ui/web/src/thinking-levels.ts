/**
 * 思考强度档位的唯一前端清单（与 SDK 的 THINKING_LEVEL_OPTIONS 逐字一致）。
 *
 * 顶栏「模型 + 思考强度」下拉与设置面板的「子代理模板」编辑器共用同一份顺序，
 * 免得两处各写一份、哪天 SDK 加了档位改漏一处（服务端另有校验表：
 * server/subagent-templates.ts 的 THINKING_LEVELS）。
 * 文案 key 约定：`thinking.<value>`（见 i18n.tsx）。
 */
export const THINKING_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** 单个档位字面量（"off" | "minimal" | … | "max"）。 */
export type ThinkingValue = (typeof THINKING_VALUES)[number];
