/**
 * durable-tools.ts — Pi Durable 引擎的工具加载与环境装配。
 *
 * 职责：
 * 1. 动态加载 @earendil-works/pi-durable/tools 中的官方 CodingTools（read/write/edit/bash）；
 * 2. 装配 Registry，注入工作区路径、图片处理器及自定义扩展；
 * 3. 将现有的工具结果（三通道：output / structuredOutput / details）安全适配给 UI。
 */

import { loadDurableModule } from "./durable-loader.js";

export interface DurableToolsSetup {
	registry: any;
	installedToolNames: string[];
}

/**
 * 为指定工作区配置 Durable Registry 和工具链。
 */
export async function setupDurableRegistry(
	cwd: string,
	// 预留位（尚未消费）：`allowDangerous` / `onToolOutput` 现在没有任何实现，
	// 保留参数形状，后续接线时不必改调用方。
	_options?: {
		allowDangerous?: boolean;
		onToolOutput?: (toolName: string, delta: string) => void;
	},
): Promise<DurableToolsSetup> {
	const durableModule = await loadDurableModule().catch(() => null);

	if (!durableModule || typeof durableModule.createRegistry !== "function") {
		throw new Error("Pi Durable 依赖未安装。请运行 npm i -g @earendil-works/pi-durable 启用该引擎。");
	}

	const registry = durableModule.createRegistry();
	const installedToolNames: string[] = [];

	// 动态尝试加载官方编码工具
	try {
		const toolsModule = await loadDurableModule("tools").catch(() => null);

		if (toolsModule && toolsModule.CodingTools) {
			registry.install(toolsModule.CodingTools);
			installedToolNames.push("read", "write", "edit", "bash");
		}
	} catch {
		/* coding tools load failed */
	}

	// 注入工作区路径环境配置（如果存在 defineExtension）
	if (typeof durableModule.defineExtension === "function") {
		const WorkspaceEnv = durableModule.defineExtension({
			name: "workspace_env",
			environment: {
				cwd,
			},
		});
		registry.install(WorkspaceEnv);
	}

	return {
		registry,
		installedToolNames,
	};
}
