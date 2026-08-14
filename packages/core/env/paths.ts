/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname } from "node:path"

import envPaths from "env-paths"
import { resolvePath } from "path-ts"

const platformPaths = envPaths("mailwoman", { suffix: "" })

/**
 * Platform-native filesystem defaults used by the typed environment schema.
 */
export const defaultMailwomanPaths = {
	data: resolvePath(platformPaths.data),
	config: resolvePath(platformPaths.config),
	cache: resolvePath(platformPaths.cache),
	log: resolvePath(platformPaths.log),
	temp: resolvePath(platformPaths.temp),
} as const

/**
 * Resolve a path relative to the current working directory.
 */
export function cwdPathBuilder(...paths: string[]): string {
	return resolvePath(process.cwd(), ...paths)
}

/**
 * Find `.env` files from the current working directory up to the home directory or repository root.
 */
export function cwdEnvPaths(): string[] {
	const found: string[] = []
	let directory = process.cwd()
	const home = homedir()

	while (true) {
		const candidate = resolvePath(directory, ".env")

		if (existsSync(candidate)) {
			found.push(candidate)
		}

		const parent = dirname(directory)
		const atRepoRoot = existsSync(resolvePath(directory, ".git"))

		if (atRepoRoot || directory === home || parent === directory) break
		directory = parent
	}

	return found.toReversed()
}
