/**
 * 输入发现、归一化与缺口判断（自 dsh-inference-workbench `src/discovery.ts` 原样移植）。
 *
 * 只做本地工作区发现 + 必要输入缺口 + 来源/冲突提示；发现是只读的，不执行任何命令。
 * kubeconfig / 集群绑定发现留待后续阶段接入。
 */
import fs from "node:fs";

/**
 * 归一化任务输入：user > discovery > project-config > pack-default > 缺失。
 * 返回每个必要输入的最终值、来源，以及缺失 / 冲突清单。
 */
export function resolveTaskInputs(pack, workspace, userInputs, projectConfig = {}, discoveredInputs = {}) {
	const inputs = [];
	const missing = [];
	const conflicts = [];
	const discovered = [];

	for (const input of pack.inputs) {
		const src = input.source ?? "user";
		const userValue = String(userInputs[input.id] ?? "").trim();
		const discoveredValue = String(discoveredInputs[input.id] ?? "").trim();
		const packDefault = input.defaultValue != null ? String(input.defaultValue) : "";
		const projValue = String(projectConfig[input.id] ?? "").trim();

		let value = "";
		let source = src;
		let conflict = "";

		if (userValue) {
			value = userValue;
			source = "user";
			// 用户显式值与发现值/项目配置不一致时给冲突提示（用户值优先）。
			if (discoveredValue && discoveredValue !== userValue) {
				conflict = `输入「${input.label}」用户填写(${userValue})与环境发现(${discoveredValue})不一致，已采用用户值。`;
			} else if (projValue && projValue !== userValue) {
				conflict = `输入「${input.label}」用户填写(${userValue})与项目配置(${projValue})不一致，已采用用户值。`;
			}
		} else if (discoveredValue) {
			value = discoveredValue;
			source = "discovery";
			discovered.push({ key: input.id, value: discoveredValue, source: "discovery" });
		} else if (projValue) {
			value = projValue;
			source = "project-config";
			discovered.push({ key: input.id, value: projValue, source: "project-config" });
		} else if (packDefault) {
			value = packDefault;
			source = "pack-default";
			discovered.push({ key: input.id, value: packDefault, source: "pack-default" });
		} else if (input.required) {
			missing.push(input.id);
			continue;
		}

		if (conflict) conflicts.push(conflict);
		inputs.push({ key: input.id, label: input.label, value, source });
	}

	// 工作目录是任务级必要项（不属于 pack.inputs）。
	if (!workspace || !fs.existsSync(workspace)) {
		missing.push("workspace");
	} else {
		discovered.push({ key: "workspace", value: workspace, source: "discovery" });
	}

	return { inputs, missing, conflicts, discovered };
}

/** 取某个输入在当前归一化结果里的值（无则空串）。 */
export function inputValue(inputs, key) {
	return inputs.find((i) => i.key === key)?.value ?? "";
}
