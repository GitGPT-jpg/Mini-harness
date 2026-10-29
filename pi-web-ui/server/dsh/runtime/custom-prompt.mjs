/**
 * pi-web-ui custom prompt section (host plane).
 *
 * pi-web-ui 的自定义系统提示词在预设时代的载体：官方 preset 的 persona 行会
 * shadow 掉部署人设（standard/ptc/cordis），minimal（complete:true）更压住一切，
 * 所以沿用 system-prompt 行（DSH_PERSONA）已无法让用户的自定义提示词生效。
 * 本行在 host plane 注册一个独立 section（deployment:persona-suffix 之后），
 * standard/ptc/cordis 下随系统提示词下发，minimal 下被 complete 压住（官方语义）。
 *
 * 文本来自环境变量 PI_WEB_DSH_CUSTOM_PROMPT（Node 侧 dsh-agent-service 维护，
 * 变化即重启运行时）；为空时不注册任何 section。无 Config export（loader 允许，
 * 与 dsh-tool-ask-user 同形）。
 */

const name = "pi-webui-custom-prompt";
const inject = ["systemPrompt"];

function apply(ctx) {
	const text = (process.env.PI_WEB_DSH_CUSTOM_PROMPT ?? "").trim();
	if (!text) return;
	const order = ctx.systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_SUFFIX") + 50;
	ctx.effect(
		() =>
			ctx.systemPrompt.section({
				name: "pi-webui:custom-prompt",
				order,
				text,
			}),
		"pi-webui-custom-prompt.section()",
	);
}

export { apply, inject, name };
