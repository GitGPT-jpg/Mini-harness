import { readFileSync } from "node:fs";
import { join } from "node:path";

const zhMessages: Record<string, { message: string; placeholders?: Record<string, { content: string }> }> = JSON.parse(
	readFileSync(
		join(process.cwd(), "plugins", "page-picker", "extension", "_locales", "zh_CN", "messages.json"),
		"utf8",
	),
);

export function createFakeI18n() {
	return {
		getMessage: (key: string, subs?: string | string[]) => {
			const entry = zhMessages[key];
			if (!entry) return key;
			let msg = entry.message;
			if (subs !== undefined) {
				const arr = Array.isArray(subs) ? subs : [subs];
				arr.forEach((val, i) => {
					msg = msg.replaceAll(`$${i + 1}`, String(val));
				});
				if (entry.placeholders) {
					for (const [name, ph] of Object.entries(entry.placeholders)) {
						const content = ph.content;
						const idx = parseInt(content.replace("$", ""), 10) - 1;
						if (arr[idx] !== undefined) {
							msg = msg.replaceAll(`$${name}$`, String(arr[idx]));
						}
					}
				}
			}
			return msg;
		},
		getUILanguage: () => "zh-CN",
	};
}
