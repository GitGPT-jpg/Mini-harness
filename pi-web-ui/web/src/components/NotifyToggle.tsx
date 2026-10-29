import { useEffect, useState } from "react";
import { FiBell } from "react-icons/fi";
import { useT } from "../i18n";
import {
	loadNotifySettings,
	saveNotifySettings,
	notifyBlockReason,
	notificationPermission,
	requestNotificationPermission,
	sendTestNotification,
	isWindowsPlatform,
	type NotifyDiagnostics,
	type NotifySettings,
} from "../notify";

/** 设置里的「发送测试通知」诊断面板开关。默认关：一条不听话的通知，是浏览器/系统丢的
 *  还是被我们的抑制条件吞的？排障时改成 true 即可（实现与文案都在，别删）。 */
const SHOW_NOTIFY_TEST_PANEL = false;

/**
 * Desktop / OS (PWA) notification toggle. Rendered at the bottom of the sound
 * dropdown in the top bar. Self-contained: it owns its (persisted) enabled
 * state and requests the browser permission from the user-gesture change
 * handler. When permission is denied the switch flips back so the UI never
 * claims notifications are on.
 *
 * Unavailable cases are reported precisely (`notifyBlockReason`): a missing
 * Notification API because of an insecure address (plain http on a LAN
 * IP/hostname — the typical Windows "open it from my other machine" setup) is
 * NOT the same as an unsupported browser, and the switch is disabled instead of
 * pretending it can be turned on. On Windows an extra hint points at the
 * OS-level gate (Settings → System → Notifications, Focus assist), which is the
 * remaining reason toasts stay silent even with permission granted.
 *
 * 默认界面里**不**摆「发送测试通知」按钮（见上）：平时用不到，但排障时它是唯一能区分
 * 「Edge/Windows 把通知丢了」（`path=none` + 错误）与「我们自己吞了」（`suppressed=true`）
 * 的东西，所以实现（`sendTestNotification` + notifyTest* 文案 + `.notify-test-result`
 * 样式）全部留着。回归：Windows 上最小化后一条通知都收不到、以及同 tag 通知被静默替换。
 */
export function NotifyToggle() {
	const t = useT();
	const [settings, setSettings] = useState<NotifySettings>(loadNotifySettings);
	const [perm, setPerm] = useState<NotificationPermission>(() => notificationPermission());
	const [test, setTest] = useState<NotifyDiagnostics | null>(null);

	// Cheap, side-effect free: re-read on every render so the panel reflects a
	// permission change made in browser settings while the page stayed open.
	const block = notifyBlockReason();
	const blocked = block !== null;
	const windows = isWindowsPlatform();

	// Permission can also change outside the page (browser settings, the native
	// prompt answered elsewhere): re-sync whenever the user comes back to us.
	useEffect(() => {
		const sync = () => setPerm(notificationPermission());
		window.addEventListener("focus", sync);
		document.addEventListener("visibilitychange", sync);
		return () => {
			window.removeEventListener("focus", sync);
			document.removeEventListener("visibilitychange", sync);
		};
	}, []);

	const toggle = async (enabled: boolean) => {
		const next: NotifySettings = { ...settings, enabled };
		setSettings(next);
		saveNotifySettings(next);
		if (enabled) {
			const p = await requestNotificationPermission();
			setPerm(p);
			if (p !== "granted") {
				// Reflect reality: notifications can't be shown, keep the switch off.
				const off: NotifySettings = { ...next, enabled: false };
				setSettings(off);
				saveNotifySettings(off);
			}
		}
	};

	const runTest = async () => {
		// Always say something, even if the toast worked: which route carried it
		// (service worker vs a page notification) is the first thing to check when
		// clicks on the toast do nothing.
		setTest(null);
		const result = await sendTestNotification(t("notifyDoneTitle"), t("notifyTestBody"));
		setTest(result);
	};

	return (
		<div className="sound-menu notify-menu">
			<div className="dd-header">{t("notifyHeader")}</div>

			<label className={`sound-row sound-master${blocked ? " disabled" : ""}`}>
				<span className="sound-label">
					<FiBell className="sound-icon" />
					<span>{t("notifyEnable")}</span>
				</span>
				<input
					type="checkbox"
					checked={settings.enabled && !blocked}
					disabled={blocked}
					onChange={(e) => toggle(e.target.checked)}
				/>
			</label>

			<div className="sound-hint">{t("notifyEnableDesc")}</div>

			{block === "insecure" && <div className="sound-hint">{t("notifyInsecure")}</div>}
			{block === "unsupported" && <div className="sound-hint">{t("notifyUnsupported")}</div>}
			{!blocked && perm === "denied" && <div className="sound-hint">{t("notifyDenied")}</div>}
			{!blocked && windows && <div className="sound-hint">{t("notifyWindowsHint")}</div>}

			{/* 诊断入口（默认关闭，见 SHOW_NOTIFY_TEST_PANEL）：一条不听话的通知，
			    是系统丢的还是我们吞的？ */}
			{SHOW_NOTIFY_TEST_PANEL && !blocked && (
				<>
					<div className="notify-actions">
						<button type="button" className="sound-preview" onClick={() => void runTest()}>
							{t("notifyTest")}
						</button>
					</div>
					{test && (
						<div className="sound-hint notify-test-result">
							<div>
								{test.path === "none"
									? t("notifyTestFailed", { error: test.error ?? "?" })
									: t("notifyTestSent", { path: test.path })}
							</div>
							<div>
								{t("notifyTestState", {
									focus: String(test.presence.hasFocus),
									visibility: test.presence.visibility || "?",
									minimized: String(test.presence.minimized),
									idle: String(Math.round(test.presence.idleMs / 1000)),
								})}
							</div>
							<div>{test.suppressed ? t("notifyTestGateSuppressed") : t("notifyTestGateOpen")}</div>
							{test.path === "sw" && test.held !== null && (
								<div>{test.held > 0 ? t("notifyTestHeld", { count: String(test.held) }) : t("notifyTestDropped")}</div>
							)}
						</div>
					)}
				</>
			)}
		</div>
	);
}
