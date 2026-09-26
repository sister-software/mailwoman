/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Where the Vale prose linter is, for every caller that spawns it.
 *
 *   `@vvago/vale` has published both a native binary and a Node launcher, so the manifest's own `bin` field is the interface and is read at call time.
 */

import { PathBuilder } from "path-ts"

import { pathExists } from "#fs/readers"
import { readPackageJSON, resolvePackageJSON, resolvePackageSpecifier } from "#module/resolve-from"

export interface ValeCommand {
	/**
	 * The file to spawn: the native binary, or this Node when the package publishes a script launcher.
	 */
	file: string
	/**
	 * Arguments that precede the caller's: the launcher's path when `file` is Node,
	 * and no arguments otherwise.
	 */
	argv: string[]
}

interface ValeManifest {
	bin: {
		vale: string
	}
}

/**
 * @param base The caller's `import.meta.url`, so `@vvago/vale` resolves from the package that declares it.
 */
export async function valeCommand(base: string): Promise<ValeCommand> {
	const manifestPath = resolvePackageJSON(base, "@vvago/vale")
	const manifest = await readPackageJSON<ValeManifest>(manifestPath)

	const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin.vale

	if (!bin) {
		throw new TypeError(`@vvago/vale's package.json has no bin.vale entry`)
	}

	const binPath = resolvePackageSpecifier(base, "@vvago/vale", bin)

	if (!/\.[cm]?js$/u.test(bin)) return { file: binPath, argv: [] }

	await assertNativeBinaryPresent(manifestPath)

	return { file: process.execPath, argv: [binPath] }
}

/**
 * The launcher prints its own missing-binary message on stderr with exit code 1,
 * the same exit code a prose finding produces, so a caller reading only the exit
 * status would report a failed prose check for a failed download.
 */
async function assertNativeBinaryPresent(manifestPath: string): Promise<void> {
	// Built from the manifest's own directory: the binary is a postinstall artifact
	// with no `exports` entry, so a subpath resolution throws `MODULE_NOT_FOUND`
	// and cannot distinguish a missing download from an undeclared path.
	const nativePath = PathBuilder.from(manifestPath).dirname()(
		"native",
		process.platform === "win32" ? "vale.exe" : "vale"
	)

	if (await pathExists(nativePath)) return

	throw new Error(
		`@vvago/vale ships a launcher but ${nativePath} does not exist, so no prose check ran. The package's ` +
			"postinstall downloads that binary from the anonymous GitHub release API, which answers 403 once the " +
			"address has spent its quota, and `.yarnrc.yml` filters that failure to a warning. Re-run the postinstall " +
			"(`yarn rebuild @vvago/vale`) rather than reading this as a prose result."
	)
}
