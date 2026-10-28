import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOME = os.homedir();
// 路径全部运行时自推导（可移植）：harden.mjs 位于 <BASE>/pi-web-cockpit/ 下。
const COCKPIT = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.dirname(COCKPIT);
const DIST = path.join(COCKPIT, "node_modules/pi-web-ui/dist/server");
const log = (...a) => console.log("[harden]", ...a);

// 首装兜底：干净机器上 ~/.pi-web / ~/.pi/agent 可能还不存在，后续写 token / client-state / 子代理模板 / settings 都需要它们。
try {
  fs.mkdirSync(path.join(HOME, ".pi-web"), { recursive: true });
  fs.mkdirSync(path.join(HOME, ".pi/agent"), { recursive: true });
} catch {}

// 品牌图标：左上角 logo 用 icon1111（brand-logo.png），浏览器页签 favicon 用紫色 C（brand-favicon.png）。
// 两者分开，均读仓库内 PNG -> data URI（可逆）。
let BRAND_LOGO = "";
let BRAND_FAVICON = "";
try {
  const toData = (f) => (fs.existsSync(f) ? "data:image/png;base64," + fs.readFileSync(f).toString("base64") : "");
  BRAND_LOGO = toData(path.join(COCKPIT, "assets", "brand-logo.png"));
  BRAND_FAVICON = toData(path.join(COCKPIT, "assets", "brand-favicon.png"));
} catch {}

// 领域「灵魂」提示词：覆盖 pi 组合模板的 {{soul}} token（替换 pi 默认"编码助手"身份，
// 其余 {{tools}}/{{guidelines}}/{{pi_docs}} 等脚手架 token 保持自动生成不动）。
// 内容源自 5 个 workflow skill 的身份/核心原则/安全红线。
const DOMAIN_SOUL = [
  "你是训推引擎组的推理服务优化 agent，运行在 pi（一个编码智能体框架）中，工作围绕 infer-forge-harness（icode 仓库 baidu/hac-aiacc/infer-forge-harness）。你通过读取文件、执行命令、编辑代码和新建文件，帮助团队完成 sglang / AttentionStore / prefill / decode / cache 的优化与模型适配。",
  "",
  "工作准则：",
  "- 涉及 sglang / AttentionStore / prefill / decode / cache 优化或模型适配时，先用 inference-harness skill，并先读 AGENTS.md、目标 workflow 定义、tasks/REGISTRY.yaml、catalog/tool_catalog.yaml、SKILL.md 与 validator，再动手。",
  "- 优先复用 REGISTRY 已有原子任务，没有合适的才新增、新增后更新 REGISTRY 并重新生成 CATALOG；不过度设计。",
  "- 每步都要有明确 verify，以 validator 判定为准（返回码 / PASS 字样 / manifest 都不算通过）；产出 run id、artifact root、validator 结论、Journal 路径、证据路径，并与 baseline 对比。",
  "- 运行产物、Journal、run state 一律放源码仓库之外；失败保留原始证据，不打补丁绕过、不静默重试。",
  "",
  "安全红线（必须遵守）：",
  "- 删除实例 / 删除资源 / 缩减副本 / 杀共享进程 / 改端口拓扑 / 改 MODEL_ID / 改部署配置等高危操作，一律先说明理由并等人工确认。",
  "- 只能操作自己的 Pod；K8s 工作负载的删除、缩容、驱逐交给人类。",
  "- 联调环境团队共用：apply 后 Pod 长时间 Pending 多为资源不足，立即通知人类腾挪，不动别人的实例。",
].join("\n");

// ---- 1) 禁用 7 个风险技能（移出 Pi 技能发现目录，可逆）----
const skillsDir = path.join(HOME, ".pi/agent/skills");
const disabledDir = path.join(HOME, ".pi/agent/skills.disabled");
const toDisable = [
  "browser-tools",
  "transcribe",
  "brave-search",
  "gccli",
  "gdcli",
  "gmcli",
  "youtube-transcript",
];
fs.mkdirSync(disabledDir, { recursive: true });
for (const s of toDisable) {
  const src = path.join(skillsDir, "pi-skills", s);
  const dst = path.join(disabledDir, s);
  if (fs.existsSync(src)) {
    if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
    fs.renameSync(src, dst);
    log("已禁用技能:", s);
  } else {
    log("技能已禁用/不存在:", s);
  }
}

// ---- 2) 关闭远程 SSH 能力声明（pi 引擎）----
const capFile = path.join(DIST, "engine-capabilities.js");
let cap = fs.readFileSync(capFile, "utf8");
if (cap.includes("remoteSsh: true,")) {
  cap = cap.replace("remoteSsh: true,", "remoteSsh: false,");
  fs.writeFileSync(capFile, cap);
  log("已关闭 remoteSsh 能力");
} else {
  log("remoteSsh 已关闭（跳过）");
}

// ---- 2b) 推理场景精简：关 Pi 引擎 sandbox / planMode / delegateMode / subagents / pageRef ----
// 这些 UI 模式与 inference-harness skill 里的 AI Loop 编排功能重叠；pageRef 对应 Page Picker 入口。
// 仅改 DEFAULT_PI_CAPABILITIES 块，presentFiles 保留 true（推理产出 report/chart 成果卡片需要）。
{
  cap = fs.readFileSync(capFile, "utf8");
  const piStart = cap.indexOf("DEFAULT_PI_CAPABILITIES = Object.freeze({");
  const piEnd = piStart === -1 ? -1 : cap.indexOf("});", piStart);
  if (piStart !== -1 && piEnd !== -1) {
    let block = cap.slice(piStart, piEnd);
    const off = ["sandboxes", "planMode", "delegateMode", "subagents", "pageRef"];
    let changed = false;
    for (const k of off) {
      const re = new RegExp(`(${k}:\\s*)true`);
      if (re.test(block)) { block = block.replace(re, `$1false`); changed = true; }
    }
    if (changed) {
      cap = cap.slice(0, piStart) + block + cap.slice(piEnd);
      fs.writeFileSync(capFile, cap);
      log("已精简 Pi 能力: sandbox/planMode/delegateMode/subagents/pageRef -> false (presentFiles 保留)");
    } else log("Pi 能力已精简（跳过）");
  } else log("WARN: 未找到 DEFAULT_PI_CAPABILITIES 块");
}

// ---- 2c) 只允许 pi 引擎：前端引擎清单裁成单个 pi（去掉 dsh/claude/durable 卡片与热切）----
// 引擎清单是前端 bundle 里的硬编码数组 ls=[{id:`pi`...},{id:`dsh`...},...]。
// 把 pi 之后的三个引擎对象删掉，设置页只剩 pi、底栏引擎选择器也只有 pi 一项。
{
  const bundleDir = path.join(DIST, "..", "..", "web", "dist", "assets");
  const files = fs.readdirSync(bundleDir).filter((n) => /^index-.*\.js$/.test(n));
  let done = false;
  for (const fn of files) {
    const fp = path.join(bundleDir, fn);
    let js = fs.readFileSync(fp, "utf8");
    // 锚点：pi 定义结尾 → durable 数组结尾。把中间(含 dsh/claude/durable)整体替成 "}]"
    const head = "@earendil-works/pi-coding-agent`},{id:`dsh`";
    const tail = "@earendil-works/pi-durable`}];";
    if (js.includes("@earendil-works/pi-coding-agent`}];")) { log("引擎清单已裁为 pi-only（跳过）"); done = true; break; }
    const hi = js.indexOf(head);
    const ti = js.indexOf(tail);
    if (hi !== -1 && ti !== -1 && ti > hi) {
      // 保留到 pi 的 installCommand 闭合 "}`}"，然后直接 "];"
      const keepUpto = js.indexOf("`}", hi) + 2; // 指向 pi 对象的 "}" 之后
      const rest = js.slice(ti + tail.length);
      js = js.slice(0, keepUpto) + "];" + rest;
      fs.writeFileSync(fp, js);
      log(`引擎清单已裁为 pi-only（${fn}）`);
      done = true;
      break;
    }
  }
  if (!done) log("WARN: 未在 bundle 中定位引擎清单（可能已变更）");
}

// ---- 2e) 彻底关闭 codemode：SDK 的 CodemodeMode 只有 on/only，无法用设置关闭，
//         故把它的扩展工厂换成空实现（不再注册 codemode 工具）。幂等可逆。----
try {
  const agentFile = path.join(DIST, "agent-service.js");
  let js = fs.readFileSync(agentFile, "utf8");
  const codeMarker = "HARDENED:codemode-off";
  if (!js.includes(codeMarker)) {
    const needle = "factory: createCodemodeExtension(),";
    if (js.includes(needle)) {
      js = js.replace(needle, `factory: () => {}, /* ${codeMarker} */`);
      fs.writeFileSync(agentFile, js);
      log("已关闭 codemode 扩展（空实现，工具不再注册）");
    } else log("WARN: 未定位 createCodemodeExtension 工厂");
  } else log("codemode 已关闭（跳过）");
} catch (e) {
  log("WARN: codemode 关闭失败", e.message);
}

// ---- 3) 服务端彻底拒绝远程 SSH 消息 ----
const dispFile = path.join(DIST, "dispatch-domain-handlers.js");
let disp = fs.readFileSync(dispFile, "utf8");
const sshMarker = "/* HARDENED:remote-ssh-off */";
if (!disp.includes(sshMarker)) {
  const needle = "export function handleRemoteSshMessage(msg, remoteSshSvc, send) {";
  if (disp.includes(needle)) {
    disp = disp.replace(
      needle,
      needle +
        "\n    " +
        sshMarker +
        '\n    if (typeof msg.type === "string" && msg.type.startsWith("remote_ssh_")) {\n        try { send({ type: "remote_ssh_disabled", reqId: msg.reqId, error: "remote SSH disabled by security hardening" }); } catch {}\n        return true;\n    }',
    );
    fs.writeFileSync(dispFile, disp);
    log("已禁用远程 SSH 消息处理");
  } else log("WARN: 未找到 handleRemoteSshMessage");
} else log("远程 SSH 已禁用（跳过）");

// ---- 4) 封禁 /api/preview/__abs__ 任意文件读 ----
const idxFile = path.join(DIST, "index.js");
let idx = fs.readFileSync(idxFile, "utf8");
const absMarker = "/* HARDENED:abs-preview-off */";
if (!idx.includes(absMarker)) {
  const needle = 'const ABS_MARKER = "__abs__/";';
  if (idx.includes(needle)) {
    idx = idx.replace(
      needle,
      needle +
        "\n        " +
        absMarker +
        '\n        if (captured === "__abs__" || captured.startsWith(ABS_MARKER)) { res.status(403).end("absolute preview disabled"); return; }',
    );
    fs.writeFileSync(idxFile, idx);
    log("已封禁 __abs__ 任意文件读");
  } else log("WARN: 未找到 ABS_MARKER");
} else log("__abs__ 已封禁（跳过）");

// ---- 5) 驾驶舱设置：禁 eval、关 codemode、禁技能 + 推理场景精简开关（纵深防御）----
// 首装时 client-state.json 尚不存在（由浏览器连接后才生成）；先播种一份 sanitized 的默认设置，
// 否则下面的开关与领域身份在首装会被跳过（这正是干净机器上"定制丢失"的根因）。
const csFile = path.join(HOME, ".pi-web/client-state.json");
const csSeed = path.join(COCKPIT, "config", "client-state.seed.json");
try {
  if (!fs.existsSync(csFile) && fs.existsSync(csSeed)) {
    fs.copyFileSync(csSeed, csFile);
    log("已播种 client-state（首装默认设置）");
  }
} catch (e) {
  log("WARN: client-state 播种失败", e.message);
}
try {
  const cs = JSON.parse(fs.readFileSync(csFile, "utf8"));
  const st = cs.__settings__?.settings;
  if (st) {
    const tools = new Set(st.disabledAgentTools || []);
    tools.add("eval");
    st.disabledAgentTools = [...tools];
    st.codemodeMode = "off";
    const sk = new Set(st.disabledSkills || []);
    for (const s of toDisable) sk.add(s);
    st.disabledSkills = [...sk];
    st.terminalToolsEnabled = false;
    st.terminalBash = false;
    // 推理场景精简：关多模态/目标模式/工具图像，开工具懒加载（省 token、稳 prompt cache 前缀）
    st.visionBridgeEnabled = false;
    st.goalModeEnabled = true;
    st.toolImagesEnabled = false;
    st.toolLazyLoading = true;
    // A) 领域身份：只覆盖组合模板的 {{soul}} token（替换 pi 默认"编码助手"身份），
    //    其余 tools/guidelines/pi_docs 等脚手架 token 保持自动生成。清掉旧的整体 append。
    st.customSystemPrompt = "";
    st.promptMode = "append";
    st.promptTemplate = st.promptTemplate || "";
    st.promptOverrides = { ...(st.promptOverrides || {}), soul: DOMAIN_SOUL };
    fs.writeFileSync(csFile, JSON.stringify(cs, null, 2));
    log("已更新 client-state：eval off + codemode off + 禁技能 + 推理精简开关 + 领域 soul 覆盖");
  } else log("WARN: client-state 缺少 __settings__");
} catch (e) {
  log("WARN: client-state 更新失败", e.message);
}

// ---- 6) 生成访问口令 + 加固启动脚本 ----
const tokenFile = path.join(HOME, ".pi-web/pi-web-token");
if (!fs.existsSync(tokenFile)) {
  fs.writeFileSync(tokenFile, crypto.randomBytes(24).toString("hex"), { mode: 0o600 });
  log("已生成访问口令 ->", tokenFile);
} else log("口令已存在（跳过）");

const startSh = path.join(COCKPIT, "start-hardened.sh");
fs.writeFileSync(
  startSh,
  `#!/usr/bin/env bash
set -euo pipefail
# 路径运行时自推导（可移植）：脚本在 <BASE>/pi-web-cockpit/ 下，cwd 取 <BASE>。
HERE="$(cd "$(dirname "\${BASH_SOURCE[0]:-$0}")" && pwd)"
BASE="$(cd "$HERE/.." && pwd)"
export PI_WEB_TOKEN="$(cat "$HOME/.pi-web/pi-web-token")"
export PI_WEB_LOCALE="zh"
export PI_WEB_ENGINE="pi"
export PI_WEB_MANAGED="1"
# 若已建堡垒机隧道（~/.mini-harness/proxy.env 存在），继承代理环境，子进程 kubectl 才能连内网
[ -f "$HOME/.mini-harness/proxy.env" ] && . "$HOME/.mini-harness/proxy.env"
# Finder/LaunchServices 双击启动时 PATH 很精简，可能找不到 node；补上常见位置
for d in "$HOME/.local/share/pi-node/current/bin" /usr/local/bin /opt/homebrew/bin; do
  [ -x "$d/node" ] && PATH="$d:$PATH"
done
export PATH
command -v node >/dev/null 2>&1 || { echo "错误：未找到 node（需要 Node.js 22.19+）。" >&2; exit 1; }
exec "$HERE/node_modules/.bin/pi-web-ui" --host 127.0.0.1 --port 8787 --cwd "$BASE" --no-browser "$@"
`,
  { mode: 0o700 },
);
log("已写启动脚本:", startSh);

// ---- 7) 前端入口精简：隐藏不受 capability 门控的入口（CSS 注入，可逆）----
// capabilities 已关 sandbox/plan/delegate/subagents/pageRef，但部分入口仍由前端直渲，
// 用一段 <style> 把它们隐掉，不动 bundle 逻辑。保留 <img> 图片与 present_files 成果卡片。
const htmlFile = path.join(DIST, "..", "..", "web", "dist", "index.html");
try {
  let html = fs.readFileSync(htmlFile, "utf8");
  const trimMarker = "HARDENED:trim-entries";
  const styleBlock =
    `\t\t<!-- ${trimMarker} 推理场景精简：隐藏不需要的入口（可逆）。 -->\n` +
    `\t\t<style id="pi-trim-entries">\n` +
    `\t\t\t/* 沙盒入口：顶栏 + 最近项目区 */\n` +
    `\t\t\t[data-bar-item="host:new-sandbox"],\n` +
    `\t\t\t.sandbox-chip,\n` +
    `\t\t\t.lp-sandbox-action { display: none !important; }\n` +
    `\t\t\t/* 顶栏入口：画布协同 / 极简模式 / 临时对话 */\n` +
    `\t\t\t[data-bar-item="host:canvas"],\n` +
    `\t\t\t[data-bar-item="host:zen-mode"],\n` +
    `\t\t\t[data-bar-item="host:new-ephemeral-chat"] { display: none !important; }\n` +
    `\t\t\t/* 底栏引擎切换器：锁定单引擎 pi，关掉"点击切换智能体引擎"入口 */\n` +
    `\t\t\t[data-bar-item="host:engine"] { display: none !important; }\n` +
    `\t\t\t/* 富媒体音视频播放：砍播放器，保留图片(<img>)与 present_files 成果卡片 */\n` +
    `\t\t\taudio, video,\n` +
    `\t\t\t.present-media-video, .present-media-audio,\n` +
    `\t\t\t.fp-audio-wrap, .fp-audio-element { display: none !important; }\n` +
    `\t\t\t/* 品牌名替换：pi-web-ui -> 训推引擎组 Harness（字面量隐藏 + ::after 覆盖，可逆） */\n` +
    `\t\t\t.brand-name { font-size: 0 !important; }\n` +
    `\t\t\t.brand-name::after { content: "训推引擎组 Harness"; font-size: 12px; font-weight: 600; letter-spacing: 0.2px; white-space: nowrap; }\n` +
    (BRAND_LOGO
      ? `\t\t\t/* 左上角 pi logo 换成 icon1111（content 覆盖 <img> 渲染，可逆） */\n` +
        `\t\t\t.brand-logo { content: url("${BRAND_LOGO}") !important; object-fit: contain !important; }\n`
      : "") +
    `\t\t</style>\n\t`;
  if (!html.includes(trimMarker)) {
    html = html.replace("</head>", styleBlock + "</head>");
    fs.writeFileSync(htmlFile, html);
    log("已注入前端入口精简 CSS（隐藏沙盒入口 + 音视频播放器）");
  } else {
    // 幂等更新：若标记已存在但内容过时，整体替换 style 块
    const re = /\t*<!-- HARDENED:trim-entries[\s\S]*?<\/style>\n\t?/;
    const updated = html.replace(re, styleBlock);
    if (updated !== html) {
      fs.writeFileSync(htmlFile, updated);
      log("已更新前端入口精简 CSS（同步最新规则）");
    } else log("前端入口精简已是最新（跳过）");
  }
} catch (e) {
  log("WARN: 前端入口精简注入失败", e.message);
}

// ---- 7b) 页签标题 + favicon 品牌化（标题是前端动态设置的，用脚本锁定+观察，可逆）----
try {
  let html = fs.readFileSync(htmlFile, "utf8");
  const brandMarker = "HARDENED:brand-fix";
  const scriptBlock =
    `\t\t<!-- ${brandMarker} 页签标题与 favicon 品牌化（可逆）。 -->\n` +
    `\t\t<script id="pi-brand-fix">\n` +
    `\t\t(function(){try{\n` +
    `\t\t\t// 清除 PWA 残留：注销 SW + 清 caches，确保始终加载最新品牌态\n` +
    `\t\t\ttry{if("serviceWorker" in navigator){navigator.serviceWorker.getRegistrations().then(function(rs){rs.forEach(function(r){r.unregister();});}).catch(function(){});}}catch(e){}\n` +
    `\t\t\ttry{if(window.caches&&caches.keys){caches.keys().then(function(ks){ks.forEach(function(k){caches.delete(k);});}).catch(function(){});}}catch(e){}\n` +
    `\t\t\tvar T="训推引擎组 Harness";var ICON=${JSON.stringify(BRAND_FAVICON)};\n` +
    `\t\t\tfunction setFav(){try{if(!ICON)return;var ls=document.querySelectorAll('link[rel*="icon"]');if(ls.length)ls.forEach(function(l){l.href=ICON;});else{var l=document.createElement("link");l.rel="icon";l.href=ICON;document.head.appendChild(l);}}catch(e){}}\n` +
    `\t\t\tfunction setTitle(){try{var t=document.querySelector("title");if(!t){t=document.createElement("title");document.head.appendChild(t);}if(t.textContent!==T)t.textContent=T;if(document.title!==T)document.title=T;}catch(e){}}\n` +
    `\t\t\tfunction start(){setTitle();setFav();var t=document.querySelector("title");if(t){new MutationObserver(setTitle).observe(t,{childList:true,characterData:true,subtree:true});}}\n` +
    `\t\t\tif(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start);else start();\n` +
    `\t\t\tsetInterval(function(){setTitle();setFav();},1500);\n` +
    `\t\t}catch(e){}})();\n` +
    `\t\t</script>\n\t`;
  if (!html.includes(brandMarker)) {
    html = html.replace("</head>", scriptBlock + "</head>");
    fs.writeFileSync(htmlFile, html);
    log("已注入页签标题 + favicon 品牌化");
  } else {
    const re = /\t*<!-- HARDENED:brand-fix[\s\S]*?pi-brand-fix">[\s\S]*?<\/script>\n\t?/;
    const updated = html.replace(re, scriptBlock);
    if (updated !== html) { fs.writeFileSync(htmlFile, updated); log("已更新页签标题/favicon 品牌化"); }
    else log("页签标题/favicon 品牌化已是最新（跳过）");
  }
} catch (e) {
  log("WARN: 页签/favicon 品牌化注入失败", e.message);
}

// ---- 7c) 改写静态 <title> 与 favicon：消除刷新时首帧闪回 pi-web-ui（直接改 index.html，随 harden 重放）----
// 7b 的脚本是在页面加载后才改标题/图标，首帧仍是 index.html 里写死的 pi-web-ui，刷新时会闪一下。
// 这里把 index.html 里的静态 <title> 和 favicon 链接直接改掉，首帧就是品牌态，无闪回。
try {
  let html = fs.readFileSync(htmlFile, "utf8");
  let changed = false;
  const newTitle = "<title>训推引擎组 Harness</title>";
  if (/<title>[^<]*<\/title>/.test(html) && !html.includes(newTitle)) {
    html = html.replace(/<title>[^<]*<\/title>/, newTitle);
    changed = true;
  }
  if (BRAND_FAVICON) {
    const favLink = `<link rel="icon" href="${BRAND_FAVICON}" />`;
    const appleLink = `<link rel="apple-touch-icon" href="${BRAND_FAVICON}" />`;
    const h2 = html
      .replace(/<link\b[^>]*\brel="icon"[^>]*>/, favLink)
      .replace(/<link\b[^>]*\brel="apple-touch-icon"[^>]*>/, appleLink);
    if (h2 !== html) { html = h2; changed = true; }
  }
  if (changed) { fs.writeFileSync(htmlFile, html); log("已改写静态标题/favicon（消除刷新闪回）"); }
  else log("静态标题/favicon 已是最新（跳过）");
} catch (e) {
  log("WARN: 静态标题/favicon 改写失败", e.message);
}

// ---- 7d) 覆盖磁盘图标文件：兜住浏览器直接请求 /favicon.svg、PWA/apple 图标与 brand-logo 原生 src ----
// 仅改 <link> 挡不住浏览器对 favicon 的顽固缓存与直连请求；把磁盘上被请求到的图标字节也换成品牌图标。
try {
  const webDist = path.join(DIST, "..", "..", "web", "dist");
  const logoFile = path.join(COCKPIT, "assets", "brand-logo.png");
  const favFile = path.join(COCKPIT, "assets", "brand-favicon.png");
  if (fs.existsSync(logoFile) && fs.existsSync(favFile)) {
    const logoPng = fs.readFileSync(logoFile);
    const favPng = fs.readFileSync(favFile);
    const favB64 = favPng.toString("base64");
    let n = 0;
    // icon-192 是左上角 brand-logo 的原生 src，放 icon1111；其余 PWA/图标放紫色 C
    for (const rel of ["icons/icon-192.png", "icons/icon-512.png", "icons/icon-1024.png",
                        "icons/maskable-192.png", "icons/maskable-512.png", "icons/maskable-1024.png"]) {
      const fp = path.join(webDist, rel);
      if (fs.existsSync(fp)) { fs.writeFileSync(fp, rel === "icons/icon-192.png" ? logoPng : favPng); n++; }
    }
    const favSvg = path.join(webDist, "favicon.svg");
    fs.writeFileSync(favSvg, `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><image href="data:image/png;base64,${favB64}" width="128" height="128"/></svg>\n`);
    log(`已覆盖磁盘图标文件（${n} 个 PNG + favicon.svg）`);
  } else log("WARN: 缺 brand-logo.png / brand-favicon.png，跳过磁盘图标覆盖");
} catch (e) {
  log("WARN: 磁盘图标覆盖失败", e.message);
}

// ---- 7e) 停用 Service Worker：PWA 的 SW 会缓存旧 app shell（旧 logo/标题/favicon），
// 导致改了磁盘/HTML 浏览器仍显示旧的。把 sw.js 换成"自毁"版：激活即清空所有 cache、
// 注销自身并刷新页面 => 浏览器下次导航拉到新 sw.js 后自愈，之后永远走网络拿最新。
try {
  const webDist = path.join(DIST, "..", "..", "web", "dist");
  const swFile = path.join(webDist, "sw.js");
  const killSw =
    `/* HARDENED:sw-kill 自毁 Service Worker，禁用 PWA 离线缓存，保证始终加载最新 */\n` +
    `self.addEventListener("install", function(e){ self.skipWaiting(); });\n` +
    `self.addEventListener("activate", function(e){ e.waitUntil((async function(){\n` +
    `  try { var ks = await caches.keys(); await Promise.all(ks.map(function(k){return caches.delete(k);})); } catch(e){}\n` +
    `  try { await self.registration.unregister(); } catch(e){}\n` +
    `  try { var cs = await self.clients.matchAll({type:"window"}); cs.forEach(function(c){ try{c.navigate(c.url);}catch(e){} }); } catch(e){}\n` +
    `})()); });\n` +
    `/* 不注册 fetch 处理器 => 所有请求直连网络，永不走缓存 */\n`;
  if (fs.existsSync(swFile)) {
    const cur = fs.readFileSync(swFile, "utf8");
    if (!cur.includes("HARDENED:sw-kill")) { fs.writeFileSync(swFile, killSw); log("已将 sw.js 换成自毁版（停用 PWA 缓存，首次导航自愈）"); }
    else log("sw.js 自毁版已就位（跳过）");
  } else { fs.writeFileSync(swFile, killSw); log("已写入自毁版 sw.js"); }
} catch (e) {
  log("WARN: sw.js 停用失败", e.message);
}

// ---- 7f) 双 Loop 入口：目标条改名为「LLM loop」，旁边加「代码 loop」按钮（validator 门禁运行时）----
try {
  let html = fs.readFileSync(htmlFile, "utf8");
  const loopMarker = "HARDENED:loop-modes";
  const loopBlock =
    `\t\t<!-- ${loopMarker} 双 Loop 入口：LLM loop（目标条改名）+ 代码 loop（受控运行时）。 -->\n` +
    `\t\t<style id="pi-loop-modes-style">\n` +
    `\t\t\t.mh-code-loop-btn{align-self:center;display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 9px;margin-left:6px;font-size:12px;border-radius:6px;cursor:pointer;color:#c4b5fd;background:rgba(168,85,247,.12);border:1px solid rgba(168,85,247,.45);white-space:nowrap;}\n` +
    `\t\t\t.mh-code-loop-btn:hover{background:rgba(168,85,247,.22);color:#ddd6fe;}\n` +
    `\t\t\t.mh-llm-hint{font-size:11px;color:#7f8897;padding:6px 2px 0;line-height:1.5;}\n` +
    `\t\t\t#mh-code-loop-modal{position:fixed;inset:0;z-index:2147483500;display:flex;align-items:center;justify-content:center;background:rgba(15,17,21,.72);backdrop-filter:blur(3px);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;}\n` +
    `\t\t\t#mh-code-loop-modal .cl-card{width:min(560px,92vw);background:#1b1e24;color:#e7e9ee;border:1px solid #333a45;border-radius:14px;padding:24px 26px;box-shadow:0 18px 60px rgba(0,0,0,.5);}\n` +
    `\t\t\t#mh-code-loop-modal h2{margin:0 0 6px;font-size:17px;font-weight:700;}\n` +
    `\t\t\t#mh-code-loop-modal .cl-sub{margin:0 0 16px;font-size:12px;color:#9aa3b2;}\n` +
    `\t\t\t#mh-code-loop-modal label{display:block;font-size:12px;color:#9aa3b2;margin:10px 0 4px;}\n` +
    `\t\t\t#mh-code-loop-modal textarea,#mh-code-loop-modal input{width:100%;box-sizing:border-box;background:#11141a;border:1px solid #2b313b;border-radius:7px;color:#e7e9ee;padding:8px 10px;font-size:13px;font-family:inherit;}\n` +
    `\t\t\t#mh-code-loop-modal textarea{min-height:70px;resize:vertical;}\n` +
    `\t\t\t#mh-code-loop-modal .cl-row{display:flex;gap:10px;justify-content:flex-end;margin-top:18px;}\n` +
    `\t\t\t#mh-code-loop-modal button{font-size:13px;border-radius:8px;padding:8px 16px;cursor:pointer;border:1px solid transparent;}\n` +
    `\t\t\t#mh-code-loop-modal .cl-cancel{background:#2b313b;color:#d8dde6;border-color:#3a414d;}\n` +
    `\t\t\t#mh-code-loop-modal .cl-start{background:#a855f7;color:#fff;}\n` +
    `\t\t\t#mh-code-loop-modal details.cl-adv{margin-top:12px;border-top:1px dashed #333a45;padding-top:10px;}\n` +
    `\t\t\t#mh-code-loop-modal details.cl-adv summary{cursor:pointer;font-size:12px;color:#8b93a1;user-select:none;outline:none;}\n` +
    `\t\t\t#mh-code-loop-modal details.cl-adv[open] summary{margin-bottom:6px;}\n` +
    `\t\t</style>\n` +
    `\t\t<script id="pi-loop-modes-script">\n` +
    `\t\t(function(){try{\n` +
    `\t\t\tfunction replaceText(root,from,to){try{var w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null,false),n;while(n=w.nextNode()){if(n.nodeValue&&n.nodeValue.indexOf(from)!==-1)n.nodeValue=n.nodeValue.split(from).join(to);}}catch(e){}}\n` +
    `\t\t\tfunction relabel(){\n` +
    `\t\t\t\ttry{\n` +
    `\t\t\t\t\tdocument.querySelectorAll('.goalbar-hint span').forEach(function(s){if((s.textContent||'').trim()==='目标')s.textContent='LLM loop';});\n` +
    `\t\t\t\t\tvar hintBtn=document.querySelector('.goalbar-hint');if(hintBtn){hintBtn.title='LLM loop：由 AI 自己判断是否完成，适合开放式任务（可能提前结束）';if(!hintBtn.__mhBound){hintBtn.__mhBound=true;hintBtn.addEventListener('click',function(){setTimeout(tick,60);setTimeout(tick,300);});}}\n` +
    `\t\t\t\t\tvar inp=document.querySelector('.goalbar-input');\n` +
    `\t\t\t\t\tif(inp&&/输入要达成的目标/.test(inp.placeholder||''))inp.placeholder='描述你想让 AI 完成的事…';\n` +
    `\t\t\t\t\tvar slot=document.querySelector('.goalbar-slot');\n` +
    `\t\t\t\t\tif(slot){\n` +
    `\t\t\t\t\t\tslot.querySelectorAll('button').forEach(function(b){var t=(b.textContent||'').trim();if(t==='提炼')b.textContent='帮我细化';else if(t==='发送')b.textContent='开始';});\n` +
    `\t\t\t\t\t\treplaceText(slot,'调研模型','规划模型');replaceText(slot,'最大轮数','最多尝试');\n` +
    `\t\t\t\t\t\tif(!slot.querySelector('.goalbar')){var oldHint=slot.querySelector('.mh-llm-hint');if(oldHint)oldHint.remove();}\n` +
    `\t\t\t\t\t\tif(slot.querySelector('.goalbar')&&!slot.querySelector('.mh-llm-hint')){\n` +
    `\t\t\t\t\t\t\tvar d=document.createElement('div');d.className='mh-llm-hint';d.textContent='LLM loop：由 AI 自己判断是否完成，可能提前结束；需要严格验收请点旁边的「代码 loop」。';\n` +
    `\t\t\t\t\t\t\tslot.appendChild(d);\n` +
    `\t\t\t\t\t\t}\n` +
    `\t\t\t\t\t}\n` +
    `\t\t\t\t}catch(e){}\n` +
    `\t\t\t}\n` +
    `\t\t\tfunction sendPrompt(text){\n` +
    `\t\t\t\ttry{\n` +
    `\t\t\t\t\tvar ta=document.querySelector('textarea[placeholder^="给 pi 发送消息"]');\n` +
    `\t\t\t\t\tif(!ta){return false;}\n` +
    `\t\t\t\t\tvar setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;\n` +
    `\t\t\t\t\tsetter.call(ta,text);\n` +
    `\t\t\t\t\tta.dispatchEvent(new Event('input',{bubbles:true}));\n` +
    `\t\t\t\t\tta.focus();\n` +
    `\t\t\t\t\tsetTimeout(function(){ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));},200);\n` +
    `\t\t\t\t\treturn true;\n` +
    `\t\t\t\t}catch(e){return false;}\n` +
    `\t\t\t}\n` +
    `\t\t\tfunction openModal(){\n` +
    `\t\t\t\tif(document.getElementById('mh-code-loop-modal'))return;\n` +
    `\t\t\t\tvar o=document.createElement('div');o.id='mh-code-loop-modal';\n` +
    `\t\t\t\to.innerHTML='<div class="cl-card"><h2>代码 loop（自动验证）</h2><p class="cl-sub">只需说清想完成什么。系统会自动检查是否完成，不通过会带着原因重试；中途关掉页面也能回来继续。</p>'+\n` +
    `\t\t\t\t\t'<label>你想完成什么？</label><textarea id="cl-goal" placeholder="例如：用 harness 跑 perf-012g gate，生成 db_gap_gate.json，gate_state 为 ESTIMATE_READY"></textarea>'+\n` +
    `\t\t\t\t\t'<label>怎么算完成？（可选，写你能检查的条件）</label><textarea id="cl-criteria" style="min-height:54px" placeholder="例如：文件存在且 gate_state=ESTIMATE_READY；或命令 python3 check.py 返回 0"></textarea>'+\n` +
    `\t\t\t\t\t'<details class="cl-adv"><summary>高级选项</summary>'+\n` +
    `\t\t\t\t\t'<label>检查命令（留空=自动准备）</label><input id="cl-cmd" placeholder="留空则由系统根据目标准备，例如 python3 validate.py" />'+\n` +
    `\t\t\t\t\t'<label>产物目录（可选，逗号分隔）</label><input id="cl-roots" placeholder="/external/runs/xxx" />'+\n` +
    `\t\t\t\t\t'<label>最多尝试次数</label><input id="cl-rounds" type="number" value="5" min="1" max="20" />'+\n` +
    `\t\t\t\t\t'</details>'+\n` +
    `\t\t\t\t\t'<div class="cl-row"><button class="cl-cancel">取消</button><button class="cl-start">启动代码 loop</button></div></div>';\n` +
    `\t\t\t\tdocument.body.appendChild(o);\n` +
    `\t\t\t\to.querySelector('.cl-cancel').addEventListener('click',function(){o.remove();});\n` +
    `\t\t\t\to.addEventListener('click',function(e){if(e.target===o)o.remove();});\n` +
    `\t\t\t\to.querySelector('.cl-start').addEventListener('click',function(){\n` +
    `\t\t\t\t\tvar goal=(document.getElementById('cl-goal').value||'').trim();\n` +
    `\t\t\t\t\tif(!goal){document.getElementById('cl-goal').focus();return;}\n` +
    `\t\t\t\t\tvar criteria=(document.getElementById('cl-criteria').value||'').trim();\n` +
    `\t\t\t\t\tvar cmd=(document.getElementById('cl-cmd').value||'').trim();\n` +
    `\t\t\t\t\tvar roots=(document.getElementById('cl-roots').value||'').split(',').map(function(s){return s.trim();}).filter(Boolean);\n` +
    `\t\t\t\t\tvar rounds=parseInt(document.getElementById('cl-rounds').value,10)||5;\n` +
    `\t\t\t\t\tvar p='用 loop_start 启动受控代码 Loop（自动验证）。\\ngoal='+JSON.stringify(goal);\n` +
    `\t\t\t\t\tif(criteria)p+='\\n验收标准：'+criteria;\n` +
    `\t\t\t\t\tif(cmd){p+='\\nvalidateCmd='+JSON.stringify(cmd)+'（直接使用这个检查命令）';}\n` +
    `\t\t\t\t\telse{p+='\\n验收方式：如果当前工作区没有真正可用的 validate.py，请先根据目标和验收标准写一个 validate.py（必须真正检查，不能恒通过），然后用 validateCmd="python3 validate.py" 启动。';}\n` +
    `\t\t\t\t\tif(roots.length)p+='\\nartifactRoots='+JSON.stringify(roots);\n` +
    `\t\t\t\t\tp+='\\nmaxRounds='+rounds+'。然后 loop_plan 并直接完成工作，完成时调用 loop_done。不要向用户提问。';\n` +
    `\t\t\t\t\tif(sendPrompt(p))o.remove();\n` +
    `\t\t\t\t});\n` +
    `\t\t\t\tsetTimeout(function(){var g=document.getElementById('cl-goal');if(g)g.focus();},80);\n` +
    `\t\t\t}\n` +
    `\t\t\tfunction ensureBtn(){\n` +
    `\t\t\t\ttry{\n` +
    `\t\t\t\t\tvar slot=document.querySelector('.goalbar-slot');\n` +
    `\t\t\t\t\tif(!slot)return;\n` +
    `\t\t\t\t\tif(slot.querySelector('.mh-code-loop-btn'))return;\n` +
    `\t\t\t\t\tvar row=slot.querySelector('.goalbar-collapsed')||slot;\n` +
    `\t\t\t\t\tvar btn=document.createElement('button');btn.type='button';btn.className='mh-code-loop-btn';btn.textContent='代码 loop';btn.title='启动受控代码 Loop（自动验证，可断点续跑）';\n` +
    `\t\t\t\t\tbtn.addEventListener('click',openModal);\n` +
    `\t\t\t\t\trow.appendChild(btn);\n` +
    `\t\t\t\t}catch(e){}\n` +
    `\t\t\t}\n` +
    `\t\t\tfunction tick(){relabel();ensureBtn();}\n` +
    `\t\t\tif(!window.__mhTickBound){window.__mhTickBound=true;document.addEventListener('click',function(){setTimeout(tick,80);},true);}\n` +
    `\t\t\tif(document.readyState==='loading')document.addEventListener('DOMContentLoaded',function(){setTimeout(tick,700);});else setTimeout(tick,700);\n` +
    `\t\t\tsetInterval(tick,1200);\n` +
    `\t\t}catch(e){}})();\n` +
    `\t\t</script>\n\t`;
  if (!html.includes(loopMarker)) {
    html = html.replace("</head>", loopBlock + "</head>");
    fs.writeFileSync(htmlFile, html);
    log("已注入双 Loop 入口（LLM loop 改名 + 代码 loop 按钮）");
  } else {
    const re = /\t*<!-- HARDENED:loop-modes[\s\S]*?pi-loop-modes-script">[\s\S]*?<\/script>\n\t?/;
    const updated = html.replace(re, loopBlock);
    if (updated !== html) { fs.writeFileSync(htmlFile, updated); log("已更新双 Loop 入口"); }
    else log("双 Loop 入口已是最新（跳过）");
  }
} catch (e) {
  log("WARN: 双 Loop 入口注入失败", e.message);
}

// ---- 8) 提示词模板：隐藏 25 个 pi 内置模板，灌入从 harness+Ku 沉淀的多个可直接用模板 ----
// 模板落在浏览器 localStorage['pi-web-ui:prompt-templates']。内置模板靠 {id,hidden:true} 隐藏；
// 自定义模板用完整 {id,icon,title,desc,prompt}。版本化 seed 标志 => 改内容后能重新应用。
// 内容沉淀自 5 个 workflow skill 的 SKILL.md + Ku「AI Loop 异步化任务跟踪表」里的真实启动 prompt。
// pi 自带 25 个内置模板 id（用于 hidden 标记，源自 bundle 的 ev 数组）
const BUILTIN_TPL_IDS = [
  "setup-matt-pocock-skills", "ask-matt", "grill-with-docs", "to-spec", "to-tickets",
  "implement", "code-review", "wayfinder", "prototype", "research",
  "improve-codebase-architecture", "diagnosing-bugs", "resolving-merge-conflicts", "triage", "wizard",
  "grill-me", "handoff", "to-questionnaire", "teach", "wait-what",
  "writing-for-agents", "codebase-design", "domain-modeling", "grilling", "tdd",
];
// 本插件管理的模板 id 全集（升级时先按这些 id 清掉旧条目再重灌，保留用户自建）
const MANAGED_TPL_IDS = [
  "inf-harness-start", "inf-prefill", "inf-cache-adapt", "inf-cache-loss",
  "inf-hitrate", "inf-cudaipc", "inf-kvcache-nextgen", "inf-runtime-loop",
];
// 从 harness + Ku 沉淀的可直接使用模板（task 级参数用 <尖括号> 占位，发送前替换）
const MANAGED_TPL = [
  {
    id: "inf-harness-start", icon: "🧭", title: "Harness 通用启动",
    desc: "infer-forge-harness 通用 AI Loop：先读规范、复用原子任务、每步 verify、留证据",
    prompt: "使用 inference-harness skill 启动一次推理服务 AI Loop。先用 icode 拉取 baidu/hac-aiacc/infer-forge-harness 并进入仓库，按顺序先读 AGENTS.md、目标 workflow 定义、task 合约、tasks/REGISTRY.yaml、catalog/tool_catalog.yaml、SKILL.md 与 validator，再动手。明确本次 workflow 与目标模型（如 deepseek-v4.1-flash）。优先复用 REGISTRY 已有原子任务，没有合适的才新增、新增后更新 REGISTRY 并重新生成 CATALOG。每步都要有明确 verify，以 validator 判定为准（返回码/PASS 字样/manifest 都不算通过）。每步产出 run id、artifact root、节点状态、validator 结论、Journal 路径、证据路径，并与 baseline 对比。失败保留原始证据，不打补丁绕过、不静默重试。安全红线：删除实例/资源、缩减副本、杀进程、改端口拓扑/MODEL_ID/配置等高危操作一律先说明理由并等确认；只操作自己的 Pod，共享/线上实例变更必须人工确认。",
  },
  {
    id: "inf-prefill", icon: "⚡", title: "Prefill 性能优化",
    desc: "sglang prefill/ttft 的 5 步 loop（base→profile→subagent→回归→循环）",
    prompt: "本项目是推理服务的 harness，里面有定义了 prefill 性能优化的工作流 prefill-optimization。请先进入本地 harness 代码库，再帮我运行这个工作流来优化 <目标模型，如 Deepseek v4.1-Flash>。\n步骤：1) 建立 base——指定 sglang 服务镜像，通过 perf-test-graph-prefill 部署并测试典型数据长度（如 60K）下的 prefill 性能与 ttft，保存 logits 作为精度标准；2) 性能 profile——用 torch profile 或 nsys 抓相同数据 trace，从算子/引擎/显存维度挖掘可优化点；3) subagent 优化——每个可优化点起一个 subagent 拉分支优化，保证优化后 logits 与基准在容差内且问题解决，再合并回主分支；4) 回归测试——集成后跑基准数据集，对比性能与 logits、解决冲突、保证正确并输出结果；5) 回到 2→3→4 循环，默认 3 次或无新优化点为止。每个 task 都要有明确 verify。\n环境（按实际替换）：集群 kubeconfig=<kubeconfig 路径>，prefill 启动 yaml=<prefill yaml 路径>，已启动实例=<pod 名>（内含 sglang 代码与模型权重）。请开始整个工作流并做好完整记录与回顾。",
  },
  {
    id: "inf-cache-adapt", icon: "🧩", title: "Cache 适配（AttentionStore）",
    desc: "新模型从零接入 AS-Cache，跑通 MLA / MLA+SWA / MLA+KDA",
    prompt: "本项目是推理服务的 harness，里面定义了 attention-store 适配的 workflow。请从头开始完整运行这个工作流，实现 <目标模型，如 ds v4.1-flash> 的 as-cache 适配，跑通 MLA、MLA+SWA、MLA+KDA，并支持自动组合适配与自动进化。\n环境（按实际替换）：集群 kubeconfig=<kubeconfig 路径>；未适配的 P 侧 yaml=<prefill yaml 路径>，owner=<owner>；相关代码路径：sglang_root=<aiak_sglang 路径>，sdk_root=<attentionstore/sdk 路径>，agent_root=<attentionstore/agent 路径，只读参考，用于确认接口与参数>。\n请开始整个工作流并做好完整记录与回顾（每步 run id / artifact root / validator 结论 / Journal / 证据路径）。",
  },
  {
    id: "inf-cache-loss", icon: "📉", title: "Cache 损耗优化",
    desc: "80k/96% 命中下把 cache 损耗降到 20% 以内（bench_ascache 两阶段压测）",
    prompt: "帮我创建一个优化 cache 性能损耗的任务，目标：<输入长度，如 80k(81920)> 输入、<命中率，如 96%> 命中率场景下 cache 损耗达到 20% 以下。\ncache 损耗定义：开启 ASCache 场景 uncache itps 相对 disable-radix-cache 场景 uncache itps 缩减的比例（1 - ascache uncache itps / disable-radix-cache uncache itps）。损耗分计算损耗、间隙损耗（通常高优关注）、以及有 PP 时的 bubble 损耗。\n环境（按实际替换）：引擎 sglang 代码=<sglang 路径>，模型路径=<模型 tokenizer/权重路径>，可用 pod=<pod 名>，SDK=<attentionstore/sdk 路径>，启动脚本=<start.sh 路径>，无基线 ITPS=<基线值>。\n压测用自研 bench_ascache.py（两阶段：先充 cache 再实际发压，抓 nsys/profile 只抓实际发压阶段，据引擎日志 hit_rate 判断是否真命中）：\npython3 benchmark/bench_ascache.py --host 127.0.0.1 --port 8000 --total-len 81920 --target-hit-rates \"0.96\" --batch-size 64 --num-rounds 1 --tokenizer <模型路径> --output-file ascache_80k.json\n允许优化引擎源码、重启/杀引擎、改引擎配置与 SDK（仅限自己的测试实例；共享/线上实例一律停下确认）。trace 与 loop 证据输出目录自定。可参考引擎历史 cache 损耗留档与 harness cache 损耗优化 loop 里的提示词。",
  },
  {
    id: "inf-hitrate", icon: "🎯", title: "Cache 命中率定位修复",
    desc: "线上命中率下跌定位与修复，validator 判定、留完整证据链",
    prompt: "使用 cache-hitrate-debug skill 定位并修复线上 cache 命中率下跌问题，目标解决 9 成以上命中率下跌并支持自动迭代。复用 harness 原子任务（tasks/REGISTRY.yaml），没有合适的才新增、新增后更新 REGISTRY 并重新生成 CATALOG。用 bench_ascache.py 两阶段压测复现，用 nsys/torch profile 抓 trace，据引擎日志 hit_rate 判断是否真正命中 cache。定位与修复都要有明确 verify、以 validator 判定为准，保留完整证据链（run id / artifact root / Journal / 证据路径），失败不静默重试。环境（按实际替换）：模型=<目标模型>，集群/实例=<kubeconfig 与 pod>。",
  },
  {
    id: "inf-cudaipc", icon: "🔗", title: "AS-SDK CudaIPC 传输改造验证",
    desc: "KVCache 传输 PosixSHM→CudaIPC(as-mover)，优化 Prefill 启动时间、不劣化精度/吞吐",
    prompt: "基于 infer-forge-harness 设计并执行一个验证工作流：attention-store-sdk 的 KVCache 传输从 PosixSHM 改为独立进程 as-mover 用 CudaIPC（共享显存）。核心目标是优化 Prefill 启动时间，同时保证功能、精度与 Cache 吞吐损耗不劣化。采用最小可用版本、分步推进，每步跟我确认后再进入下一步。\n工作方式：先读 AGENTS.md、目标 workflow、task 合约、SKILL.md 与 validator 再动手；优先复用 REGISTRY 原子任务。代码改动落在 Pod 内代码库（本地写→kubectl cp 进 Pod→Pod 内编译测试），改动通过 PYTHONPATH 注入不改镜像（AS_SDK_ROOT=<sdk 路径>，SGLANG_ROOT=<sglang 路径>）。先不提交代码，留给我 review。\n环境（按实际替换）：kubeconfig=<kubeconfig>，引擎版本=<版本>，线上配置（权威只读不 apply）=<线上 yaml>，线下测试配置=<线下 yaml>，专用实例=<prefill/decode pod>。\n阶段：0 环境证明+部署注册（端口与线上一致，引擎 HTTP_PORT=8000、PD router 30000）→1 Baseline（吞吐损耗 + Prefill 启动时间，bench_ascache.py 重复≥3 次）→2 as-mover 单测（先给方案我 review）→3 Prefill 单点（先起 as-mover 再起引擎，对比 baseline）→4 完整 PD 回归（迁到 Decode，千帆网关打通完整推理，功能+OpenCompass 精度回归）→5 压测（aiakperf 经网关，QPS 1.0）。\n每步交付：run id、artifact root、节点状态、validator 结论、Journal 路径、证据路径、与 baseline 对比（损耗% / Prefill 启动时间）。以 validator 判定为准，失败保留证据不静默重试。\n安全红线：删除实例/资源、缩副本一律停下由我执行（kubectl delete 与缩副本外其他 kubectl 已授权）；只操作自己的 Pod；不擅改端口/拓扑/MODEL_ID，一切以线上 yaml 为准、要改先确认。",
  },
  {
    id: "inf-kvcache-nextgen", icon: "🧱", title: "下一代 KV Cache 架构（radix/allocator/overlap）",
    desc: "harness 跑通 radix tree 拆分 / allocator 拆分 / cache 操作与 forward overlap",
    prompt: "基于 infer-forge-harness 推进下一代 KV Cache 架构改造，里程碑：1) 与方案对齐关键路径和实现；2) Harness 平台初步跑通流程；3) 基于 Harness 跑通业务结果——完成 radix tree 拆分并验收通过、完成 allocator 拆分并验收通过、完成 cache 操作与 forward 并行 overlap 并验收通过。\n工作方式：先读 AGENTS.md / 目标 workflow / task 合约 / SKILL.md / validator 再动手，优先复用 REGISTRY 原子任务，产物与 Journal 放仓库外，每步有明确 verify、以 validator 判定为准。环境（按实际替换）：kubeconfig=<kubeconfig>，实例=<pod>，代码路径=<sglang/sdk 路径>。每步产出 run id / artifact root / validator 结论 / Journal / 证据路径并与 baseline 对比。安全红线同 harness 总纲（高危操作先确认、只动自己的 Pod）。",
  },
  {
    id: "inf-runtime-loop", icon: "🛡️", title: "受控 Loop（validator 门禁 + 自动迭代）",
    desc: "用运行时启动任务：validator 不通过自动带证据进入下一轮，通过才算完成，可断点续跑",
    prompt: "用 mini-harness 运行时启动一个受 validator 约束的任务（不要用普通对话硬跑）。\n\n调用 loop_start：\n- goal：<要达成的目标，写清可验证的完成条件>\n- validateCmd：<validator 命令，例如 python3 validate.py 或 infer-forge-harness 的 validate.py 路径>\n- harnessRoot：<可选，harness 仓库根目录>\n- maxRounds：<默认 5>\n\n然后 loop_plan 写出计划并直接修改工作区；完成每轮时调用 loop_done(summary)。\n规则：运行时会自动执行 validator；不通过会带着证据自动进入下一轮，直到通过或达到最大轮数。不要自行宣布完成，不要向用户提问，不要重复已完成的步骤。",
  },
];
try {
  let html = fs.readFileSync(htmlFile, "utf8");
  const seedMarker = "HARDENED:prompt-seed";
  const payload = JSON.stringify({
    managed: MANAGED_TPL,
    managedIds: MANAGED_TPL_IDS,
    builtins: BUILTIN_TPL_IDS,
  });
  const scriptBlock =
    `\t\t<!-- ${seedMarker} 提示词模板：隐藏 25 内置 + 灌入 harness/Ku 沉淀的多个可直接用模板（版本化 seed，可逆）。 -->\n` +
    `\t\t<script id="pi-prompt-seed">\n` +
    `\t\t(function(){try{\n` +
    `\t\t\tvar K="pi-web-ui:prompt-templates",F="pi-web-ui:prompt-templates-seeded";\n` +
    `\t\t\tvar VER="v4";\n` +
    `\t\t\tif(localStorage.getItem(F)===VER)return;\n` +
    `\t\t\tvar P=${payload};\n` +
    `\t\t\tvar cur=[];try{cur=JSON.parse(localStorage.getItem(K)||"[]")}catch(e){}\n` +
    `\t\t\tif(!Array.isArray(cur))cur=[];\n` +
    `\t\t\tvar drop={};P.managedIds.forEach(function(x){drop[x]=1;});\n` +
    `\t\t\t// 去掉本插件管理的旧条目（升级/收敛），保留用户自建\n` +
    `\t\t\tcur=cur.filter(function(t){return t&&!drop[t.id];});\n` +
    `\t\t\t// 为每个内置模板补 hidden 标记（用户若已显式改过同 id 则不动）\n` +
    `\t\t\tvar have={};cur.forEach(function(t){if(t&&t.id)have[t.id]=1;});\n` +
    `\t\t\tP.builtins.forEach(function(id){if(!have[id])cur.push({id:id,hidden:true});});\n` +
    `\t\t\t// 放入沉淀的多个可直接用模板\n` +
    `\t\t\tP.managed.forEach(function(t){cur.push(t);});\n` +
    `\t\t\tlocalStorage.setItem(K,JSON.stringify(cur));localStorage.setItem(F,VER);\n` +
    `\t\t}catch(e){}})();\n` +
    `\t\t</script>\n\t`;
  if (!html.includes(seedMarker)) {
    html = html.replace("</head>", scriptBlock + "</head>");
    fs.writeFileSync(htmlFile, html);
    log(`已注入提示词模板 seed（隐藏 25 内置 + ${MANAGED_TPL.length} 个 harness/Ku 沉淀模板）`);
  } else {
    const re = /\t*<!-- HARDENED:prompt-seed[\s\S]*?<\/script>\n\t?/;
    const updated = html.replace(re, scriptBlock);
    if (updated !== html) {
      fs.writeFileSync(htmlFile, updated);
      log(`已更新提示词模板 seed（v4：隐藏内置 + ${MANAGED_TPL.length} 个沉淀模板）`);
    } else log("提示词模板 seed 已是最新（跳过）");
  }
} catch (e) {
  log("WARN: 提示词模板 seed 注入失败", e.message);
}

// ---- 9) 子代理模板：保留 explore/review/implement，其余换成 5 个推理 workflow 模板 ----
// 模板是全局配置（<dataDir>/subagent-templates.json），所有客户端共用。
// seeded sidecar 记已播种的内置名；把全部 13 个内置名写进去 => 被删的 10 个不再回灌。
const dataDir = path.join(HOME, ".pi-web");
const KEEP = new Set(["explore", "review", "implement"]);
const infTemplates = [
  {
    name: "harness-runner",
    description: "推理 Harness 执行者：拉起 infer-forge-harness，按 workflow 定义逐步执行并留证据",
    promptMode: "replace",
    systemPrompt: "你是训推引擎组的 Harness 执行子代理。使用 inference-harness skill。用 icode 拉取 baidu/hac-aiacc/infer-forge-harness，先读 AGENTS.md、目标 workflow 定义、tasks/REGISTRY.yaml、catalog/tool_catalog.yaml、SKILL.md 与 validator，再动手。优先复用 REGISTRY 已有原子任务，没有合适的才新增（新增后更新 REGISTRY 并重新生成 CATALOG）。每步产出 run id / artifact root / validator 结论 / Journal 路径 / 证据路径，并与 baseline 对比；以 validator 判定为准，失败不静默重试。安全红线：删除实例/资源、缩减副本、改端口拓扑/MODEL_ID 等一律先说明理由并等确认；只操作自己的 Pod。",
    enabledSkills: ["inference-harness", "baidu-devops", "baidu-ku-doc"],
    enabledExtensions: [], model: "", thinkingLevel: "", enabled: true,
  },
  {
    name: "prefill-opt",
    description: "Prefill 性能优化：sglang prefill/ttft 的 5 步 loop（base→profile→优化→回归→循环）",
    promptMode: "replace",
    systemPrompt: "你是 prefill 性能优化子代理。使用 prefill-optimization skill 跑 prefill-optimization workflow，优化 sglang 在典型数据长度（如 60K）下的 prefill 性能与 ttft。①用 perf-test-graph-prefill 部署指定镜像建 base，保存 logits 作精度标准；②用 torch profile/nsys 抓同数据 trace，从算子/引擎/显存维度定位可优化点；③每个优化点起分支优化，保证优化后 logits 与基准在容差内、问题解决后再合并；④集成后跑基准集回归，对比性能与 logits、解决冲突；⑤回第 2 步循环，默认 3 次或无新优化点为止。每个 task 都要有明确 verify。",
    enabledSkills: ["prefill-optimization", "inference-harness"],
    enabledExtensions: [], model: "", thinkingLevel: "", enabled: true,
  },
  {
    name: "cache-adapt",
    description: "AttentionStore 模型适配：新模型接入 ASCache，跑通 MLA / MLA+SWA / MLA+KDA",
    promptMode: "replace",
    systemPrompt: "你是 AttentionStore 适配子代理。使用 cache-adaptation skill 跑 attention-store 适配 workflow，把目标模型（如 deepseek-v4.1-flash）从零接入 AttentionStore/ASCache，跑通 MLA、MLA+SWA、MLA+KDA 并支持自动组合适配与自动进化。关键路径：引擎 aiak_sglang（sglang_root）、SDK attentionstore/sdk（sdk_root）、Agent attentionstore/agent（agent_root，只读参考）。集群配置用任务提供的 kubeconfig；未适配的 P 侧 yaml 与 owner 以任务启动 prompt 为准。每步完整记录 run id / artifact root / validator 结论 / Journal / 证据路径。",
    enabledSkills: ["cache-adaptation", "inference-harness"],
    enabledExtensions: [], model: "", thinkingLevel: "", enabled: true,
  },
  {
    name: "cache-loss",
    description: "Cache 损耗优化：80k/96% 命中下把 cache 损耗降到 20% 以内",
    promptMode: "replace",
    systemPrompt: "你是 cache 性能损耗优化子代理。使用 cache-loss-optimization skill，目标：输入 80k(81920)、命中率 96% 下把 cache 损耗降到 20% 内（损耗 = 1 - ascache uncache itps / disable-radix-cache uncache itps）。分别排查计算/间隔/bubble 损耗，重点关注间隔损耗。用 benchmark/bench_ascache.py 两阶段压测（先充 cache 再实际发压，据引擎日志 hit_rate 确认真正命中），用 nsys 抓实际发压阶段 trace。允许改 sglang 引擎与 attentionstore/sdk 源码、重启自己的测试实例；共享/线上实例的重启、杀进程、改配置一律先确认。",
    enabledSkills: ["cache-loss-optimization", "inference-harness"],
    enabledExtensions: [], model: "", thinkingLevel: "", enabled: true,
  },
  {
    name: "hitrate-debug",
    description: "Cache 命中率定位：线上命中率下跌定位与修复，validator 判定",
    promptMode: "replace",
    systemPrompt: "你是 cache 命中率问题定位与修复子代理。使用 cache-hitrate-debug skill 定位并修复线上 cache 命中率下跌，目标解决 9 成以上下跌并支持自动迭代。复用 harness 原子任务（tasks/REGISTRY.yaml），没有合适的才新增、新增后更新 REGISTRY 并重新生成 CATALOG。用 bench_ascache.py 两阶段压测复现，用 nsys/torch profile 抓 trace，看引擎日志 hit_rate 判断是否真正命中。定位与修复都要有明确 verify、以 validator 判定为准，保留完整证据链（run id / artifact root / Journal / 证据路径），失败不静默重试。",
    enabledSkills: ["cache-hitrate-debug", "inference-harness"],
    enabledExtensions: [], model: "", thinkingLevel: "", enabled: true,
  },
];
try {
  const mod = await import(
    path.join(DIST, "subagent-templates.js").replace(/\\/g, "/")
  );
  const defaults = mod.DEFAULT_TEMPLATES || [];
  const kept = defaults
    .filter((t) => KEEP.has(t.name))
    .map((t) => ({ ...t, enabledSkills: [...t.enabledSkills], enabledExtensions: [...t.enabledExtensions] }));
  const finalTemplates = [...kept, ...infTemplates];
  const tplFile = path.join(dataDir, "subagent-templates.json");
  fs.writeFileSync(tplFile, JSON.stringify(finalTemplates, null, 2));
  // seeded sidecar：写全部内置名 => 被删的内置模板不会在重启后复活
  const seededFile = path.join(dataDir, "subagent-templates.seeded.json");
  const allBuiltinNames = defaults.map((t) => t.name);
  fs.writeFileSync(seededFile, JSON.stringify(allBuiltinNames, null, 2));
  log(`子代理模板已重建：保留 ${[...KEEP].join("/")} + ${infTemplates.length} 个推理模板（共 ${finalTemplates.length}）`);
} catch (e) {
  log("WARN: 子代理模板重建失败", e.message);
}

// ---- 10) 工具精简：禁用 page-picker（browser_page）——pageRef 已关，工具一并禁 ----
try {
  const csFile2 = path.join(dataDir, "client-state.json");
  const cs = JSON.parse(fs.readFileSync(csFile2, "utf8"));
  const st = cs.__settings__?.settings;
  if (st) {
    const tools = new Set(st.disabledAgentTools || []);
    tools.add("browser_page");
    st.disabledAgentTools = [...tools];
    fs.writeFileSync(csFile2, JSON.stringify(cs, null, 2));
    log("已禁用 browser_page 工具（page-picker）");
  }
} catch (e) {
  log("WARN: 工具精简失败", e.message);
}

// ---- 11) pi-llm-wiki extension：登记 + 静默自动配置 + 删高危可选依赖子树（幂等可逆）----
// vendor 目录是审查过的 @zosmaai/pi-llm-wiki@0.12.5 本地副本。此段只做"配置与清理"，
// 不重装依赖（依赖体积大、需联网）；若 vendor/node_modules 缺失会提示手动 npm install。
{
  const wikiVendor = path.join(COCKPIT, "vendor", "pi-llm-wiki");
  const agentSettings = path.join(HOME, ".pi", "agent", "settings.json");
  try {
    if (!fs.existsSync(path.join(wikiVendor, "package.json"))) {
      log("WARN: pi-llm-wiki vendor 缺失，跳过（需先放置 vendor/pi-llm-wiki 源）");
    } else {
      // a0) 前置自愈：vendor 依赖缺失则自动 npm install（禁脚本、仅 prod、legacy-peer）
      const nmDir = path.join(wikiVendor, "node_modules");
      const depProbe = path.join(nmDir, "node-html-markdown");
      if (!fs.existsSync(depProbe)) {
        log("pi-llm-wiki：vendor 依赖缺失，自动 npm install（--omit=dev --ignore-scripts --legacy-peer-deps）…");
        try {
          execSync("npm install --omit=dev --ignore-scripts --legacy-peer-deps --no-audit --no-fund", {
            cwd: wikiVendor, stdio: "inherit",
          });
          log("pi-llm-wiki：依赖安装完成");
        } catch (e) {
          log("WARN: pi-llm-wiki 依赖自动安装失败，请手动在 vendor/pi-llm-wiki 跑 npm install", e.message);
        }
      } else log("pi-llm-wiki：vendor 依赖已就绪（跳过安装）");

      // a1) 前置自愈：未登记到 pi packages 则自动 pi install（幂等）
      let stProbe = {};
      try { stProbe = JSON.parse(fs.readFileSync(agentSettings, "utf8")); } catch {}
      const already = (stProbe.packages || []).some((p) => p.includes("vendor/pi-llm-wiki"));
      if (!already) {
        log("pi-llm-wiki：未登记，自动 pi install…");
        try {
          execSync(`pi install ${JSON.stringify(wikiVendor)} --no-approve`, { stdio: "inherit" });
          log("pi-llm-wiki：pi install 完成");
        } catch (e) {
          log("WARN: pi install 失败（pi CLI 不在 PATH？），将仅写 settings 登记兜底", e.message);
        }
      } else log("pi-llm-wiki：package 已登记（跳过 pi install）");

      // a) 删高危可选依赖子树（@tobilu/qmd → node-llama-cpp → simple-git 的命令执行 CVE）
      const nm = path.join(wikiVendor, "node_modules");
      const risky = ["@tobilu", "node-llama-cpp", "simple-git", "@simple-git", "better-sqlite3", "sqlite-vec", "web-tree-sitter"];
      let removed = 0;
      for (const r of risky) {
        const rp = path.join(nm, r);
        if (fs.existsSync(rp)) { fs.rmSync(rp, { recursive: true, force: true }); removed++; }
      }
      // tree-sitter-* 通配
      if (fs.existsSync(nm)) {
        for (const d of fs.readdirSync(nm)) {
          if (d.startsWith("tree-sitter-")) { fs.rmSync(path.join(nm, d), { recursive: true, force: true }); removed++; }
        }
      }
      if (removed) log(`pi-llm-wiki：已移除 ${removed} 个高危可选依赖目录（qmd/llama/simple-git 子树）`);
      else log("pi-llm-wiki：高危可选依赖已清理（跳过）");

      // b) 登记到 pi 全局 settings.json packages（绝对路径，可移植；去重）
      // 首装时 settings.json 可能尚不存在（pi install 未成功时），用空对象兜底，保证其余配置仍能写入。
      let st = {};
      try { st = JSON.parse(fs.readFileSync(agentSettings, "utf8")); } catch {}
      const pkgs = new Set(st.packages || []);
      // 清掉任何 /tmp 的旧登记，以及任何旧的 pi-llm-wiki 相对/硬编码登记
      for (const p of [...pkgs]) {
        if (p.includes("/tmp/")) pkgs.delete(p);
        if (p.includes("pi-llm-wiki") && p !== wikiVendor) pkgs.delete(p);
      }
      pkgs.add(wikiVendor);
      st.packages = [...pkgs];

      // c) 静默自动配置：后台自动召回/沉淀，不弹提示；不配 embedding => 纯本地不外联
      st["llm-wiki"] = {
        notices: false,
        autoRecall: true,
        trajectories: true,
        ambientPersonalVault: true,
        wikilinkValidation: "warn",
      };
      fs.writeFileSync(agentSettings, JSON.stringify(st, null, 2));
      log("pi-llm-wiki：已登记 package + 写静默自动配置（notices=off / autoRecall / trajectories / 无 embedding）");
    }
  } catch (e) {
    log("WARN: pi-llm-wiki 配置失败", e.message);
  }
}

// ---- 12) 首次使用 API Key 门禁：一打开就弹窗要求填写 Baidu One API（可逆，localStorage 记已读）----
// 可移植场景下别人 git clone 后没有 auth.json，必须显式引导其填 One API。门禁为自建 DOM，
// 不依赖 bundle 选择器；并尽力打开"设置"。用户点"我已配置"后落 localStorage 标志，不再弹。
try {
  let html = fs.readFileSync(htmlFile, "utf8");
  const gateMarker = "HARDENED:apikey-gate";
  const gateBlock =
    `\t\t<!-- ${gateMarker} 首次使用 One API Key 门禁（可逆）。 -->\n` +
    `\t\t<style id="pi-apikey-gate-style">\n` +
    `\t\t\t#pi-apikey-gate{position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;background:rgba(15,17,21,.72);backdrop-filter:blur(3px);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;}\n` +
    `\t\t\t#pi-apikey-gate .pg-card{width:min(520px,92vw);background:#1b1e24;color:#e7e9ee;border:1px solid #333a45;border-radius:14px;padding:26px 28px;box-shadow:0 18px 60px rgba(0,0,0,.5);}\n` +
    `\t\t\t#pi-apikey-gate h2{margin:0 0 6px;font-size:18px;font-weight:700;}\n` +
    `\t\t\t#pi-apikey-gate .pg-sub{margin:0 0 16px;font-size:12.5px;color:#9aa3b2;}\n` +
    `\t\t\t#pi-apikey-gate ol{margin:0 0 14px;padding-left:18px;font-size:13px;line-height:1.75;}\n` +
    `\t\t\t#pi-apikey-gate code{background:#11141a;border:1px solid #2b313b;border-radius:5px;padding:1px 6px;font-size:12px;color:#8fd0ff;}\n` +
    `\t\t\t#pi-apikey-gate .pg-note{font-size:11.5px;color:#7f8897;margin:0 0 18px;line-height:1.6;}\n` +
    `\t\t\t#pi-apikey-gate .pg-row{display:flex;gap:10px;justify-content:flex-end;}\n` +
    `\t\t\t#pi-apikey-gate button{font-size:13px;border-radius:8px;padding:8px 16px;cursor:pointer;border:1px solid transparent;}\n` +
    `\t\t\t#pi-apikey-gate .pg-open{background:#2b313b;color:#d8dde6;border-color:#3a414d;}\n` +
    `\t\t\t#pi-apikey-gate .pg-ok{background:#3b82f6;color:#fff;}\n` +
    `\t\t</style>\n` +
    `\t\t<script id="pi-apikey-gate-script">\n` +
    `\t\t(function(){try{\n` +
    `\t\t\tvar ACK="pi-harness:apikey-ack";\n` +
    `\t\t\tfunction openSettings(){try{var sel=['[data-bar-item="host:settings"]','[aria-label="设置"]','[aria-label="Settings"]','[title="设置"]','[title="Settings"]'];for(var i=0;i<sel.length;i++){var el=document.querySelector(sel[i]);if(el){el.click();return true;}}}catch(e){}return false;}\n` +
    `\t\t\tfunction mount(){\n` +
    `\t\t\t\tif(localStorage.getItem(ACK)==="1")return;\n` +
    `\t\t\t\tif(document.getElementById("pi-apikey-gate"))return;\n` +
    `\t\t\t\tvar o=document.createElement("div");o.id="pi-apikey-gate";\n` +
    `\t\t\t\to.innerHTML='<div class="pg-card"><h2>训推引擎组 Harness · 首次配置</h2><p class="pg-sub">使用前只需填入你自己的 One API Key（Base URL 已默认配好，无需修改）。</p><ol><li>点下方「打开设置」，进入 <b>设置 → 模型服务商</b></li><li>在 API Key 处填入你自己的 Key 并保存</li></ol><p class="pg-note">Key 仅保存在本机 <code>~/.pi/agent/auth.json</code>，不会提交到代码库，也不会外传。</p><div class="pg-row"><button class="pg-open">打开设置</button><button class="pg-ok">我已配置，进入</button></div></div>';\n` +
    `\t\t\t\tdocument.body.appendChild(o);\n` +
    `\t\t\t\to.querySelector(".pg-open").addEventListener("click",function(){openSettings();localStorage.setItem(ACK,"1");o.remove();});\n` +
    `\t\t\t\to.querySelector(".pg-ok").addEventListener("click",function(){localStorage.setItem(ACK,"1");o.remove();});\n` +
    `\t\t\t}\n` +
    `\t\t\tif(document.readyState==="loading")document.addEventListener("DOMContentLoaded",function(){setTimeout(mount,600);});else setTimeout(mount,600);\n` +
    `\t\t}catch(e){}})();\n` +
    `\t\t</script>\n\t`;
  if (!html.includes(gateMarker)) {
    html = html.replace("</head>", gateBlock + "</head>");
    fs.writeFileSync(htmlFile, html);
    log("已注入 One API Key 首次配置门禁");
  } else {
    const re = /\t*<!-- HARDENED:apikey-gate[\s\S]*?pi-apikey-gate-script">[\s\S]*?<\/script>\n\t?/;
    const updated = html.replace(re, gateBlock);
    if (updated !== html) {
      fs.writeFileSync(htmlFile, updated);
      log("已更新 One API Key 门禁（同步最新）");
    } else log("One API Key 门禁已是最新（跳过）");
  }
} catch (e) {
  log("WARN: One API Key 门禁注入失败", e.message);
}

// ---- 11b) mini-harness-runtime：薄运行时扩展（状态机 + validator 准入 + 自动下一轮 + 续跑）----
{
  const rtVendor = path.join(COCKPIT, "vendor", "mini-harness-runtime");
  const agentSettings = path.join(HOME, ".pi", "agent", "settings.json");
  try {
    if (!fs.existsSync(path.join(rtVendor, "package.json"))) {
      log("WARN: mini-harness-runtime vendor 缺失，跳过");
    } else {
      let st = {};
      try { st = JSON.parse(fs.readFileSync(agentSettings, "utf8")); } catch {}
      const pkgs = new Set(st.packages || []);
      for (const p of [...pkgs]) if (p.includes("mini-harness-runtime") && p !== rtVendor) pkgs.delete(p);
      const already = pkgs.has(rtVendor);
      if (!already) {
        log("mini-harness-runtime：未登记，自动 pi install…");
        try { execSync(`pi install ${JSON.stringify(rtVendor)} --no-approve`, { stdio: "inherit" }); }
        catch (e) { log("WARN: pi install 失败，将仅写 settings 登记兜底", e.message); }
      }
      let st2 = {};
      try { st2 = JSON.parse(fs.readFileSync(agentSettings, "utf8")); } catch {}
      const pkgs2 = new Set(st2.packages || []);
      for (const p of [...pkgs2]) if (p.includes("mini-harness-runtime") && p !== rtVendor) pkgs2.delete(p);
      pkgs2.add(rtVendor);
      st2.packages = [...pkgs2];
      fs.writeFileSync(agentSettings, JSON.stringify(st2, null, 2));
      log("mini-harness-runtime：已登记（" + rtVendor + "）");
    }
  } catch (e) {
    log("WARN: mini-harness-runtime 登记失败", e.message);
  }
}

// ---- 结果汇总 ----
const remaining = fs.existsSync(path.join(skillsDir, "pi-skills"))
  ? fs.readdirSync(path.join(skillsDir, "pi-skills")).filter((n) => fs.existsSync(path.join(skillsDir, "pi-skills", n, "SKILL.md")))
  : [];
log("剩余启用的 pi-skills:", remaining.join(", ") || "(无)");
log("DONE");
