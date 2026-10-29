/**
 * pi-web-ui — Progressive Web App service worker.
 *
 * Strategy overview
 * -----------------
 * pi-web-ui is a WebSocket-first app that needs a live backend, so we do NOT
 * try to make it fully offline. Instead the SW focuses on what makes it a
 * reliable *installable* PWA on mobile/desktop:
 *
 *   - network-first for navigation requests (falls back to the cached app
 *     shell when the network flaps), and
 *   - cache-first for hashed static assets, which Vite fingerprints so a cache
 *     hit is always the right version until a new deploy publishes new hashes.
 *
 * It also owns notification clicks (`notificationclick`): the desktop / OS
 * notifications posted from the page carry the page URL in `data.url`, and a
 * click must bring the app back — on Windows (and Linux) the click handler is
 * the only thing that can do that, otherwise the toast just disappears.
 *
 * Real-time / dynamic / credential-bearing routes (/ws, /api, /themes,
 * /plugins) are always fetched from the network and never cached, so we never
 * risk serving stale theme/plugin code or caching anything sensitive.
 */

const BUILD_ID = "__BUILD_ID__";
const STATIC_CACHE = BUILD_ID.startsWith("__") ? "pi-web-ui-static-dev" : `pi-web-ui-static-${BUILD_ID}`;
const SHELL_CACHE = "pi-web-ui-shell-v1";

// App root within this origin — "/" for root deployments, "/pi/" behind an
// nginx sub-path reverse proxy. All path checks below are relative to it, so
// the worker behaves identically under either deployment layout.
const SCOPE = new URL("./", self.registration.scope).pathname;

/** Map a request pathname to an app-relative path ("/pi/ws" → "/ws"), or null
 *  when the request lies outside the registration scope (shouldn't happen). */
function appPath(pathname) {
	if (SCOPE === "/") return pathname;
	if (pathname.startsWith(SCOPE)) return "/" + pathname.slice(SCOPE.length);
	return null;
}

self.addEventListener("install", (event) => {
	// Take control as soon as this version activates so the current page is
	// served by the new worker without requiring a second reload.
	self.skipWaiting();
	event.waitUntil(caches.open(SHELL_CACHE));
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(keys.filter((k) => k !== STATIC_CACHE && k !== SHELL_CACHE).map((k) => caches.delete(k))),
			)
			// Apply to already-open pages immediately.
			.then(() => self.clients.claim()),
	);
});

// Only cache simple, safe GET requests. Everything else goes straight through.
function isCachable(request) {
	const method = request.method;
	if (method !== "GET") return false;

	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return false;

	// Never cache real-time, dynamic or credential/data endpoints.
	const path = appPath(url.pathname);
	if (
		path === null ||
		path.startsWith("/ws") ||
		path.startsWith("/api") ||
		path.startsWith("/themes") ||
		path.startsWith("/plugins")
	) {
		return false;
	}
	return true;
}

function assetContentOk(requestUrl, response) {
	const ct = (response.headers.get("content-type") || "").toLowerCase();
	const path = requestUrl.pathname.toLowerCase();
	if (path.endsWith(".js")) return ct.includes("javascript");
	if (path.endsWith(".css")) return ct.includes("css");
	if (path.endsWith(".svg")) return ct.includes("svg");
	if (path.endsWith(".webmanifest")) return ct.includes("json");
	return true;
}

self.addEventListener("fetch", (event) => {
	const { request } = event;
	if (!isCachable(request)) {
		// Let the browser/backend handle WebSockets, API calls and cross-origin
		// requests normally.
		return;
	}

	const requestUrl = new URL(request.url);

	// Navigation → app shell. Network-first with cached fallback: users get the
	// latest build when online but can still reopen the app while flaky.
	if (request.mode === "navigate") {
		event.respondWith(
			fetch(request)
				.then((response) => {
					const copy = response.clone();
					caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
					return response;
				})
				.catch(() => caches.match(request).then((cached) => cached || caches.match(SCOPE) || Response.error())),
		);
		return;
	}

	// Static assets (hashed by Vite) → cache-first.
	const path = appPath(requestUrl.pathname);
	const isStatic =
		path !== null &&
		(path.startsWith("/assets/") ||
			path.startsWith("/icons/") ||
			path === "/favicon.svg" ||
			path === "/icon.ico" ||
			path === "/manifest.webmanifest");

	if (isStatic) {
		event.respondWith(
			caches.match(request).then((cached) => {
				if (cached) return cached;
				return fetch(request)
					.then((response) => {
						// Only cache bytes matching the extension: a missing file falls
						// through to the SPA catch-all (index.html, 200) and must never be
						// stored under an asset URL, or the page stays black until purged.
						if (response && response.ok && assetContentOk(requestUrl, response)) {
							const copy = response.clone();
							caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy));
						}
						return response;
					})
					.catch(() => caches.match(request).then((fallback) => fallback || Response.error()));
			}),
		);
	}
});

// ---------------------------------------------------------------------------
// Notification clicks.
//
// The page posts desktop / OS notifications (see web/src/notify.ts) with
// `data.url` = the URL that raised them. A click must bring the app back:
// on Windows (and Linux) this handler is the only thing that can do that —
// the toast would otherwise just disappear, which is why "nothing happens when
// I click the reminder" is a platform-level dead end rather than a UI bug.
// Focus the window that is already open (a tab or the installed PWA — a
// minimised window still counts as open) and only open a new one when none
// exists. Windows never restores a window for us, so we match on URL first so
// the session that raised the notification is the one that comes forward.
self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const target = (event.notification.data && event.notification.data.url) || new URL(SCOPE, self.location.origin).href;

	event.waitUntil(
		self.clients
			.matchAll({ type: "window", includeUncontrolled: true })
			.then((clients) => {
				const inScope = clients.filter((client) => appPath(new URL(client.url).pathname) !== null);
				const match = inScope.find((client) => client.url === target) || inScope[0];
				// focus() rejects when the browser refuses to raise the window
				// (rare); fall back to just returning the client so the click
				// never logs an unhandled rejection.
				if (match) return match.focus ? match.focus().catch(() => match) : match;
				return self.clients.openWindow(target);
			})
			.catch(() => undefined),
	);
});
