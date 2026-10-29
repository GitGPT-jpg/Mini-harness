/**
 * 产物落盘规划 —— 决定「生成的图写到哪个相对路径」。
 *
 * 与宿主 fs 解耦：本模块只算出候选路径并调 `exists(rel)` 查重，真正的写入由
 * index.mjs 走 host.fs.write（工作区锚定、越界拒绝在宿主那层）。
 */
import * as U from "./gen-util.mjs";

/** 图片块 → 扩展名（先嗅探字节，再退回声明的 mime）。 */
export function extForImage(img) {
	const sniffed = U.sniffImageMime(img?.data);
	return U.mimeToExt(sniffed || img?.mimeType || "image/png");
}

/**
 * 规划输出路径。
 * input: {
 *   images, out?, outDir?, outputDir, template, prompt, model,
 *   exists: (rel) => Promise<boolean> | boolean   // 查重（宿主 fs 探测）
 * }
 * 返回 [{ rel, img }]（顺序与 images 一致）。
 */
export async function planOutputPaths(input) {
	const images = Array.isArray(input.images) ? input.images : [];
	const dir = U.normalizeRel(input.outDir) || U.normalizeRel(input.outputDir) || "generated";
	const explicit = U.normalizeRel(input.out);
	const out = [];
	for (let i = 0; i < images.length; i++) {
		const img = images[i];
		const ext = extForImage(img);
		let rel;
		if (explicit && images.length === 1) {
			rel = /\.[A-Za-z0-9]{2,5}$/.test(explicit) ? explicit : `${explicit}.${ext}`;
		} else if (explicit && i === 0) {
			rel = /\.[A-Za-z0-9]{2,5}$/.test(explicit) ? explicit : `${explicit}.${ext}`;
		} else {
			const base = U.filenameFromTemplate(input.template, {
				slug: input.prompt,
				model: input.model,
				n: i + 1,
			});
			rel = U.joinRel(dir, `${base}${images.length > 1 ? `-${i + 1}` : ""}.${ext}`);
		}
		// 查重：同名就加 -1、-2…（用户可能连点两次生成同一句提示词）
		let final = rel;
		let n = 1;
		while (await input.exists?.(final)) {
			const m = /^(.*?)(\.[A-Za-z0-9]{2,5})$/.exec(rel);
			final = m ? `${m[1]}-${n}${m[2]}` : `${rel}-${n}`;
			n += 1;
			if (n > 200) break; // 防极端情况下死循环
		}
		out.push({ rel: final, img });
	}
	return out;
}
