import { createFakeI18n } from "./fake-i18n.js";

const fakeI18n = createFakeI18n();

const g = globalThis as unknown as Record<string, unknown>;
if (typeof g.chrome === "undefined") {
	g.chrome = { i18n: fakeI18n };
} else {
	const c = g.chrome as Record<string, unknown>;
	if (!c.i18n) c.i18n = fakeI18n;
}
