/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

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
