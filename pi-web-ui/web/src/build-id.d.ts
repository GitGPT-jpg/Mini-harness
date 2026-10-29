/** Build id baked in by Vite (web/vite.config.ts `define`). Compared against the
 *  server's on-disk build on every WS (re)connect — mismatch self-reloads the
 *  page once per build id (loop-guarded via sessionStorage). */
declare const __BUILD_ID__: string;
