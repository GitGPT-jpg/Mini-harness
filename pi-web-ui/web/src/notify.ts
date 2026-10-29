/**
 * Desktop / OS (PWA) notifications for pi-web-ui.
 *
 * Lightweight, frontend-only notifications via the browser Notification API.
 * They are routed through the registered service worker (reg.showNotification)
 * so they still appear when the installed PWA is running in the background /
 * minimised — exactly the "a session finished / needs your input while I'm in
 * another app" case from issue #13. No server-side web push (that would need a
 * subscription + VAPID + push endpoint; out of scope).
 *
 * Notifications only fire while the user is NOT watching the page, so they
 * never spam someone who is actively looking at the chat — that case is
 * covered by the in-app sound cues.
 *
 * Windows notes (why this file is not just "focus ? skip : show")
 * ---------------------------------------------------------------
 * On Windows (measured on Win11 with Edge 2026-09, same on Chrome) a
 * *minimised* browser window keeps lying about every standard presence signal:
 *
 *     focused+visible : hasFocus=true  visibilityState="visible"  screenX=10      outerHeight=808
 *     minimised       : hasFocus=true  visibilityState="visible"  screenX=-21334  outerHeight=20   (Edge)
 *     minimised       : hasFocus=true  visibilityState="visible"  screenX=-32000  outerHeight=28   (Chrome)
 *
 * No `blur`, no `visibilitychange` — a minimised window is completely
 * invisible to `hasFocus()`/Page Visibility, which is why "focus alone" (v0.75)
 * and "focus and visible" (v0.75.0) both silently ate every notification in
 * exactly the "I minimised the app and went away" case this feature exists for.
 * The two signals that DO change are the native window rectangle ones:
 * `screenX`/`screenY` jump to the Win32 "minimised" coordinates (off-screen by
 * 20000+ px) and `outerWidth`/`outerHeight` collapse to the title-bar size. See
 * `isCollapsedWindow()`.
 *
 * Even with that, `hasFocus()` is the only thing that can tell "another app has
 * the foreground" from "I am looking at the chat" — and if it lies again we
 * would silently swallow the notification (worse than one redundant toast), so
 * on Windows the suppression additionally requires recent real interaction with
 * the page (`NOTIFY_IDLE_GRACE_MS`): no pointer/keyboard/touch/wheel activity
 * for that long means we are not confident the user is watching, and a toast
 * costs nothing compared to a missed reminder. Non-Windows platforms keep the
 * strict focus+visibility rule (their signals are trustworthy).
 *
 * `new Notification()` is a valid fallback in Chrome/Edge on Windows when no
 * service worker is registered / active yet (dev mode, first load after an
 * update), but such a toast has no click handling at all; through the SW path a
 * click focuses / reopens the app window (`notificationclick` in `sw.js`).
 *
 * There is a second Windows trap that cost a round of debugging: notifications
 * must NOT carry a `tag`. Windows replaces an existing toast that has the same
 * tag *silently* — no banner, no sound — and as long as one pi-web-ui toast is
 * still sitting in the notification centre, every later notification is
 * swallowed the same way (`showNotification` still resolves, so the page thinks
 * it worked). Empirically the user had to empty the notification centre before
 * each test; `renotify: true` did not help (Chromium's renotify does not reach
 * the Windows toast layer). Each notification is therefore its own toast — the
 * Action Center accumulates a few entries, which beats silent reminders.
 *
 * Windows toasts are additionally gated by the OS: the browser (or the
 * installed PWA) must be allowed under Settings → System → Notifications and
 * Focus assist must be off. Nothing in the page can override that, so the
 * settings UI shows a hint (`notifyWindowsHint`). For the hard cases there is a
 * diagnostic (`sendTestNotification`: route, error, whether the browser really
 * kept the notification, presence snapshot) whose UI lives behind the
 * `SHOW_NOTIFY_TEST_PANEL` flag in `components/NotifyToggle.tsx` — normally off,
 * flip it on to tell "the OS dropped it" apart from "our gate swallowed it".
 */

import { appUrl } from "./base-url";

export interface NotifySettings {
	/** Master switch — kills every OS notification. */
	enabled: boolean;
}

const STORAGE_KEY = "pi-web-notify";

const DEFAULT_NOTIFY_SETTINGS: NotifySettings = { enabled: false };

/** Read persisted settings, falling back to defaults on any failure. */
export function loadNotifySettings(): NotifySettings {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return { ...DEFAULT_NOTIFY_SETTINGS };
		const parsed = JSON.parse(raw) as Partial<NotifySettings>;
		return { enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_NOTIFY_SETTINGS.enabled };
	} catch {
		return { ...DEFAULT_NOTIFY_SETTINGS };
	}
}

export function saveNotifySettings(settings: NotifySettings): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
	} catch {
		// storage unavailable (private mode etc.) — notifications just won't persist
	}
}

export function notificationsSupported(): boolean {
	return typeof window !== "undefined" && "Notification" in window;
}

/** Why OS notifications are unavailable (null = available and usable). */
type NotifyBlockReason = "insecure" | "unsupported";

/**
 * Classify *why* notifications are unavailable so the UI can say something
 * true instead of the blanket "this browser does not support notifications".
 *
 * The interesting case is `insecure`: Chromium only exposes the Notification
 * API in a secure context (https, or http on localhost/127.0.0.1/::1).
 * Opening pi-web-ui over plain http on a LAN IP or machine hostname — the
 * usual Windows "serve here, open it from another PC" setup — has no
 * `Notification` object at all even though the browser supports notifications
 * perfectly well; only the address is at fault. Fix = open via 127.0.0.1 or put
 * HTTPS in front (nginx/tailscale/caddy).
 */
export function notifyBlockReason(): NotifyBlockReason | null {
	if (notificationsSupported()) return null;
	if (typeof window !== "undefined" && window.isSecureContext === false) return "insecure";
	return "unsupported";
}

/* ------------------------------------------------------------------ */
/* Presence: is the user actually watching this page?                  */
/* ------------------------------------------------------------------ */

/** Native window rectangle as seen from the page (the only Windows-minimise
 *  signal that survives contact with reality, see the file header). */
interface WindowRect {
	screenX: number;
	screenY: number;
	outerWidth: number;
	outerHeight: number;
}

/** How long a platform may be without user interaction before we stop believing
 *  it is being watched (Windows only — its presence signals are the buggy ones). */
export const NOTIFY_IDLE_GRACE_MS = 120_000;

/** Everything the suppression decision needs. Plain data → unit testable. */
export interface PresenceSignals {
	hasFocus: boolean;
	visibility: string;
	/** Window is minimised to the taskbar (native geometry says so). */
	minimized: boolean;
	/** Milliseconds since the last real user interaction with this page. */
	idleMs: number;
	/** Windows: `hasFocus()` is not trustworthy, apply the idle escape hatch. */
	windows: boolean;
}

/**
 * Is this window collapsed to the taskbar?
 *
 * Pure function over the native window rectangle. Windows minimises by moving
 * the window to the Win32 "minimised" position (Chrome reports -32000, Edge
 * -21334) and collapsing `outerWidth/Height` to the title bar (108×20 /
 * 160×28); `hasFocus()` and `visibilityState` stay put and are therefore
 * useless here. The thresholds are deliberately far outside any real monitor
 * layout (three 4K monitors stacked leftwards reach ≈ -11520; a window can't
 * legitimately be 40px tall while being a browser window).
 */
export function isCollapsedWindow(rect: WindowRect): boolean {
	const { screenX, screenY, outerWidth, outerHeight } = rect;
	if (Number.isFinite(screenX) && offScreen(screenX)) return true;
	if (Number.isFinite(screenY) && offScreen(screenY)) return true;
	// 宽高都塌到标题栏大小才算（> 0 是必须的：无窗口环境如 headless 报 0×0，
	// 那是「量不到」而不是「最小化」）。
	return outerWidth > 0 && outerWidth <= 400 && outerHeight > 0 && outerHeight <= 40;
}

/** Far enough off-screen that no monitor layout can explain it. */
function offScreen(coordinate: number): boolean {
	return coordinate <= -10000;
}

/**
 * Swallow the notification because the user is already looking at it?
 *
 * Requires a visible page, a window that is neither minimised nor collapsed,
 * window focus, and — on Windows, where focus/visibility are known to lie —
 * recent interaction with the page. Anything less than "confident" notifies:
 * a redundant toast is cheap, a missed reminder is the bug this exists for.
 * Pure function → unit tested.
 */
export function shouldSuppressNotify(presence: PresenceSignals): boolean {
	if (presence.visibility !== "visible") return false;
	if (presence.minimized) return false;
	if (!presence.hasFocus) return false;
	if (presence.windows && presence.idleMs > NOTIFY_IDLE_GRACE_MS) return false;
	return true;
}

/* ------------------------------------------------------------------ */
/* User-activity tracking (feeds `idleMs`)                             */
/* ------------------------------------------------------------------ */

let lastActivityMs = Date.now();
let activityBound = false;

/** Record "the user just did something on this page". */
export function markActivity(): void {
	lastActivityMs = Date.now();
}

/** Milliseconds since the last recorded interaction. */
export function idleSinceLastActivityMs(): number {
	return Math.max(0, Date.now() - lastActivityMs);
}

/** One-time (cheap, passive) listeners; safe to call repeatedly. */
function bindActivityTracking(): void {
	if (activityBound || typeof window === "undefined") return;
	activityBound = true;
	const options: AddEventListenerOptions = { passive: true, capture: true };
	for (const event of ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "focus", "scroll"]) {
		window.addEventListener(event, markActivity, options);
	}
	if (typeof document !== "undefined") {
		document.addEventListener("visibilitychange", markActivity, options);
	}
}

/** True on Windows (the platform whose presence signals need the extra work). */
export function isWindowsPlatform(): boolean {
	if (typeof navigator === "undefined") return false;
	return /windows/i.test(navigator.userAgent ?? "");
}

/** Snapshot the current presence signals (also used by the settings UI/诊断). */
export function currentPresence(): PresenceSignals {
	bindActivityTracking();
	if (typeof window === "undefined" || typeof document === "undefined") {
		return { hasFocus: true, visibility: "visible", minimized: false, idleMs: 0, windows: false };
	}
	return {
		hasFocus: typeof document.hasFocus === "function" ? document.hasFocus() : true,
		visibility: document.visibilityState ?? "",
		minimized: isCollapsedWindow({
			screenX: window.screenX,
			screenY: window.screenY,
			outerWidth: window.outerWidth,
			outerHeight: window.outerHeight,
		}),
		idleMs: idleSinceLastActivityMs(),
		windows: isWindowsPlatform(),
	};
}

/* ------------------------------------------------------------------ */
/* Showing notifications                                               */
/* ------------------------------------------------------------------ */

export function notificationPermission(): NotificationPermission {
	if (!notificationsSupported()) return "denied";
	return Notification.permission;
}

/** Request the notification permission. MUST be called from a user gesture
 *  (e.g. toggling the switch) or the browser rejects it. */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
	if (!notificationsSupported()) return "denied";
	try {
		return await Notification.requestPermission();
	} catch {
		return "denied";
	}
}

/** Which route actually put the toast on screen (for diagnostics). */
type NotifyPath = "sw" | "page" | "none";

interface NotifyAttempt {
	path: NotifyPath;
	/** Failure detail when `path === "none"` (or the SW route that was skipped). */
	error?: string;
}

function describeError(err: unknown): string {
	if (err instanceof Error) return `${err.name}: ${err.message}`;
	return String(err);
}

function notificationOptions(body?: string, sticky = false): NotificationOptions {
	return {
		body,
		// 测试通知用 sticky（requireInteraction）：横幅一出就不会自己滑走，人为
		// 点一下才消失 —— 一条「一秒就没了」的测试通知等于没测。
		requireInteraction: sticky,
		// appUrl keeps the icon path valid under nginx sub-path deployments
		// (e.g. /pi/); root deployments resolve to the exact same URL.
		icon: appUrl("/icons/icon-192.png"),
		badge: appUrl("/icons/icon-192.png"),
		// 故意**不**用 tag。Windows 上「同 tag 的新通知只是替换旧条目」是静默的
		// —— 没有横幅、没有提示音，而且系统通知中心里只要还躺着一条旧通知，
		// 后续每一条都会被无声替换掉（实测：手动清空通知中心后才能再弹一次；
		// 加 renotify: true 也救不回来 —— Chromium 的 renotify 到 Windows toast
		// 这层不起作用）。所以每条通知都是一个新 toast：一定提醒，代价只是通知
		// 中心里会累积几条。
		// Click target for the service worker's `notificationclick` handler
		// (brings the window back on Windows/Linux, where a toast click would
		// otherwise do nothing). `location.href` keeps PI_WEB_TOKEN intact.
		data: { url: typeof location !== "undefined" ? location.href : appUrl("/") },
	};
}

/**
 * Put a toast on screen, right now, whatever the presence signals say.
 * Prefers the service worker (works while the PWA is backgrounded, and its
 * click handler brings the window back) and falls back to a plain page
 * notification — including when the SW route *throws* (registration present but
 * not active yet: first load / right after an update), which used to swallow
 * the notification entirely. Never throws.
 */
async function showNow(title: string, body?: string, sticky = false): Promise<NotifyAttempt> {
	if (!notificationsSupported()) return { path: "none", error: "unsupported" };
	if (Notification.permission !== "granted") return { path: "none", error: `permission: ${Notification.permission}` };

	const options = notificationOptions(body, sticky);
	let swError: string | undefined;
	try {
		const reg = await navigator.serviceWorker?.getRegistration();
		if (reg?.active && typeof reg.showNotification === "function") {
			await reg.showNotification(title, options);
			return { path: "sw" };
		}
		swError = reg ? "service worker not active" : "no service worker registration";
	} catch (err) {
		swError = describeError(err);
	}
	try {
		new Notification(title, options);
		return { path: "page", error: swError };
	} catch (err) {
		return { path: "none", error: `${swError}; page: ${describeError(err)}` };
	}
}

/** Show an OS notification when enabled + granted AND the user is not watching
 *  this page. Otherwise it is a safe no-op — including when the browser
 *  withholds the API (insecure context / old browser), where the settings UI
 *  explains the reason instead. Never throws. */
export async function notify(title: string, body?: string): Promise<void> {
	if (!notificationsSupported()) return;
	// User is watching — don't spam; sound covers it.
	if (shouldSuppressNotify(currentPresence())) return;
	if (!loadNotifySettings().enabled) return;
	await showNow(title, body);
}

/** Handle for the settings-panel diagnostics: with no `tag` on our
 *  notifications (see `notificationOptions` — a tag makes Windows replace the
 *  old toast *silently*), this asks the browser what it still holds for this
 *  origin (`held`). */
export interface NotifyDiagnostics extends NotifyAttempt {
	permission: NotificationPermission;
	supported: boolean;
	secureContext: boolean;
	/** A service worker registration exists (its `active` state decides the route). */
	serviceWorker: boolean;
	/** Would `notify()` swallow a notification right now? */
	suppressed: boolean;
	presence: PresenceSignals;
	/**
	 * Notifications the *browser* still holds for this origin right after
	 * showing (null = could not ask). `> 0` means the browser accepted and is
	 * displaying it, so a missing banner is an OS/browser-display setting
	 * (Windows banner toggles, Edge quiet notifications, Do not disturb); `0`
	 * means the browser dropped it and the browser-side settings are at fault.
	 */
	held: number | null;
}

/**
 * Fire one notification immediately, bypassing the "user is watching" gate, and
 * report how it went. This is the settings panel's "send a test notification"
 * button: a toast that never arrives is either dropped by the OS/browser
 * (`path: "none"` + error) or was suppressed by us (`suppressed: true`) — and
 * the presence snapshot shows which lie the platform is telling.
 */
export async function sendTestNotification(title: string, body?: string): Promise<NotifyDiagnostics> {
	const presence = currentPresence();
	const base = {
		permission: notificationPermission(),
		supported: notificationsSupported(),
		secureContext: typeof window !== "undefined" ? window.isSecureContext !== false : false,
		serviceWorker: false,
		suppressed: shouldSuppressNotify(presence),
		presence,
		held: null as number | null,
	};
	if (!base.supported) return { ...base, path: "none", error: "unsupported" };
	let reg: ServiceWorkerRegistration | undefined;
	try {
		reg = await navigator.serviceWorker?.getRegistration();
		base.serviceWorker = !!reg;
	} catch {
		// ignore — only used as a hint in the UI
	}
	const attempt = await showNow(title, body, true);
	// Ask the browser whether it really kept the notification: this is what
	// separates "the OS/browser never took it" from "it is sitting in the
	// notification centre but the banner was suppressed".
	if (attempt.path === "sw" && reg?.active && typeof reg.getNotifications === "function") {
		try {
			base.held = (await reg.getNotifications()).length;
		} catch {
			base.held = null;
		}
	}
	return { ...base, ...attempt };
}
