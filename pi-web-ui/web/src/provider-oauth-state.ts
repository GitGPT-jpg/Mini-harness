import type { ProviderOAuthFlowState, ServerMessage } from "./types";

export interface ProviderOAuthResultState {
	ok: boolean;
	cancelled?: boolean;
	error?: string;
}

interface ProviderOAuthClientState {
	flows: ProviderOAuthFlowState[];
	results: Record<string, ProviderOAuthResultState>;
}

export type ProviderOAuthServerMessage = Extract<
	ServerMessage,
	{
		type:
			| "provider_oauth_started"
			| "provider_oauth_flows"
			| "provider_oauth_prompt"
			| "provider_oauth_event"
			| "provider_oauth_result"
			| "provider_oauth_logout_result";
	}
>;

export function initialProviderOAuthState(): ProviderOAuthClientState {
	return { flows: [], results: {} };
}

function replaceFlow(flows: ProviderOAuthFlowState[], next: ProviderOAuthFlowState): ProviderOAuthFlowState[] {
	const index = flows.findIndex((flow) => flow.flowId === next.flowId);
	if (index < 0) return [...flows, next];
	return flows.map((flow, current) => (current === index ? next : flow));
}

export function reduceProviderOAuthState(
	state: ProviderOAuthClientState,
	message: ProviderOAuthServerMessage,
): ProviderOAuthClientState {
	switch (message.type) {
		case "provider_oauth_started": {
			const results = { ...state.results };
			delete results[message.provider];
			return {
				flows: [
					...state.flows.filter((flow) => flow.provider !== message.provider),
					{ flowId: message.flowId, provider: message.provider },
				],
				results,
			};
		}
		case "provider_oauth_flows":
			return { ...state, flows: message.flows.map((flow) => ({ ...flow })) };
		case "provider_oauth_prompt": {
			const current = state.flows.find((flow) => flow.flowId === message.flowId);
			return {
				...state,
				flows: replaceFlow(state.flows, {
					...current,
					flowId: message.flowId,
					provider: message.provider,
					promptId: message.promptId,
					prompt: message.prompt,
				}),
			};
		}
		case "provider_oauth_event": {
			const current = state.flows.find((flow) => flow.flowId === message.flowId);
			// event 到达 = 登录阶段推进，之前的 prompt 已作废必须清掉：服务端 reply()
			// 只 resolve promise，不下发“prompt 已回答”消息，这里是唯一的老 prompt 清理点，
			// 不要改成保留（否则答完的 select 按钮/输入框会残留，还能重复提交）。
			// 并发显示靠另一侧保证：prompt 分支保留 event，而 SDK 总是先 notify 后 prompt
			//（Codex browser 路径：notify(auth_url) → prompt(manual_code)），所以两者能同屏。
			return {
				...state,
				flows: replaceFlow(state.flows, {
					...current,
					flowId: message.flowId,
					provider: message.provider,
					event: message.event,
					promptId: undefined,
					prompt: undefined,
				}),
			};
		}
		case "provider_oauth_result":
			return {
				flows: state.flows.filter((flow) => flow.flowId !== message.flowId),
				results: {
					...state.results,
					[message.provider]: {
						ok: message.ok,
						...(message.cancelled === undefined ? {} : { cancelled: message.cancelled }),
						...(message.error === undefined ? {} : { error: message.error }),
					},
				},
			};
		case "provider_oauth_logout_result":
			return {
				...state,
				results: {
					...state.results,
					[message.provider]: {
						ok: message.ok,
						...(message.error === undefined ? {} : { error: message.error }),
					},
				},
			};
	}
}
