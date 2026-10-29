/**
 * 构建脚本：把 src/client.js 连同 CodeMirror / xterm 依赖打包成 client/entry.mjs
 * （插件静态服务只暴露 client/ 子树，产物必须自包含、无 bare import）。
 *
 * xterm 的 CSS 以文本方式内联进 bundle（mount 时注入 <style>）。
 * 用法：npm install && npm run build
 */
import { build } from "esbuild";

await build({
	entryPoints: ["src/client.js"],
	bundle: true,
	format: "esm",
	outfile: "client/entry.mjs",
	target: "es2022",
	charset: "utf8",
	minify: false, // 入库可读；要体积可改 true
	loader: { ".css": "text" }, // import "@xterm/xterm/css/xterm.css" → 字符串
	banner: { js: "/* vscode-editor 客户端 bundle —— 由 npm run build 生成，源码在 src/client.js */" },
});
console.log("built → client/entry.mjs");
