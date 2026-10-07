/**
 * Resolves a package's executable from its manifest and the caller's dependency graph.
 */

import { dirname, resolvePath } from "path-ts"

import { readFileHead } from "#fs/readers"
import { readPackageJSON, resolvePackageJSON } from "#module/resolve-from"

/**
 * A package command identifies the executable and arguments that precede the caller's arguments.
 */
export interface PackageCommand {
	file: string
	argv: string[]
}

/**
 * Resolves an executable through a package's `bin` field.
 *
 * The base URL identifies the caller whose dependencies should be searched.
 * Node launchers run through the current Node executable, including extensionless files with a Node shebang.
 *
 * A bin entry need not be an exported module subpath.
 * A missing package, bin entry, or executable file raises an error before a process starts.
 */
export async function resolvePackageCommand(
	base: string,
	packageName: string,
	binName: string
): Promise<PackageCommand> {
	const manifestPath = resolvePackageJSON(base, packageName)
	const manifest = await readPackageJSON(manifestPath)
	const defaultBinName = manifest.name?.split("/").at(-1)

	const bin =
		typeof manifest.bin === "string" ? (binName === defaultBinName ? manifest.bin : undefined) : manifest.bin?.[binName]

	if (!bin) throw new TypeError(`${packageName}'s package.json has no bin entry for ${binName}`)

	const binPath = resolvePath(dirname(manifestPath), bin)
	const head = await readFileHead(binPath, 256)
	const runsWithNode = /\.[cm]?js$/u.test(bin) || /^#!\s*(?:\S*\/)?(?:node|env\s+(?:-S\s+)?node)(?:\s|$)/u.test(head)

	return runsWithNode ? { file: process.execPath, argv: [binPath] } : { file: binPath, argv: [] }
}
