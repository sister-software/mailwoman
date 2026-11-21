// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The servers `mwops probe` can start, read from the checkout rather than typed as a list.
 *
 * A workspace is a probe target when its `cli/main.ts` hands a `serve` command to
 * `runDropInCLI`, the drop-in runner in `mailwoman/cli/kit/dropin`.
 * Such a server runs from this checkout's source through Node's type stripping.
 *
 * The native `/v1` API of `@mailwoman/api` is served by the `mailwoman` CLI's `serve` command,
 * so it is the target `api` when `packages/mailwoman/cli/commands/serve.tsx` imports `@mailwoman/api`.
 * That CLI runs only from its compiled `out/`, because Node's type stripping reads no `.tsx`.
 *
 * Every target accepts `--host` and `--port`, and port 0 asks the system for an unused port.
 * Each prints a line that contains `listening on http://<host>:<bound port>` once it is bound.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { readWorkspaceDirectories } from "@mailwoman/core/workspaces"
import { basename, resolvePath } from "path-ts"

/**
 * One server `mwops probe` can start.
 */
export interface ProbeTarget {
	/**
	 * The name `mwops probe` takes: the workspace directory's name, or `api`.
	 */
	workspace: string
	/**
	 * The workspace directory, relative to the checkout.
	 */
	directory: string
	/**
	 * The script Node runs, relative to the checkout.
	 */
	entry: string
	/**
	 * The arguments before the host, the port and the caller's server flags.
	 */
	args: readonly string[]
	/**
	 * Whether the entry is source or the compiled `out/` tree.
	 */
	runs: "source" | "compiled"
}

/**
 * The text a drop-in CLI holds when it passes a `serve` command to the drop-in runner.
 */
const DROP_IN_RUNNER = "runDropInCLI({"

const SERVE_KEY = /^\s*serve[,:]/mu

/**
 * Whether a `cli/main.ts` text passes a `serve` command to `runDropInCLI`.
 */
export function servesThroughDropIn(text: string): boolean {
	const call = text.indexOf(DROP_IN_RUNNER)

	return call !== -1 && SERVE_KEY.test(text.slice(call + DROP_IN_RUNNER.length))
}

const API_SERVE_COMMAND = "packages/mailwoman/cli/commands/serve.tsx"

const API_IMPORT = 'import("@mailwoman/api")'

/**
 * Read every probe target in the checkout at `repoRoot`, sorted by name.
 */
export async function readProbeTargets(repoRoot: string): Promise<ProbeTarget[]> {
	const targets: ProbeTarget[] = []

	for (const directory of await readWorkspaceDirectories(repoRoot)) {
		const entry = `${directory}/cli/main.ts`
		const path = resolvePath(repoRoot, entry)

		if (!(await pathExists(path)) || !servesThroughDropIn(await readLocalTextFile(path))) continue

		const workspace = basename(directory)

		targets.push({ workspace, directory, entry, args: ["serve"], runs: "source" })
	}

	const apiCommand = resolvePath(repoRoot, API_SERVE_COMMAND)

	if ((await pathExists(apiCommand)) && (await readLocalTextFile(apiCommand)).includes(API_IMPORT)) {
		targets.push({
			workspace: "api",
			directory: "packages/mailwoman",
			entry: "packages/mailwoman/out/cli/main.js",
			// The cluster runs one worker, and the server's memory is then one process beside the primary.
			args: ["serve", "--cpus", "1"],
			runs: "compiled",
		})
	}

	return targets.toSorted((a, b) => a.workspace.localeCompare(b.workspace))
}
