/**
 * launch-origin — 这个进程是被谁启动的？
 *
 * 界面里有一处需要知道答案：更新面板的「重启服务」按钮。它只有在**退出后会被
 * 自动拉起**的实例上才有意义（`pi-web-ui server start` 起的是这种），前台
 * `pi-web-ui` / `npm run dev` 起的实例点它 = 把服务关掉不回来了。
 *
 * 判定的是「有没有 supervisor 会在本进程退出后把它拉起来」，一共三种：
 *  - **launchd**（macOS，`server install` 写的 plist）——launchd 给每个 job 设
 *    `XPC_SERVICE_NAME`，据此认出我们生成的 label（com.xingshuyin.pi-web-ui /
 *    com.<name>.server）；
 *  - **systemd**（Linux，`Restart=always`）——systemd 给每个 unit 设
 *    `INVOCATION_ID`；unit 名从 /proc/self/cgroup 里取（`…/pi-web-ui.service`）；
 *  - **windows-watchdog**（Windows，`server install` 写的 ps1：
 *    `while ($true) { node …; Start-Sleep 10 }`）——没有环境变量可依，靠 PID
 *    文件反查：ps1 把自己的 PID 写进 `%APPDATA%\pi-web-ui\<name>.pid`，而 node
 *    是它的直接子进程，所以 `process.ppid` 等于文件里那个 PID。同名 ps1 里必须
 *    真的有 watchdog 循环 —— 桌面快捷方式的 ps1 也写同一个 PID 文件，但它
 *    （未安装服务时）是前台跑，退出不会回来。
 *
 * 新版 `server install` 另外烘焙 `PI_WEB_LAUNCHED_BY=service` +
 * `PI_WEB_SERVICE_NAME=<name>`（最高优先级、最明确的一路）；已装好的老服务没有
 * 这两个变量，所以上面的运行时判据必须保留。
 *
 * Docker **刻意不算**：容器由编排/`restart:` 策略管，重启容器不是这个按钮该干的事。
 *
 * 纯函数（env / ppid / fs 读取全部可注入）便于单测；`launchOrigin()` 是进程级
 * 缓存的一次性探测，服务端多处共用同一份结论。
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServiceSupervisor, UiServiceInfo } from "./protocol.js";

/** 默认服务名（`server install` 没传 --name 时）。 */
export const DEFAULT_SERVICE_NAME = "pi-web-ui";
/** 默认 launchd label —— 与 bin/pi-web-ui.mjs 的 serviceLabel() 保持一致。 */
const LAUNCHD_LABEL_DEFAULT = "com.xingshuyin.pi-web-ui";
/** Windows 启动器目录（CLI 的 winServiceDir 同源）。 */
const WIN_SERVICE_DIR_NAME = "pi-web-ui";

export interface LaunchOrigin {
	/** null = 没有 supervisor（前台 / dev / Docker / 未知）。 */
	supervisor: ServiceSupervisor | null;
	/** 服务名（`server install --name`，默认 pi-web-ui）；认不出时缺省。 */
	name?: string;
}

/** 探测输入（全部可注入，默认取真实运行环境）。 */
export interface LaunchOriginInput {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	/** 本进程的父进程 PID（Windows 判据用）。 */
	ppid?: number;
	/** Windows 启动器目录（`%APPDATA%\pi-web-ui`）。 */
	winServiceDir?: string;
	/** 列目录；目录不存在时返回空数组。 */
	listDir?: (dir: string) => string[];
	/** 读文件；不存在/读不了返回 null。 */
	readFile?: (path: string) => string | null;
	/** Linux：/proc/self/cgroup 的内容（推 systemd unit 名）。 */
	readCgroup?: () => string | null;
}

function defaultListDir(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

function defaultReadFile(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** Windows 启动器目录：`%APPDATA%\pi-web-ui`（CLI 的 winServiceDir）。 */
export function winServiceDir(env: NodeJS.ProcessEnv = process.env): string {
	const appData = env.APPDATA?.trim() || join(homedir(), "AppData", "Roaming");
	return join(appData, WIN_SERVICE_DIR_NAME);
}

/** launchd label → 服务名；不是我们生成的 label 返回 null。 */
function nameFromLaunchdLabel(label: string): string | null {
	if (label === LAUNCHD_LABEL_DEFAULT) return DEFAULT_SERVICE_NAME;
	// serviceLabel(`--name foo`) = com.foo.server
	const m = /^com\.(.+)\.server$/.exec(label);
	return m?.[1] ?? null;
}

/** systemd cgroup 内容 → unit 名（`0::/system.slice/pi-web-ui.service`）。 */
function nameFromCgroup(content: string | null): string | undefined {
	const m = /([A-Za-z0-9_.@-]+)\.service/.exec(content ?? "");
	return m?.[1];
}

/** `PI_WEB_LAUNCHED_BY=service` 时的 supervisor（按平台推导）。 */
function supervisorForPlatform(platform: NodeJS.Platform): ServiceSupervisor {
	if (platform === "win32") return "windows-watchdog";
	if (platform === "darwin") return "launchd";
	return "systemd";
}

/** Windows：PID 文件里的 PID === 本进程的 ppid，且同名 ps1 里确实有 watchdog 循环。 */
function detectWindows(input: LaunchOriginInput, env: NodeJS.ProcessEnv): LaunchOrigin {
	const dir = input.winServiceDir ?? winServiceDir(env);
	const listDir = input.listDir ?? defaultListDir;
	const readFile = input.readFile ?? defaultReadFile;
	const ppid = input.ppid ?? process.ppid;

	for (const file of listDir(dir)) {
		if (!file.endsWith(".pid")) continue;
		const raw = readFile(join(dir, file));
		if (raw === null) continue;
		if (Number(raw.trim()) !== ppid) continue;
		const name = file.slice(0, -".pid".length);
		const ps1 = readFile(join(dir, `${name}.ps1`));
		if (ps1 && ps1.includes("while ($true)")) return { supervisor: "windows-watchdog", name };
	}
	return { supervisor: null };
}

/**
 * 探测启动来源。`PI_WEB_LAUNCHED_BY=service` 优先（新版 install 烘焙的），
 * 否则按平台识别 supervisor 自己的运行时痕迹。
 */
export function detectLaunchOrigin(input: LaunchOriginInput = {}): LaunchOrigin {
	const env = input.env ?? process.env;
	const platform = input.platform ?? process.platform;
	const serviceName = env.PI_WEB_SERVICE_NAME?.trim() || undefined;

	if ((env.PI_WEB_LAUNCHED_BY ?? "").trim().toLowerCase() === "service") {
		return { supervisor: supervisorForPlatform(platform), name: serviceName ?? DEFAULT_SERVICE_NAME };
	}

	if (platform === "darwin") {
		const label = env.XPC_SERVICE_NAME?.trim();
		if (!label) return { supervisor: null };
		const name = nameFromLaunchdLabel(label);
		return name ? { supervisor: "launchd", name } : { supervisor: null };
	}

	if (platform === "linux") {
		if (!env.INVOCATION_ID) return { supervisor: null };
		const readCgroup = input.readCgroup ?? defaultReadCgroup;
		return { supervisor: "systemd", name: serviceName ?? nameFromCgroup(readCgroup()) ?? DEFAULT_SERVICE_NAME };
	}

	if (platform === "win32") return detectWindows(input, env);

	return { supervisor: null };
}

function defaultReadCgroup(): string | null {
	return defaultReadFile("/proc/self/cgroup");
}

let cached: LaunchOrigin | null = null;

/** 进程级缓存的一次性探测（服务端多处共用：ready 消息 / quit 语义 / 控制 socket）。 */
export function launchOrigin(): LaunchOrigin {
	cached ??= detectLaunchOrigin();
	return cached;
}

/** 下发给浏览器的服务信息（null = 没有 supervisor，界面不提供「重启服务」）。 */
export function toServiceInfo(origin: LaunchOrigin): UiServiceInfo | null {
	if (!origin.supervisor) return null;
	return { name: origin.name ?? DEFAULT_SERVICE_NAME, supervisor: origin.supervisor };
}
