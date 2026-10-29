// 打包 mermaid 引擎为自包含 ESM bundle → plugins/mermaid/vendor/mermaid.bundle.mjs。
//
// 目的：mermaid renderer 插件「自带引擎」——把 bundle 随插件目录一起复制到
// <dataDir>/plugins/mermaid/vendor/ 即可**完全离线**渲染（不碰 CDN）；没有
// vendor 文件时插件自动回退 CDN（esm.sh）。
//
// 该文件是构建产物，提交进 git（与 vscode-editor 自带 bundle 的惯例一致）；
// npm 包不带（插件目录不在 package.json files 里，分发走 GitHub / 手动复制）。
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// 放 client/ 子树：插件的静态服务只暴露 /plugins/:id/client/*（安全设计），
// 浏览器动态 import 的 bundle 必须位于该子树内才能被加载。
const OUT = join(ROOT, "plugins", "mermaid", "client", "vendor", "mermaid.bundle.mjs");
mkdirSync(dirname(OUT), { recursive: true });

const { errors } = await build({
	stdin: {
		// 入口：mermaid 的 default 导出让浏览器动态 import ./vendor/... 时拿到
		// 与 npm 相同的 `mermaid` 对象（initialize/render 全量可用）。
		contents: 'import mermaid from "mermaid"; export default mermaid;',
		resolveDir: ROOT,
		sourcefile: "mermaid-vendor-entry.mjs",
	},
	bundle: true,
	format: "esm",
	platform: "browser",
	target: "es2020",
	minify: true,
	logLevel: "info",
	outfile: OUT,
});

if (errors.length > 0) {
	console.error("✗ mermaid vendor bundle 构建失败");
	process.exit(1);
}
console.log(`✓ mermaid vendor bundle → plugins/mermaid/vendor/mermaid.bundle.mjs`);
