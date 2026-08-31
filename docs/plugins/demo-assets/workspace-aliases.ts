/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Source aliases used by the interactive docs demo.
 */

import {
	resolvePackageDirectoryEntry,
	resolvePackageEntry,
	resolvePackageFile,
	resolvePackageSpecifier,
} from "./workspace-resolution.ts"

const ROOT_PACKAGES = [
	"@mailwoman/resolver-wof-wasm",
	"@mailwoman/core",
	"@mailwoman/query-shape",
	"@mailwoman/kind-classifier",
	"@mailwoman/react",
] as const

const DIRECTORY_SUBPATHS: ReadonlyArray<readonly [packageName: string, subpath: string]> = [
	["@mailwoman/react", "map"],
	["@mailwoman/cartographer", "base"],
	["@mailwoman/cartographer", "styles"],
	["@mailwoman/cartographer", "coverage"],
	...["decoder", "tokenization", "types", "resources", "pipeline"].map(
		(subpath) => ["@mailwoman/core", subpath] as const
	),
]

const FILE_SUBPATHS: ReadonlyArray<readonly [packageName: string, subpath: string]> = [
	...["fst-deserialize-web", "fst-matcher", "fst-types", "fts", "street-normalize", "geo", "fst-autocomplete"].map(
		(subpath) => ["@mailwoman/resolver-wof-sqlite", subpath] as const
	),
	["@mailwoman/neural", "web-loader"],
	["@mailwoman/core", "objects"],
	["@mailwoman/core", "kysley/dialect"],
	["@mailwoman/resolver", "span-rescore"],
	["@mailwoman/resolver", "resolve"],
]

const CODEX_SUBPATHS = [null, "country", "de", "es", "fr", "gb", "it", "nz", "us"] as const

/**
 * Build the source-first webpack alias map. Exact root aliases use webpack's `$` suffix so package subpaths continue
 * through their own explicit aliases or exports maps.
 */
export async function buildWorkspaceAliases(): Promise<Record<string, string>> {
	const aliases: Record<string, string> = {}

	const setAlias = (specifier: string, target: string | null): void => {
		if (target) {
			aliases[specifier] = target
		}
	}

	for (const packageName of ROOT_PACKAGES) {
		setAlias(`${packageName}$`, await resolvePackageEntry(packageName))
	}

	// File aliases precede directory aliases: webpack matches aliases in insertion order, and the narrow
	// `core/resources/whosonfirst/specificity` leaf must win before the broader `core/resources` barrel.
	setAlias(
		"@mailwoman/core/resources/whosonfirst/specificity",
		await resolvePackageFile("@mailwoman/core", "resources/whosonfirst/placetypes/specificity")
	)

	for (const [packageName, subpath] of FILE_SUBPATHS) {
		setAlias(`${packageName}/${subpath}`, await resolvePackageFile(packageName, subpath))
	}

	setAlias("@mailwoman/core/errors", await resolvePackageFile("@mailwoman/core", "errors/schema"))

	for (const [packageName, subpath] of DIRECTORY_SUBPATHS) {
		setAlias(`${packageName}/${subpath}`, await resolvePackageDirectoryEntry(packageName, subpath))
	}

	// The resolver root deliberately bypasses its barrel: the browser graph only needs the core resolver contracts,
	// while runtime resolution enters through the explicit `@mailwoman/resolver/resolve` alias above.
	setAlias("@mailwoman/resolver$", await resolvePackageFile("@mailwoman/core", "resolver/types"))

	for (const subpath of CODEX_SUBPATHS) {
		const specifier = subpath ? `@mailwoman/codex/${subpath}` : "@mailwoman/codex"
		const target = resolvePackageSpecifier(specifier)

		if (!target) {
			console.warn(`[demo-assets] ${specifier} not resolvable — alias skipped`)

			continue
		}

		if (!target.endsWith(".ts")) {
			console.warn(`[demo-assets] ${specifier} resolved to compiled output (${target}) — dev exports drift?`)
		}

		aliases[subpath ? specifier : "@mailwoman/codex$"] = target
	}

	return aliases
}
