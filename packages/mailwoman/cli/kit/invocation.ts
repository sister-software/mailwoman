/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The command a reader types to run this CLI, for the follow-up commands a command prints.
 *
 *   A package runner that started this process decides first, because `npx` and `yarn` put the bin they ran on
 *   `PATH` for the child. Otherwise a `mailwoman` executable on `PATH` is typed as `mailwoman`. Otherwise the
 *   lockfile in the nearest project directory picks the runner. A runner's own prefix (`yarn mailwoman`,
 *   `pnpm exec mailwoman`, `bunx mailwoman`) is used only when that project installs the package. `npx mailwoman`
 *   covers every other case, and fetches the package on first use.
 */

import { liveEnv } from "@mailwoman/core/env"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { platformName } from "@mailwoman/core/utils/system"
import { dirname, resolvePath } from "path-ts"
import { z } from "zod"

const InvocationEnvSchema = z.object({
	PATH: z.string().optional(),
	/**
	 * Set by npm, Yarn, pnpm and Bun for the processes they start, such as `yarn/4.5.0 npm/? node/v22.0.0`.
	 */
	npm_config_user_agent: z.string().optional(),
})

const $invocation = liveEnv(InvocationEnvSchema)

/**
 * Each spelling of the `mailwoman` bin file that a package manager installs.
 * Windows package managers add `.cmd` and `.exe` shims.
 */
const BIN_NAMES = ["mailwoman", "mailwoman.cmd", "mailwoman.exe"] as const

/**
 * A package runner, the lockfile that identifies a project as using it,
 * and the prefix that runs a locally installed bin through it.
 */
const RUNNERS = [
	{ agent: "yarn", lockfile: "yarn.lock", prefix: "yarn mailwoman" },
	{ agent: "pnpm", lockfile: "pnpm-lock.yaml", prefix: "pnpm exec mailwoman" },
	{ agent: "bun", lockfile: "bun.lock", prefix: "bunx mailwoman" },
	{ agent: "npm", lockfile: "package-lock.json", prefix: "npx mailwoman" },
] as const

const FALLBACK = "npx mailwoman"

/**
 * The character that separates `PATH` entries on this platform.
 */
export function pathListDelimiter(): string {
	return platformName() === "win32" ? ";" : ":"
}

/**
 * Whether `directory` holds a `mailwoman` executable.
 *
 * A `PATH` entry can name a file or a directory this user cannot list (`ENOTDIR`, `EACCES`).
 * A shell skips such an entry when it looks up a command, so it holds no
 * executable the reader could type here either.
 */
async function hasBin(directory: string): Promise<boolean> {
	for (const name of BIN_NAMES) {
		const found = await pathExists(resolvePath(directory, name)).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOTDIR" || error.code === "EACCES") return false

			throw error
		})

		if (found) return true
	}

	return false
}

/**
 * The nearest directory at or above `start` holding a `package.json`, or `null` at the filesystem root.
 */
async function nearestProject(start: string): Promise<string | null> {
	let directory: string = resolvePath(start)

	for (;;) {
		if (await pathExists(resolvePath(directory, "package.json"))) return directory

		const parent: string = dirname(directory)

		if (parent === directory) return null

		directory = parent
	}
}

/**
 * Work out the command prefix that runs this CLI from `cwd`, from `PATH`, the package
 * runner's user agent and the nearest project's lockfile and `node_modules/.bin`.
 */
export async function resolveMailwomanCommand(cwd: string): Promise<string> {
	const agent = $invocation.npm_config_user_agent?.split("/", 1)[0]
	const project = await nearestProject(cwd)
	const installed = project != null && (await hasBin(resolvePath(project, "node_modules", ".bin")))
	const byAgent = RUNNERS.find((runner) => runner.agent === agent)

	if (byAgent) return installed ? byAgent.prefix : FALLBACK

	for (const directory of ($invocation.PATH ?? "").split(pathListDelimiter())) {
		if (directory && (await hasBin(directory))) return "mailwoman"
	}

	if (!project || !installed) return FALLBACK

	for (const runner of RUNNERS) {
		if (await pathExists(resolvePath(project, runner.lockfile))) return runner.prefix
	}

	return FALLBACK
}

let resolved: Promise<string> | null = null

/**
 * The prefix {@linkcode resolveMailwomanCommand} answers for the process's
 * working directory, worked out once.
 */
export function mailwomanCommandPrefix(): Promise<string> {
	// oxlint-disable-next-line sister-software/no-process-globals -- the directory the reader typed the command in
	resolved ??= resolveMailwomanCommand(process.cwd())

	return resolved
}

/**
 * A follow-up command as the reader would type it, such as `npx mailwoman data status`.
 *
 * @param rest The arguments after the program name.
 */
export async function mailwomanCommand(rest: string): Promise<string> {
	return `${await mailwomanCommandPrefix()} ${rest}`
}
