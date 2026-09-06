/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Source aliases used by the interactive docs demo.
 */

import { tryResolvePackageSpecifier } from "@mailwoman/core/module/resolve-from"

import { resolvePackageDirectoryEntry, resolvePackageEntry, resolvePackageFile } from "./workspace-resolution.ts"

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
	// Moved here from FILE_SUBPATHS when the prefix fold made `resolve` a directory: `resolve.ts` +
	// `resolve-passes.ts` became `resolve/{index,passes}.ts`. Same subpath, different resolver — and
	// `requireAlias` refused the docs build until it was listed on the right side, which is the point.
	["@mailwoman/resolver", "resolve"],
]

const FILE_SUBPATHS: ReadonlyArray<readonly [packageName: string, subpath: string]> = [
	// `geo` was here until 2026-09-01 and had been dead for some time: `@mailwoman/resolver-wof-sqlite` dropped
	// the `./geo` subpath when its geometry helpers moved to `@mailwoman/spatial`, and `lib/geo.ts` went with
	// them. Nothing noticed, because a missing target only warned. {@link requireAlias} now refuses instead —
	// a HAND-LISTED entry naming a module that does not exist is a bug by definition, and this list is the
	// mirror that goes stale every time a subpath moves.
	// These are the BROWSER-SAFE LEAVES: each keeps a per-file subpath so the demo bundle never pulls
	// the Node-only siblings that share its directory entry.
	...["fst/deserialize-web", "fst/matcher", "fst/types", "street/normalize", "fst/autocomplete", "fts/index"].map(
		(subpath) => ["@mailwoman/resolver-wof-sqlite", subpath] as const
	),
	["@mailwoman/neural", "web-loader"],
	["@mailwoman/core", "objects"],
	// Was `["@mailwoman/core", "kysley/dialect"]` — the dialect lives in `@mailwoman/sqlite` now, and `core`
	// exports nothing kysley-shaped at all. Second dead entry this list was carrying; `requireAlias` found it
	// the moment it was armed.
	["@mailwoman/sqlite", "dialect"],
	["@mailwoman/resolver", "span-rescore"],
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

	/**
	 * Alias a specifier this file NAMED, refusing a target that does not resolve.
	 *
	 * The lists below are a hand-maintained mirror of several packages' `exports` maps, so they go stale every time a
	 * subpath moves — and the failure was silent: `resolvePackageFile` answers `null` and the alias was simply skipped,
	 * leaving the demo to resolve through the real exports map and nobody any the wiser. That is how
	 * `@mailwoman/resolver-wof-sqlite/geo` stayed on the list after the module was deleted. A named entry that cannot
	 * resolve is a defect in THIS file, so it throws.
	 */
	const requireAlias = (specifier: string, target: string | null): void => {
		if (!target) {
			throw new Error(
				`demo-assets: "${specifier}" is listed in workspace-aliases.ts but resolves to nothing. ` +
					`Remove it, or point it at the module that replaced it.`
			)
		}

		aliases[specifier] = target
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
		requireAlias(`${packageName}/${subpath}`, await resolvePackageFile(packageName, subpath))
	}

	setAlias("@mailwoman/core/errors", await resolvePackageFile("@mailwoman/core", "errors/schema"))

	for (const [packageName, subpath] of DIRECTORY_SUBPATHS) {
		requireAlias(`${packageName}/${subpath}`, await resolvePackageDirectoryEntry(packageName, subpath))
	}

	// The resolver root deliberately bypasses its barrel: the browser graph only needs the core resolver contracts,
	// while runtime resolution enters through the explicit `@mailwoman/resolver/resolve` alias above.
	setAlias("@mailwoman/resolver$", await resolvePackageFile("@mailwoman/core", "resolver/types"))

	for (const subpath of CODEX_SUBPATHS) {
		const specifier = subpath ? `@mailwoman/codex/${subpath}` : "@mailwoman/codex"
		const target = tryResolvePackageSpecifier(import.meta.url, "@mailwoman/codex", subpath)

		if (!target) {
			console.warn(`[demo-assets] ${specifier} not resolvable — alias skipped`)

			continue
		}

		if (!target.endsWith(".ts")) {
			console.warn(`[demo-assets] ${specifier} resolved to compiled output (${target}) — dev exports drift?`)
		}

		aliases[`${specifier}$`] = target
	}

	return aliases
}
