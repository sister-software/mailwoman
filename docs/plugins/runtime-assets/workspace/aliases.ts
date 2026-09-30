/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { tryResolvePackageSpecifier } from "@mailwoman/core/module/resolve-from"

import { resolvePackageEntry, resolvePackageFile } from "./resolution.ts"

const ROOT_PACKAGES = [
	"@mailwoman/resolver-wof-wasm",
	"@mailwoman/core",
	"@mailwoman/query-shape",
	"@mailwoman/kind-classifier",
	"@mailwoman/react",
] as const

/**
 * Package subpaths aliased to their source file, `lib/<subpath>.ts`.
 */
const FILE_SUBPATHS: ReadonlyArray<readonly [packageName: string, subpath: string]> = [
	["@mailwoman/react", "map"],
	["@mailwoman/cartographer", "base"],
	["@mailwoman/cartographer", "styles"],
	["@mailwoman/cartographer", "coverage"],
	...["decoder", "tokenization", "types", "resources", "pipeline", "objects"].map(
		(subpath) => ["@mailwoman/core", subpath] as const
	),
	["@mailwoman/resolver", "resolve"],
	["@mailwoman/resolver", "span-rescore"],
	// These are the browser-safe leaves: each keeps a per-file subpath so the site bundle
	// never pulls the Node-only siblings that share its directory.
	...["fst/deserialize-web", "fst/matcher", "fst/types", "street/normalize", "fst/autocomplete", "fts"].map(
		(subpath) => ["@mailwoman/resolver-wof-sqlite", subpath] as const
	),
	["@mailwoman/sqlite", "dialect"],
	["@mailwoman/neural", "web/loader"],
]

const CODEX_SUBPATHS = [null, "country", "de", "es", "fr", "gb", "it", "nz", "us"] as const

/**
 * Build the source-first webpack alias map.
 *
 * Exact root aliases use webpack's `$` suffix.
 * Package subpaths then continue through their own explicit aliases or exports maps.
 */
export async function buildWorkspaceAliases(): Promise<Record<string, string>> {
	const aliases: Record<string, string> = {}

	const setAlias = (specifier: string, target: string | null): void => {
		if (target) {
			aliases[specifier] = target
		}
	}

	/**
	 * Alias a specifier requested by this file, throwing when its hand-maintained target no longer resolves.
	 */
	const requireAlias = (specifier: string, target: string | null): void => {
		if (!target) {
			throw new Error(
				`runtime-assets: "${specifier}" is listed in workspace-aliases.ts but resolves to nothing. ` +
					`Remove it, or point it at the module that replaced it.`
			)
		}

		aliases[specifier] = target
	}

	for (const packageName of ROOT_PACKAGES) {
		setAlias(`${packageName}$`, await resolvePackageEntry(packageName))
	}

	// File aliases precede directory aliases, because webpack matches aliases in insertion
	// order and the narrow `core/resources/whosonfirst/specificity` leaf must win
	// before the broader `core/resources` barrel.
	setAlias(
		"@mailwoman/core/resources/whosonfirst/specificity",
		await resolvePackageFile("@mailwoman/core", "resources/whosonfirst/placetypes/specificity")
	)

	for (const [packageName, subpath] of FILE_SUBPATHS) {
		requireAlias(`${packageName}/${subpath}`, await resolvePackageFile(packageName, subpath))
	}

	setAlias("@mailwoman/core/errors", await resolvePackageFile("@mailwoman/core", "errors/schema"))

	// The resolver root deliberately bypasses its barrel, since the browser graph
	// needs only the core resolver interfaces while runtime resolution enters through
	// the explicit `@mailwoman/resolver/resolve` alias above.
	setAlias("@mailwoman/resolver$", await resolvePackageFile("@mailwoman/core", "resolver/types"))

	for (const subpath of CODEX_SUBPATHS) {
		const specifier = subpath ? `@mailwoman/codex/${subpath}` : "@mailwoman/codex"
		const target = tryResolvePackageSpecifier(import.meta.url, "@mailwoman/codex", subpath)

		if (!target) {
			console.warn(`[runtime-assets] ${specifier} not resolvable — alias skipped`)

			continue
		}

		if (!target.endsWith(".ts")) {
			console.warn(`[runtime-assets] ${specifier} resolved to compiled output (${target}) — dev exports drift?`)
		}

		aliases[`${specifier}$`] = target
	}

	return aliases
}
