/**
 * Minimal git-repo detection helper, split out of the (deleted) source-control
 * panel so the workspace-snapshot restore path can depend on it directly.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isRemoteWorkspaceUri } from "./remote-ssh-service.js";

const exec = promisify(execFile);

/** Absolute path of the repo's git dir (handles worktrees/submodules), or
 *  null when cwd isn't inside a repository. */
export async function gitDirOf(cwd: string): Promise<string | null> {
	if (isRemoteWorkspaceUri(cwd)) return null;
	try {
		const { stdout } = await exec("git", ["rev-parse", "--absolute-git-dir"], {
			cwd,
			timeout: 5_000,
			windowsHide: true,
		});
		return stdout.trim() || null;
	} catch {
		return null;
	}
}
