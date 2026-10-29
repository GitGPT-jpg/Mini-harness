// 打包 vis-timeline 专业时间轴为 run-trace 插件自带 vendor（离线优先）。
//
// 复制 node_modules 预构建产物（standalone min.mjs 自含 Timeline/DataSet，
// 无需 esbuild 二次打包）+ 精简 CSS → plugins/run-trace/client/vendor/。
// 该目录是构建产物，提交进 git（与 mermaid vendor 惯例一致）；随插件目录
// 一起复制到 <dataDir>/plugins/run-trace/ 即可完全离线使用（缺失时客户端
// 自动回退 esm.sh CDN，再失败则回退手写 div 时间轴，绝不白屏）。
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = join(ROOT, "plugins", "run-trace", "client", "vendor");
mkdirSync(VENDOR, { recursive: true });

const { version } = JSON.parse(readFileSync(join(ROOT, "node_modules", "vis-timeline", "package.json"), "utf8"));
const SRC_JS = join(ROOT, "node_modules", "vis-timeline", "standalone", "esm", "vis-timeline-graph2d.min.mjs");
const SRC_CSS = join(ROOT, "node_modules", "vis-timeline", "styles", "vis-timeline-graph2d.min.css");

const js = readFileSync(SRC_JS, "utf8");
writeFileSync(
	join(VENDOR, "vis-timeline.bundle.mjs"),
	`/** vis-timeline v${version} standalone (min) — run-trace vendor, offline-first. See scripts/build-runtrace-vendor.mjs. */\n${js}`,
);
copyFileSync(SRC_CSS, join(VENDOR, "vis-timeline.css"));
console.log(`✓ run-trace vendor ← vis-timeline v${version}`);
