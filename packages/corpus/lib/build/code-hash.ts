/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The code hash of a derivation: a digest over the code a source's producer reaches.
 *
 *   A derivation hash over every module of the package gives every stored file a new hash on any edit. This module
 *   narrows it to the modules a root reaches through its runtime imports, across every `@mailwoman/*` workspace's
 *   source. An edit to one adapter then changes only that adapter's files, and an edit to a helper, in this package or
 *   another workspace, changes the hash of every root that reaches it. The builder version moves only at a release,
 *   so a local build between releases relies on this hash to see a workspace edit.
 *
 *   The walk stops at third-party packages. Each one reached enters the hash as its name and the version
 *   `yarn.lock` resolves it to.
 *
 *   dependency-cruiser resolves the graph with the resolve options of the repository's
 *   `dependency-cruiser.config.mjs`, read from the checkout. Under the `node` condition a workspace import resolves
 *   to `lib/*.ts`, so the graph needs no compiled `out/`. A type-only edge is left out because it emits no runtime
 *   import.
 *
 *   The hash reads the checkout: its config, its `yarn.lock` and its workspace sources. `dependency-cruiser` and
 *   `yaml` are development dependencies of this package, imported only here, so a published install does not carry
 *   them. A corpus build runs from the checkout.
 */

import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { sha256File, sha256Hex } from "@mailwoman/core/hash"
import { pathToFileURL } from "@mailwoman/core/module/file-url"
import { repoRootPath } from "@mailwoman/core/paths"
import { dirname, relative, resolvePath } from "path-ts"

import type { CorpusAdapter } from "#types"

/**
 * The runtime import graph of the reached workspace modules, keyed by repository-relative path.
 */
export interface ModuleGraph {
	/**
	 * Runtime edges from each workspace module to the workspace modules it imports.
	 */
	readonly edges: ReadonlyMap<string, readonly string[]>
	/**
	 * The third-party package directories each workspace module imports at runtime, repository-relative.
	 */
	readonly packages: ReadonlyMap<string, readonly string[]>
}

/**
 * The repository root this module reads, overridable for a fixture.
 */
export function defaultRepositoryRoot(): string {
	return repoRootPath()
}

/**
 * The resolve options the repository's dependency-cruiser config declares.
 */
async function repositoryResolveOptions(repositoryRoot: string): Promise<Record<string, unknown>> {
	const config = (await import(pathToFileURL(resolvePath(repositoryRoot, "dependency-cruiser.config.mjs")).href)) as {
		default: { options?: { enhancedResolveOptions?: Record<string, unknown> } }
	}

	const options = config.default.options?.enhancedResolveOptions

	if (!options) throw new Error(`${repositoryRoot}/dependency-cruiser.config.mjs declares no enhancedResolveOptions`)

	return options
}

/**
 * The directory of the third-party package a resolved file belongs to,
 * through its last `node_modules` segment.
 */
function packageDirectoryOf(resolved: string): string {
	const segments = resolved.split("/")
	const at = segments.lastIndexOf("node_modules")
	const span = segments[at + 1]?.startsWith("@") ? 3 : 2

	return segments.slice(0, at + span).join("/")
}

/**
 * The repository-relative directory of an installed package a bare specifier names,
 * searched from the importing module's directory up to the repository root, or `null`
 * when the specifier is not bare or names no installed package.
 */
async function installedPackageDirectory(
	specifier: string,
	importer: string,
	repositoryRoot: string
): Promise<string | null> {
	if (/^[.#/]/u.test(specifier)) return null

	const parts = specifier.split("/")
	const name = parts[0]!.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!
	let directory = dirname(importer)

	for (;;) {
		const candidate = directory === "." ? `node_modules/${name}` : `${directory}/node_modules/${name}`

		if (await pathExists(resolvePath(repositoryRoot, candidate, "package.json"))) return candidate

		if (directory === ".") return null

		directory = dirname(directory)
	}
}

/**
 * Cruise the graph from `roots`, which are absolute paths or paths relative to `repositoryRoot`.
 *
 * @throws When a root lies outside `packages/` or an import does not resolve, because a hash
 * over a graph with a missing edge would leave an edit to the unresolved module unseen.
 */
export async function cruiseModuleGraph(roots: readonly string[], repositoryRoot: string): Promise<ModuleGraph> {
	const { cruise } = await import("dependency-cruiser")
	const relativeRoots = roots.map((root) => relative(repositoryRoot, resolvePath(repositoryRoot, root)))

	for (const root of relativeRoots) {
		if (!root.startsWith("packages/")) {
			throw new Error(`cruiseModuleGraph: ${root} is not a workspace module under ${repositoryRoot}/packages`)
		}
	}

	const result = await cruise(
		relativeRoots,
		{
			baseDir: repositoryRoot,
			doNotFollow: { path: "node_modules" },
			exclude: { path: "[.]test[.]tsx?$" },
			tsPreCompilationDeps: true,
			enhancedResolveOptions: await repositoryResolveOptions(repositoryRoot),
		},
		{}
	)

	if (typeof result.output === "string") throw new Error("cruiseModuleGraph: dependency-cruiser returned text")

	const edges = new Map<string, string[]>()
	const packages = new Map<string, string[]>()

	for (const module of result.output.modules) {
		if (module.source.includes("node_modules/") || module.coreModule) continue

		const local: string[] = []
		const external = new Set<string>()

		for (const dependency of module.dependencies) {
			if (dependency.coreModule) continue

			// Checked before resolution: a types-only package such as `type-fest` has no runtime file to resolve to.
			if (dependency.dependencyTypes.some((type) => type === "type-only" || type === "pre-compilation-only")) continue

			if (dependency.couldNotResolve) {
				// A package whose `exports` hold only a `types` condition, such as `type-fest`,
				// resolves under no runtime condition.
				// It is still pinned, by its installed directory.
				const installed = await installedPackageDirectory(dependency.module, module.source, repositoryRoot)

				if (!installed) {
					throw new Error(`cruiseModuleGraph: ${module.source} imports ${dependency.module}, which does not resolve`)
				}

				external.add(installed)

				continue
			}

			if (dependency.resolved.includes("node_modules/")) {
				external.add(packageDirectoryOf(dependency.resolved))
			} else {
				local.push(dependency.resolved)
			}
		}

		edges.set(module.source, local)
		packages.set(module.source, [...external])
	}

	return { edges, packages }
}

/**
 * The workspace modules and third-party package directories `roots` reach
 * through runtime edges, each sorted.
 */
export function reachableModules(
	graph: ModuleGraph,
	roots: readonly string[]
): { modules: string[]; packages: string[] } {
	const seen = new Set<string>()
	const packages = new Set<string>()
	const pending = [...roots]

	while (pending.length) {
		const next = pending.pop()!

		if (seen.has(next)) continue

		const edges = graph.edges.get(next)

		if (!edges) throw new Error(`reachableModules: ${next} is absent from the cruised graph`)

		seen.add(next)
		pending.push(...edges)

		for (const directory of graph.packages.get(next) ?? []) {
			packages.add(directory)
		}
	}

	return { modules: [...seen].toSorted(), packages: [...packages].toSorted() }
}

/**
 * The `name@npm:version` resolutions `yarn.lock` records.
 */
async function lockedResolutions(repositoryRoot: string): Promise<Set<string>> {
	const { parse } = await import("yaml")

	const lockfile = parse(await readLocalTextFile(resolvePath(repositoryRoot, "yarn.lock"))) as Record<
		string,
		{ resolution?: string }
	>

	return new Set(
		Object.values(lockfile)
			.map((entry) => entry.resolution)
			.filter((resolution): resolution is string => typeof resolution === "string")
	)
}

/**
 * The `name@npm:version` of each reached third-party package.
 *
 * @throws When the installed version is one `yarn.lock` does not record, since the install
 * then differs from the lockfile a reader would rebuild from.
 */
async function pinPackages(
	directories: readonly string[],
	repositoryRoot: string,
	resolutions: ReadonlySet<string>
): Promise<string[]> {
	const pins: string[] = []

	for (const directory of directories) {
		const { name, version } = await readLocalJSONFile<{ name: string; version: string }>(
			resolvePath(repositoryRoot, directory, "package.json")
		)

		const pin = `${name}@npm:${version}`

		if (!resolutions.has(pin)) {
			throw new Error(`pinPackages: ${directory} holds ${pin}, which yarn.lock does not record. Run yarn install.`)
		}

		pins.push(pin)
	}

	return [...new Set(pins)].toSorted()
}

/**
 * A digest over the reached workspace modules, as `path NUL sha256` lines, and the reached packages' pins.
 */
async function hashReach(
	reach: { modules: string[]; packages: string[] },
	repositoryRoot: string,
	resolutions: ReadonlySet<string>
): Promise<string> {
	const lines: string[] = []

	for (const module of reach.modules) {
		lines.push(`${module}\0${await sha256File(resolvePath(repositoryRoot, module))}`)
	}

	for (const pin of await pinPackages(reach.packages, repositoryRoot, resolutions)) {
		lines.push(`package\0${pin}`)
	}

	return sha256Hex(lines.join("\n"))
}

/**
 * The code hash of each named root set, from one cruise over every root.
 *
 * @param rootSets Each key's roots are repository-relative or absolute module paths.
 */
export async function moduleGraphHashes(
	rootSets: Readonly<Record<string, readonly string[]>>,
	repositoryRoot: string = defaultRepositoryRoot()
): Promise<Map<string, string>> {
	const relativeSets = Object.entries(rootSets).map(
		([key, roots]) => [key, roots.map((root) => relative(repositoryRoot, resolvePath(repositoryRoot, root)))] as const
	)

	const graph = await cruiseModuleGraph([...new Set(relativeSets.flatMap(([, roots]) => roots))], repositoryRoot)
	const resolutions = await lockedResolutions(repositoryRoot)
	const hashes = new Map<string, string>()

	for (const [key, roots] of relativeSets) {
		hashes.set(key, await hashReach(reachableModules(graph, roots), repositoryRoot, resolutions))
	}

	return hashes
}

/**
 * The code hash of one root set.
 */
export async function moduleGraphHash(
	roots: readonly string[],
	repositoryRoot: string = defaultRepositoryRoot()
): Promise<string> {
	return (await moduleGraphHashes({ roots }, repositoryRoot)).get("roots")!
}

function isAdapter(value: unknown): value is CorpusAdapter {
	return (
		typeof value === "object" &&
		value != null &&
		typeof (value as CorpusAdapter).id === "string" &&
		typeof (value as CorpusAdapter).rows === "function"
	)
}

/**
 * The module of this package that registers every built-in adapter, repository-relative.
 */
export const ADAPTER_REGISTRATION_MODULE = "packages/corpus/lib/adapters.ts"

/**
 * The module that exports each adapter, read from the imports of {@linkcode ADAPTER_REGISTRATION_MODULE}.
 *
 * @throws When an adapter is exported by no module it imports.
 */
export async function adapterModules(
	adapters: readonly CorpusAdapter[],
	repositoryRoot: string = defaultRepositoryRoot()
): Promise<Map<string, string>> {
	const graph = await cruiseModuleGraph([ADAPTER_REGISTRATION_MODULE], repositoryRoot)
	// Matched by id rather than by identity: a test runner can load a second instance of the same module.
	const byID = new Map<string, string>()

	for (const module of graph.edges.get(ADAPTER_REGISTRATION_MODULE) ?? []) {
		const exports = (await import(pathToFileURL(resolvePath(repositoryRoot, module)).href)) as Record<string, unknown>

		for (const value of Object.values(exports)) {
			if (!isAdapter(value)) continue

			const claimed = byID.get(value.id)

			if (claimed && claimed !== module) {
				throw new Error(`adapterModules: ${claimed} and ${module} both export an adapter with id ${value.id}`)
			}

			byID.set(value.id, module)
		}
	}

	const modules = new Map<string, string>()

	for (const adapter of adapters) {
		const module = byID.get(adapter.id)

		if (!module) {
			throw new Error(
				`adapterModules: adapter ${adapter.id} is exported by no module ${ADAPTER_REGISTRATION_MODULE} imports, ` +
					`so its code hash cannot be computed. Register it in BUILTIN_ADAPTERS.`
			)
		}

		modules.set(adapter.id, module)
	}

	return modules
}
