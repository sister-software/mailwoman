/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Where the Vale prose linter is, for every caller that spawns it. `@vvago/vale` publishes a `bin` entry that has
 *   been a native binary in one release and a Node launcher (`bin/vale.cjs`) around a `native/` binary in the next, so
 *   the manifest's own `bin` field is the contract and is read at call time; a launcher runs under this Node. Resolving
 *   from the caller's own location keeps the lookup inside the package that declares the dependency.
 */

import { dirname, resolvePath } from "path-ts"

import { createRequire } from "#module/resolvers"

export interface ValeCommand {
	/**
	 * The file to spawn: the native binary, or this Node when the package publishes a script launcher.
	 */
	file: string
	/**
	 * Arguments that precede the caller's: the launcher's path when `file` is Node, nothing otherwise.
	 */
	argv: string[]
}

interface ValeManifest {
	bin?: string | Record<string, string>
}

/**
 * @param fromURL The caller's `import.meta.url`, so `@vvago/vale` resolves from the package that depends on it.
 */
export function valeCommand(fromURL: string): ValeCommand {
	const require = createRequire(fromURL)
	const manifestPath = require.resolve("@vvago/vale/package.json")
	const manifest = require(manifestPath) as ValeManifest
	const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.vale

	if (!bin) throw new Error(`${manifestPath} publishes no vale bin`)

	const binPath = resolvePath(dirname(manifestPath), bin)

	return /\.[cm]?js$/u.test(bin) ? { file: process.execPath, argv: [binPath] } : { file: binPath, argv: [] }
}
