import { useEffect, useState } from "react";
import { appSend } from "../app-globals";
import { useT } from "../i18n";
import type { ProviderOAuthFlowState, ProviderStatus } from "../types";

export interface ProviderOAuthResultView {
	ok: boolean;
	cancelled?: boolean;
	error?: string;
}

export function ProviderOAuthControls({
	provider,
	flow,
	result,
}: {
	provider: ProviderStatus;
	flow?: ProviderOAuthFlowState;
	result?: ProviderOAuthResultView;
}) {
	const t = useT();
	const event = flow?.event;
	const accountName = provider.oauthName ?? provider.name;
	const [promptValue, setPromptValue] = useState("");
	useEffect(() => setPromptValue(""), [flow?.promptId]);
	if (provider.usingOAuth) {
		return (
			<div className="provider-oauth">
				<span className="provider-oauth-status">{t("oauthConnected", { name: accountName })}</span>
				<button
					type="button"
					className="btn sm danger"
					data-provider-oauth-logout={provider.id}
					onClick={() => appSend({ type: "provider_oauth_logout", provider: provider.id })}
				>
					{t("oauthLogout")}
				</button>
				{result?.error && <div className="provider-oauth-error">{result.error}</div>}
			</div>
		);
	}

	return (
		<div className="provider-oauth">
			{!flow ? (
				<button
					type="button"
					className="btn primary sm"
					data-provider-oauth-login={provider.id}
					onClick={() => appSend({ type: "provider_oauth_start", provider: provider.id })}
				>
					{t("oauthLogin", { name: accountName })}
				</button>
			) : (
				<>
					{event?.type === "device_code" && (
						<div className="provider-oauth-device">
							<div>{t("oauthDeviceCode")}</div>
							<code data-oauth-device-code>{event.userCode}</code>
							<a data-oauth-verification-url href={event.verificationUri} target="_blank" rel="noreferrer">
								{t("oauthOpenVerification")}
							</a>
						</div>
					)}
					{event?.type === "auth_url" && (
						<div className="provider-oauth-event">
							{event.instructions && <div>{event.instructions}</div>}
							<a href={event.url} target="_blank" rel="noreferrer">
								{t("oauthOpenVerification")}
							</a>
						</div>
					)}
					{event?.type === "progress" && <div className="provider-oauth-message">{event.message}</div>}
					{event?.type === "info" && (
						<div className="provider-oauth-event">
							<div>{event.message}</div>
							{event.links?.map((link) => (
								<a href={link.url} target="_blank" rel="noreferrer" key={link.url}>
									{link.label ?? link.url}
								</a>
							))}
						</div>
					)}
					{flow.prompt && <div className="provider-oauth-message">{flow.prompt.message}</div>}
					{flow.prompt?.type === "select" && flow.promptId && (
						<div className="provider-oauth-options">
							{flow.prompt.options.map((option) => (
								<button
									type="button"
									className="btn sm"
									data-oauth-option={option.id}
									key={option.id}
									onClick={() =>
										appSend({
											type: "provider_oauth_reply",
											flowId: flow.flowId,
											promptId: flow.promptId!,
											value: option.id,
										})
									}
								>
									{option.label}
								</button>
							))}
						</div>
					)}
					{flow.prompt && flow.prompt.type !== "select" && flow.promptId && (
						<form
							className="provider-oauth-prompt"
							onSubmit={(event) => {
								event.preventDefault();
								if (!promptValue.trim()) return;
								appSend({
									type: "provider_oauth_reply",
									flowId: flow.flowId,
									promptId: flow.promptId!,
									value: promptValue.trim(),
								});
							}}
						>
							<input
								data-oauth-prompt-input
								type={flow.prompt.type === "secret" ? "password" : "text"}
								className="key-input"
								placeholder={flow.prompt.placeholder}
								value={promptValue}
								onChange={(event) => setPromptValue(event.target.value)}
							/>
							<button type="submit" className="btn primary sm" data-oauth-prompt-submit disabled={!promptValue.trim()}>
								{t("oauthContinue")}
							</button>
						</form>
					)}
					<button
						type="button"
						className="btn sm danger"
						data-oauth-cancel={flow.flowId}
						onClick={() => appSend({ type: "provider_oauth_cancel", flowId: flow.flowId })}
					>
						{t("cancel")}
					</button>
				</>
			)}
			{result?.error && <div className="provider-oauth-error">{result.error}</div>}
		</div>
	);
}
