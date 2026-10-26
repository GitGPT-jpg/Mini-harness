let cachedDefaultStreamFn;
/**
 * The default pi-ai stream function (dispatches to registered API providers).
 * It moved from the package root to the `./compat` subpath in pi-ai 0.85, so
 * it is resolved lazily — a static import of either path breaks the other pi
 * version at load time. Cached after the first resolution.
 */
async function resolveDefaultStreamFn() {
    if (cachedDefaultStreamFn)
        return cachedDefaultStreamFn;
    const root = await import("@earendil-works/pi-ai");
    const rootFn = root.streamSimple;
    if (rootFn) {
        cachedDefaultStreamFn = rootFn;
        return rootFn;
    }
    // pi-ai >= 0.85 exposes streamSimple via the ./compat subpath. The
    // specifier is a variable so static tooling (vite in vitest, jiti in pi)
    // cannot resolve a subpath that does not exist in pi < 0.85; at runtime
    // this branch is only reached when the root import lacks streamSimple.
    const compatSpecifier = "@earendil-works/pi-ai/compat";
    const compat = await import(compatSpecifier);
    cachedDefaultStreamFn = compat.streamSimple;
    return cachedDefaultStreamFn;
}
/**
 * Rejects after `timeoutMs` if `promise` has not settled. Exported for tests;
 * the stall timer is unref'd so a winning race leaves nothing pending.
 */
export function raceWithTimeout(promise, timeoutMs, message) {
    let timer;
    const stalled = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
    });
    return Promise.race([promise, stalled]);
}
/**
 * Run a sub-agent loop to completion.
 *
 * Returns nothing useful directly — by design, results are collected by the
 * `tools` the caller passes (their `execute` accumulates into caller-owned
 * state). This keeps the runner generic across every background task type.
 *
 * Rejections from the loop (provider errors, auth failures, a streamFn that
 * throws) reject this promise, so `BackgroundRuntime.launchTask`'s try/catch
 * degrades them to a warning toast.
 */
export async function runSubAgent(args) {
    const { model, apiKey, headers, systemPrompt, userPrompt, tools, maxTokens, signal, streamFn, env, } = args;
    const text = userPrompt.trim();
    if (!text)
        return;
    const prompts = [
        {
            role: "user",
            content: [{ type: "text", text }],
            timestamp: Date.now(),
        },
    ];
    // pi-agent-core 0.87 dropped `context.systemPrompt`; the system prompt is now
    // the leading system message of the transcript.
    const context = {
        messages: [{ role: "system", content: systemPrompt, timestamp: Date.now() }],
        tools,
    };
    const reasoning = model.reasoning;
    const config = {
        model,
        apiKey,
        headers,
        maxTokens: maxTokens ?? 4096,
        convertToLlm: (msgs) => msgs,
        toolExecution: "sequential",
        ...(reasoning ? { reasoning: "high" } : {}),
        // Provider-scoped env from auth resolution (issue #222). pi-agent-core
        // spreads the config into the stream options, where pi-ai >= 0.85 honors
        // it; the conditional spread keeps this compiling on pi < 0.85.
        ...(env ? { env } : {}),
    };
    // pi >= 0.85 requires streamFn explicitly (its internal fallback throws
    // unless the host configured a default), so we always pass one: the
    // provider-specific function when available, else pi-ai's default.
    const activeStreamFn = streamFn ?? (await resolveDefaultStreamFn());
    // Drive the loop directly instead of agentLoop(): agentLoop() wraps the
    // loop in a detached promise (`void runAgentLoop(...).then(...)` with no
    // .catch), so a rejection from the stream path — e.g. "No API provider
    // registered for api: X" for a model from an extension-registered provider
    // — escaped as an uncaughtException and killed the whole pi process while
    // this function's stream drain hung forever (issue #222). runAgentLoop is
    // the same loop with the rejection propagating to THIS promise.
    //
    // omp (compiled binary) rewrites @earendil-works/* specifiers at load time
    // to its bundled @oh-my-pi/* copies (omp-legacy-pi-bundled:), and the
    // bundled pi-agent-core dropped runAgentLoop in favor of the
    // EventStream-returning agentLoop. runAgentLoop is therefore loaded via a
    // variable specifier (opaque to omp's static source rewrite) and feature-
    // detected: where it exists (regular pi) we keep the direct loop; where it
    // does not (omp bundled) agentLoop drives the same loop and its returned
    // EventStream's async iterator throws on stream.fail(), so for-await
    // propagates rejections to THIS promise just like runAgentLoop.
    const agentCoreSpecifier = "@earendil-works/pi-agent-core";
    const agentCore = (await import(agentCoreSpecifier));
    if (agentCore.runAgentLoop) {
        await agentCore.runAgentLoop(prompts, context, config, async () => { }, signal, activeStreamFn);
    }
    else if (agentCore.agentLoop) {
        const stream = agentCore.agentLoop(prompts, context, config, signal, activeStreamFn);
        // The bundled agentLoop is the detached `void runAgentLoop(...).then(...)`
        // pattern with no `.catch` (verified across pi-agent-core 0.73.1-0.78.0):
        // a rejected loop never ends the stream, so `for await` would hang
        // forever. Cap it so a stall surfaces as a catchable error (degraded to a
        // warning toast by BackgroundRuntime) instead of a hang.
        // ponytail: hard cap — raise if legitimate runs exceed it.
        const drain = (async () => {
            for await (const _event of stream) {
                // Discard events; results are collected caller-side via tool side effects.
            }
        })();
        await raceWithTimeout(drain, 120_000, "omp agentLoop stream stalled: no end/fail event within 120s");
    }
    else {
        throw new Error("Neither runAgentLoop nor agentLoop is exported by pi-agent-core");
    }
}
