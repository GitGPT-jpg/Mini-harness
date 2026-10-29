import { randomUUID } from "node:crypto";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProviderOAuthEventPayload, ProviderOAuthPromptPayload, ServerMessage } from "./protocol.js";

type AuthInteraction = Parameters<ModelRuntime["login"]>[2];
type AuthPrompt = Parameters<AuthInteraction["prompt"]>[0];
type AuthEvent = Parameters<AuthInteraction["notify"]>[0];

interface PendingPrompt {
	id: string;
	payload: ProviderOAuthPromptPayload;
	resolve: (value: string) => void;
	reject: (error: Error) => void;
	cleanup: () => void;
}

interface OAuthFlow {
	id: string;
	provider: string;
	abort: AbortController;
	prompt?: PendingPrompt;
	event?: ProviderOAuthEventPayload;
}

export interface ProviderOAuthFlowHost {
	modelRuntime: () => ModelRuntime;
	emit: (message: ServerMessage) => void;
	isDisposed: () => boolean;
	onLoginSuccess: (provider: string) => Promise<void>;
}

function promptPayload(prompt: AuthPrompt): ProviderOAuthPromptPayload {
	if (prompt.type === "select") {
		return {
			type: "select",
			message: prompt.message,
			options: prompt.options.map((option) => ({ ...option })),
		};
	}
	return {
		type: prompt.type,
		message: prompt.message,
		...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
	};
}

function eventPayload(event: AuthEvent): ProviderOAuthEventPayload {
	if (event.type === "info") {
		return {
			type: "info",
			message: event.message,
			...(event.links === undefined ? {} : { links: event.links.map((link) => ({ ...link })) }),
		};
	}
	return { ...event };
}

export class ProviderOAuthFlowManager {
	private readonly flows = new Map<string, OAuthFlow>();
	private disposed = false;

	constructor(private readonly host: ProviderOAuthFlowHost) {}

	start(provider: string): string | null {
		if (this.disposed) return null;
		const providerId = provider.trim();
		const runtimeProvider = this.host.modelRuntime().getProvider(providerId);
		if (!providerId || !runtimeProvider?.auth.oauth) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: "该服务商不支持 OAuth 登录",
				textEn: "This provider does not support OAuth login",
			});
			return null;
		}
		const existing = [...this.flows.values()].find((flow) => flow.provider === providerId);
		if (existing) return existing.id;

		const flow: OAuthFlow = { id: randomUUID(), provider: providerId, abort: new AbortController() };
		this.flows.set(flow.id, flow);
		this.host.emit({ type: "provider_oauth_started", flowId: flow.id, provider: providerId });
		void this.run(flow);
		return flow.id;
	}

	reply(flowId: string, promptId: string, value: string): void {
		const flow = this.flows.get(flowId);
		if (!flow?.prompt || flow.prompt.id !== promptId) return;
		const pending = flow.prompt;
		flow.prompt = undefined;
		pending.cleanup();
		pending.resolve(value);
	}

	cancel(flowId: string): void {
		this.flows.get(flowId)?.abort.abort();
	}

	list(): void {
		this.host.emit({
			type: "provider_oauth_flows",
			flows: [...this.flows.values()].map((flow) => ({
				flowId: flow.id,
				provider: flow.provider,
				...(flow.prompt ? { promptId: flow.prompt.id, prompt: flow.prompt.payload } : {}),
				...(flow.event ? { event: flow.event } : {}),
			})),
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const flow of this.flows.values()) flow.abort.abort();
		this.flows.clear();
	}

	private async run(flow: OAuthFlow): Promise<void> {
		try {
			await this.host.modelRuntime().login(flow.provider, "oauth", {
				signal: flow.abort.signal,
				prompt: (prompt) => this.prompt(flow, prompt),
				notify: (event) => {
					if (this.disposed || this.host.isDisposed()) return;
					flow.event = eventPayload(event);
					this.host.emit({
						type: "provider_oauth_event",
						flowId: flow.id,
						provider: flow.provider,
						event: flow.event,
					});
				},
			});
			if (this.disposed || this.host.isDisposed()) return;
			await this.host.onLoginSuccess(flow.provider);
			this.host.emit({ type: "provider_oauth_result", flowId: flow.id, provider: flow.provider, ok: true });
		} catch (error) {
			if (this.disposed || this.host.isDisposed()) return;
			const cancelled = flow.abort.signal.aborted;
			this.host.emit({
				type: "provider_oauth_result",
				flowId: flow.id,
				provider: flow.provider,
				ok: false,
				...(cancelled ? { cancelled: true } : { error: error instanceof Error ? error.message : String(error) }),
			});
		} finally {
			flow.prompt?.cleanup();
			this.flows.delete(flow.id);
		}
	}

	private prompt(flow: OAuthFlow, prompt: AuthPrompt): Promise<string> {
		if (this.disposed || this.host.isDisposed() || flow.abort.signal.aborted || prompt.signal?.aborted) {
			return Promise.reject(new Error("OAuth prompt cancelled"));
		}
		return new Promise<string>((resolve, reject) => {
			const promptId = randomUUID();
			const payload = promptPayload(prompt);
			const abortPrompt = () => {
				if (flow.prompt?.id !== promptId) return;
				const pending = flow.prompt;
				flow.prompt = undefined;
				pending?.cleanup();
				reject(new Error("OAuth prompt cancelled"));
			};
			const cleanup = () => {
				flow.abort.signal.removeEventListener("abort", abortPrompt);
				prompt.signal?.removeEventListener("abort", abortPrompt);
			};
			flow.prompt = { id: promptId, payload, resolve, reject, cleanup };
			flow.abort.signal.addEventListener("abort", abortPrompt, { once: true });
			prompt.signal?.addEventListener("abort", abortPrompt, { once: true });
			this.host.emit({
				type: "provider_oauth_prompt",
				flowId: flow.id,
				provider: flow.provider,
				promptId,
				prompt: payload,
			});
		});
	}
}
