/**
 * PI_WEB_TOKEN authentication smoke test.
 * Verifies:
 * 1. Explicit PI_WEB_TOKEN:
 *    - /api/health is always open (200) and does NOT set pi_web_token cookie without valid token (#45).
 *    - Protected HTTP routes (/api/themes) return 401 without token or with wrong token.
 *    - ?token= query, Authorization: Bearer, X-PI-Token, and Cookie: pi_web_token all authenticate (200).
 *    - Valid ?token= sets Set-Cookie: pi_web_token=<encodeURIComponent(token)>; HttpOnly; SameSite=Strict.
 *    - Tokens containing '=' (e.g. base64) round-trip through Set-Cookie and Cookie header (#261).
 *    - Stale cookie after token rotation returns 401 with Max-Age=0 clear cookie, while stale cookie + valid ?token= succeeds and refreshes cookie (#71).
 *    - WebSocket /ws rejects unauthenticated or wrong-token upgrade (401) and accepts ?token=, Authorization: Bearer, or Cookie.
 * 2. PI_WEB_TOKEN=auto:
 *    - Generates and persists a 48-hex-char token in <DATA_DIR>/pi-web-token (mode 0600 on POSIX) and reuses it across restarts.
 */
import { portUp, freePort } from "./lib/port-utils.mjs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

/* eslint-env node */

const PROJ = fileURLToPath(new globalThis.URL("../", import.meta.url));

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
}

async function startServer(port, token, dataDir) {
	const proc = spawn("node", ["dist/server/index.js"], {
		cwd: PROJ,
		env: {
			...process.env,
			PI_WEB_PORT: String(port),
			PI_WEB_DATA_DIR: dataDir,
			PI_WEB_CWD: PROJ,
			PI_WEB_TOKEN: token,
		},
		stdio: "ignore",
	});
	for (let i = 0; i < 60; i++) {
		await sleep(200);
		if (await portUp(port)) return proc;
	}
	proc.kill();
	throw new Error(`server on port ${port} did not start`);
}

function connectWs(url, headers = {}) {
	return new Promise((resolve) => {
		const ws = new WebSocket(url, { headers });
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			try {
				ws.close();
			} catch {
				/* ignore */
			}
			resolve(result);
		};
		ws.on("open", () => finish({ ok: true }));
		ws.on("unexpected-response", (_req, res) => finish({ ok: false, status: res.statusCode }));
		ws.on("error", (err) => finish({ ok: false, error: err.message }));
	});
}

async function run() {
	const port = 8946;
	await freePort(port);
	const dataDir = mkdtempSync(join(tmpdir(), "pi-web-token-auth-"));
	// Include '=' in token to exercise URL-encoded cookie round-trip (#261)
	const token = "sec_tok_base64_pad==";
	const encodedToken = encodeURIComponent(token);

	let server = await startServer(port, token, dataDir);
	try {
		const base = `http://127.0.0.1:${port}`;
		const protectedPath = "/api/themes?probe=1";

		// 1. /api/health is open without token and does NOT set cookie (#45)
		const healthRes = await fetch(`${base}/api/health`);
		const healthCookie = healthRes.headers.get("set-cookie") || "";
		check("/api/health returns 200 without token", healthRes.status === 200, `status=${healthRes.status}`);
		check(
			"/api/health without token does not set pi_web_token cookie (#45)",
			!healthCookie.includes("pi_web_token="),
			healthCookie,
		);

		// Safari requests tab icons without cookies; public images must not leak auth.
		for (const path of ["/icons/icon-192.png?v=4", "/favicon.png"]) {
			const iconRes = await fetch(`${base}${path}`);
			check(
				`public icon ${path} returns image without token`,
				iconRes.status === 200 && (iconRes.headers.get("content-type") || "").startsWith("image/"),
			);
			check(
				`public icon ${path} does not set auth cookie`,
				!(iconRes.headers.get("set-cookie") || "").includes("pi_web_token="),
			);
		}
		for (const path of ["/icons/private.json", "/icons/nested/image.png", "/favicon.png/private"]) {
			const res = await fetch(`${base}${path}`);
			check(`icon-like protected path ${path} returns 401`, res.status === 401);
		}

		// 2. Protected route without token -> 401
		const noAuthRes = await fetch(`${base}${protectedPath}`);
		check("protected route without token returns 401", noAuthRes.status === 401, `status=${noAuthRes.status}`);

		// 3. Protected route with wrong token -> 401
		const badAuthRes = await fetch(`${base}${protectedPath}&token=wrong`);
		check("protected route with wrong token returns 401", badAuthRes.status === 401, `status=${badAuthRes.status}`);

		// 4. Protected route with ?token= -> 200 + Set-Cookie with encoded token
		const queryRes = await fetch(`${base}${protectedPath}&token=${encodedToken}`);
		const setCookie = queryRes.headers.get("set-cookie") || "";
		check("protected route with ?token= returns 200", queryRes.status === 200, `status=${queryRes.status}`);
		check(
			"?token= sets HttpOnly pi_web_token cookie (#261)",
			setCookie.includes(`pi_web_token=${encodedToken}`) && setCookie.includes("HttpOnly"),
			setCookie,
		);

		// 5. Cookie authentication works for tokens containing '=' (#261)
		const cookieRes = await fetch(`${base}${protectedPath}`, {
			headers: { Cookie: `pi_web_token=${encodedToken}` },
		});
		check("Cookie: pi_web_token authenticates (#261)", cookieRes.status === 200, `status=${cookieRes.status}`);

		// 6. Authorization: Bearer and X-PI-Token headers authenticate
		const bearerRes = await fetch(`${base}${protectedPath}`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		check("Authorization: Bearer authenticates", bearerRes.status === 200, `status=${bearerRes.status}`);

		const headerRes = await fetch(`${base}${protectedPath}`, {
			headers: { "X-PI-Token": token },
		});
		check("X-PI-Token header authenticates", headerRes.status === 401 ? false : headerRes.status === 200);

		// 7. Stale cookie returns 401 and clears cookie; stale cookie + valid ?token= refreshes cookie (#71)
		const staleRes = await fetch(`${base}${protectedPath}`, {
			headers: { Cookie: "pi_web_token=old_stale_token" },
		});
		const staleCookieHeader = staleRes.headers.get("set-cookie") || "";
		check(
			"stale cookie returns 401 and clears cookie (#71)",
			staleRes.status === 401 && staleCookieHeader.includes("Max-Age=0"),
			`status=${staleRes.status} cookie=${staleCookieHeader}`,
		);

		const refreshRes = await fetch(`${base}${protectedPath}&token=${encodedToken}`, {
			headers: { Cookie: "pi_web_token=old_stale_token" },
		});
		const refreshCookieHeader = refreshRes.headers.get("set-cookie") || "";
		check(
			"stale cookie + valid ?token= returns 200 and refreshes cookie (#71)",
			refreshRes.status === 200 && refreshCookieHeader.includes(`pi_web_token=${encodedToken}`),
			`status=${refreshRes.status}`,
		);

		// 8. WebSocket /ws auth checks
		const wsNoAuth = await connectWs(`ws://127.0.0.1:${port}/ws`);
		check("WS without token rejected with 401", !wsNoAuth.ok && wsNoAuth.status === 401, JSON.stringify(wsNoAuth));

		const wsBadAuth = await connectWs(`ws://127.0.0.1:${port}/ws?token=wrong`);
		check(
			"WS with wrong token rejected with 401",
			!wsBadAuth.ok && wsBadAuth.status === 401,
			JSON.stringify(wsBadAuth),
		);

		const wsQuery = await connectWs(`ws://127.0.0.1:${port}/ws?token=${encodedToken}`);
		check("WS with ?token= connects", wsQuery.ok === true, JSON.stringify(wsQuery));

		const wsCookie = await connectWs(`ws://127.0.0.1:${port}/ws`, {
			Cookie: `pi_web_token=${encodedToken}`,
		});
		check("WS with Cookie: pi_web_token connects", wsCookie.ok === true, JSON.stringify(wsCookie));

		const wsBearer = await connectWs(`ws://127.0.0.1:${port}/ws`, {
			Authorization: `Bearer ${token}`,
		});
		check("WS with Authorization: Bearer connects", wsBearer.ok === true, JSON.stringify(wsBearer));
	} finally {
		server.kill();
		await freePort(port);
	}

	// 9. PI_WEB_TOKEN=auto persistence test
	const autoDir = mkdtempSync(join(tmpdir(), "pi-web-token-auto-"));
	const tokenFile = join(autoDir, "pi-web-token");
	server = await startServer(port, "auto", autoDir);
	let autoToken = "";
	try {
		check("PI_WEB_TOKEN=auto creates pi-web-token file", existsSync(tokenFile));
		autoToken = readFileSync(tokenFile, "utf-8").trim();
		check("auto token is 48 hex chars", /^[0-9a-f]{48}$/.test(autoToken), `len=${autoToken.length}`);
		if (process.platform !== "win32") {
			const mode = statSync(tokenFile).mode & 0o777;
			check("pi-web-token has 0600 permissions", mode === 0o600, `mode=0${mode.toString(8)}`);
		}
		const protectedPath = "/api/themes?probe=1";
		const res = await fetch(`http://127.0.0.1:${port}${protectedPath}&token=${autoToken}`);
		check("auto token authenticates HTTP request", res.status === 200, `status=${res.status}`);
	} finally {
		server.kill();
		await freePort(port);
	}

	// Restart with PI_WEB_TOKEN=auto on same dataDir -> reuses same token
	server = await startServer(port, "auto", autoDir);
	try {
		const reusedToken = readFileSync(tokenFile, "utf-8").trim();
		check("PI_WEB_TOKEN=auto reuses persisted token across restart", reusedToken === autoToken);
	} finally {
		server.kill();
		await freePort(port);
	}

	console.log(failures === 0 ? "PASS token-auth-test" : `FAIL token-auth-test (${failures})`);
	process.exit(failures === 0 ? 0 : 1);
}

run().catch((err) => {
	console.error("token-auth-test crashed:", err);
	process.exit(1);
});
