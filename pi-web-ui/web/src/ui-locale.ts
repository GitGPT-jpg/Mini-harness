import { pickLocale } from "./pick-locale.js";

/** Event fired when the effective UI locale changes. */
export const UI_LOCALE_EVENT = "pi-web-ui:locale";

const STORAGE_KEY = "pi-web-ui:lang";

/** The locale currently rendered by LanguageProvider, before it reaches React consumers. */
let effectiveLocale: string | null = null;

/**
 * Resolve and remember the first locale synchronously during provider render.
 *
 * This deliberately only reads localStorage. Automatic detection is reported
 * to the server through the locale event, but is not persisted as a choice.
 */
export function initializeUiLocale(
	saved: string | null | undefined,
	languages: readonly string[] | null | undefined,
): string {
	effectiveLocale = pickLocale(saved, languages, null);
	return effectiveLocale;
}

/**
 * Return the effective locale for the WebSocket hello message.
 *
 * The fallback makes the socket layer safe to use outside LanguageProvider
 * (for example, in an embedded shell or a focused unit test).
 */
export function currentUiLocale(): string {
	if (effectiveLocale) return effectiveLocale;
	return initializeUiLocale(readSavedLocale(), typeof navigator !== "undefined" ? navigator.languages : []);
}

/** Update the synchronous locale snapshot without producing a browser event. */
function setEffectiveLocale(locale: string): void {
	const value = locale.trim();
	if (value) effectiveLocale = value;
}

/**
 * Remember and broadcast a locale change. This does not touch localStorage;
 * only an explicit UI selection should be persisted by LanguageProvider.
 */
export function announceUiLocale(locale: string): void {
	const value = locale.trim();
	if (!value) return;
	setEffectiveLocale(value);
	try {
		window.dispatchEvent(new CustomEvent<string>(UI_LOCALE_EVENT, { detail: value }));
	} catch {
		// Non-DOM environments still get the synchronous value for hello.
	}
}

function readSavedLocale(): string | null {
	try {
		return localStorage.getItem(STORAGE_KEY);
	} catch {
		return null;
	}
}
