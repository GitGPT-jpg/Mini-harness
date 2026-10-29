/**
 * durable-capabilities.ts — Pi Durable 引擎的能力事实源。
 */

import { DEFAULT_DURABLE_CAPABILITIES } from "../engine-capabilities.js";
import type { AgentEngineCapabilities } from "../protocol.js";

export { DEFAULT_DURABLE_CAPABILITIES };

export function resolveDurableCapabilities(caps?: Partial<AgentEngineCapabilities> | null): AgentEngineCapabilities {
	return {
		...DEFAULT_DURABLE_CAPABILITIES,
		...caps,
	};
}
