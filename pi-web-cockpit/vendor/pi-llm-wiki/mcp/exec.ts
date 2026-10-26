import { execFile, spawn } from "node:child_process";
import type { ExecApi } from "../extensions/llm-wiki/lib/utils.js";

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export function createExecApi(): ExecApi {
  return {
    exec(command, args, options = {}) {
      return new Promise((resolve) => {
        let killed = false;
        let settled = false;
        let stdoutLimited = false;
        let stderrLimited = false;
        let forceTimer: NodeJS.Timeout | undefined;
        let stdout = "";
        let stderr = "";
        const child = spawn(command, args, {
          cwd: options.cwd,
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
        });

        const sendSignal = (signal: "SIGTERM" | "SIGKILL") => {
          if (process.platform === "win32" && child.pid) {
            execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {});
            return;
          }
          if (child.pid) {
            try {
              process.kill(-child.pid, signal);
              return;
            } catch {
              // Fall back to the direct child when process-group signalling fails.
            }
          }
          child.kill(signal);
        };
        const forceStop = () => {
          if (forceTimer) clearTimeout(forceTimer);
          forceTimer = undefined;
          sendSignal("SIGKILL");
        };
        const stop = () => {
          if (killed) return;
          killed = true;
          sendSignal("SIGTERM");
          if (process.platform !== "win32") forceTimer = setTimeout(forceStop, 100);
        };
        const appendOutput = (
          current: string,
          chunk: string,
          limited: boolean,
        ): [string, boolean] => {
          if (limited) return [current, true];
          const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(current);
          if (remaining <= 0) {
            stop();
            return [current, true];
          }
          const bytes = Buffer.from(chunk);
          if (bytes.byteLength <= remaining) return [current + chunk, false];
          stop();
          let prefix = "";
          let prefixBytes = 0;
          for (const char of chunk) {
            const charBytes = Buffer.byteLength(char);
            if (prefixBytes + charBytes > remaining) break;
            prefix += char;
            prefixBytes += charBytes;
          }
          return [current + prefix, true];
        };

        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          [stdout, stdoutLimited] = appendOutput(stdout, chunk, stdoutLimited);
        });
        child.stderr?.on("data", (chunk: string) => {
          [stderr, stderrLimited] = appendOutput(stderr, chunk, stderrLimited);
        });

        const timer = options.timeout ? setTimeout(stop, options.timeout) : undefined;
        const abort = () => stop();
        options.signal?.addEventListener("abort", abort, { once: true });

        const finish = (code: number) => {
          if (settled) return;
          if (forceTimer) {
            clearTimeout(forceTimer);
            forceTimer = undefined;
            if (child.pid) {
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch {
                // The process group already exited; do not signal the closed child's stale PID.
              }
            }
          }
          cleanup();
          resolve({
            stdout,
            stderr,
            code: stdoutLimited || stderrLimited ? 1 : killed && code === 0 ? 1 : code,
            killed,
          });
        };
        child.once("error", () => finish(1));
        child.once("close", (code) => finish(typeof code === "number" ? code : 1));

        function cleanup() {
          settled = true;
          if (timer) clearTimeout(timer);
          if (forceTimer) clearTimeout(forceTimer);
          options.signal?.removeEventListener("abort", abort);
        }

        if (options.signal?.aborted) stop();
      });
    },
  };
}
