import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"

/**
 * Resolve a path relative to the directory Claude Code is running in (cwd).
 *
 * @param paths Path segments to join onto cwd.
 */
export function cwdPathBuilder(...paths: string[]): string {
	return resolve(process.cwd(), ...paths)
}

/**
 * Find all `.env` files from the current working directory up to the home directory or repo root.
 *
 * @returns An array of `.env` file paths, ordered from shallowest to deepest (cwd last).
 */
export function cwdEnvPaths(): string[] {
	const found: string[] = []
	let dir = process.cwd()
	const home = homedir()

	while (true) {
		const candidate = resolve(dir, ".env")

		if (existsSync(candidate)) {
			found.push(candidate)
		}

		const parent = dirname(dir)
		const atRepoRoot = existsSync(resolve(dir, ".git"))

		if (atRepoRoot || dir === home || parent === dir) break
		dir = parent
	}

	// `found` is deepest-first (cwd first); reverse so cwd is applied last and wins.
	return found.reverse()
}
