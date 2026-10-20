/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The code hash of a derivation: a digest over the modules a source's code reaches inside this package.
 *
 *   A derivation hash over every module of the package gives every stored file a new hash on any edit. This module
 *   narrows it to the modules a root reaches through its runtime imports under `lib/`. An edit to one adapter then
 *   changes only that adapter's files, and an edit to a helper changes the hash of every root that reaches it.
 *
 *   dependency-cruiser resolves the graph with the resolve options of the repository's
 *   `dependency-cruiser.config.mjs`. Under the `node` condition a `#` import resolves to `lib/*.ts`, so the graph
 *   needs no compiled `out/`. A type-only edge is left out of reachability because it emits no runtime import.
 *   Modules of other workspaces are out of scope here. The builder version covers them, since every
 *   `@mailwoman/*` workspace is released at one version.
 */

import { sha256File, sha256Hex } from "@mailwoman/core/hash"
import { pathToFileURL } from "@mailwoman/core/module/file-url"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { relative, resolvePath } from "path-ts"

import type { CorpusAdapter } from "#types"

/**
 * The resolve options `dependency-cruiser.config.mjs` declares, so this graph agrees with the repository's.
 */
const ENHANCED_RESOLVE_OPTIONS = {
	conditionNames: ["node", "import", "default"],
	exportsFields: ["exports"],
}

/**
 * This package's directory.
 */
export function corpusPackageDirectory(): string {
	return resolvePackagePath("@mailwoman/corpus")
}

/**
 * Runtime import edges between the `lib/` modules of one package, keyed by package-relative path.
 */
export type ModuleGraph = ReadonlyMap<string, readonly string[]>

/**
 * Cruise the graph from `roots`, which are absolute paths or paths relative to `packageDirectory`.
 *
 * @throws When a root lies outside `lib/` or an import under `lib/` does not resolve, because
 * a hash over a graph with a missing edge would leave an edit to the unresolved module unseen.
 */
export async function cruiseModuleGraph(roots: readonly string[], packageDirectory: string): Promise<ModuleGraph> {
	const { cruise } = await import("dependency-cruiser")
	const relativeRoots = roots.map((root) => relative(packageDirectory, resolvePath(packageDirectory, root)))

	for (const root of relativeRoots) {
		if (!root.startsWith("lib/")) {
			throw new Error(`cruiseModuleGraph: ${root} is not a module under ${packageDirectory}/lib`)
		}
	}

	const result = await cruise(
		relativeRoots,
		{
			baseDir: packageDirectory,
			includeOnly: "^lib/",
			exclude: { path: "[.]test[.]ts$" },
			tsPreCompilationDeps: true,
			enhancedResolveOptions: ENHANCED_RESOLVE_OPTIONS,
		},
		{}
	)

	if (typeof result.output === "string") throw new Error("cruiseModuleGraph: dependency-cruiser returned text")

	const graph = new Map<string, string[]>()

	for (const module of result.output.modules) {
		const edges: string[] = []

		for (const dependency of module.dependencies) {
			if (dependency.couldNotResolve && dependency.module.startsWith("#")) {
				throw new Error(`cruiseModuleGraph: ${module.source} imports ${dependency.module}, which does not resolve`)
			}

			if (!dependency.resolved.startsWith("lib/")) continue

			if (dependency.dependencyTypes.some((type) => type === "type-only" || type === "pre-compilation-only")) continue

			edges.push(dependency.resolved)
		}

		graph.set(module.source, edges)
	}

	return graph
}

/**
 * The modules `roots` reach through runtime edges, sorted.
 */
export function reachableModules(graph: ModuleGraph, roots: readonly string[]): string[] {
	const seen = new Set<string>()
	const pending = [...roots]

	while (pending.length) {
		const next = pending.pop()!

		if (seen.has(next)) continue

		const edges = graph.get(next)

		if (!edges) throw new Error(`reachableModules: ${next} is absent from the cruised graph`)

		seen.add(next)
		pending.push(...edges)
	}

	return [...seen].toSorted()
}

/**
 * A digest over the reached modules, as `relative path NUL sha256` lines in path order.
 */
export async function hashModules(modules: readonly string[], packageDirectory: string): Promise<string> {
	const lines: string[] = []

	for (const module of modules) {
		lines.push(`${module}\0${await sha256File(resolvePath(packageDirectory, module))}`)
	}

	return sha256Hex(lines.join("\n"))
}

/**
 * The code hash of each named root set, from one cruise over every root.
 *
 * @param rootSets Each key's roots are package-relative or absolute module paths.
 */
export async function moduleGraphHashes(
	rootSets: Readonly<Record<string, readonly string[]>>,
	packageDirectory: string = corpusPackageDirectory()
): Promise<Map<string, string>> {
	const relativeSets = Object.entries(rootSets).map(
		([key, roots]) =>
			[key, roots.map((root) => relative(packageDirectory, resolvePath(packageDirectory, root)))] as const
	)

	const graph = await cruiseModuleGraph([...new Set(relativeSets.flatMap(([, roots]) => roots))], packageDirectory)
	const hashes = new Map<string, string>()

	for (const [key, roots] of relativeSets) {
		hashes.set(key, await hashModules(reachableModules(graph, roots), packageDirectory))
	}

	return hashes
}

/**
 * The code hash of one root set.
 */
export async function moduleGraphHash(
	roots: readonly string[],
	packageDirectory: string = corpusPackageDirectory()
): Promise<string> {
	return (await moduleGraphHashes({ roots }, packageDirectory)).get("roots")!
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
 * The module that exports each adapter, read from the imports of `lib/adapters.ts`,
 * the module that registers every built-in adapter.
 *
 * @throws When an adapter is exported by no module `lib/adapters.ts` imports.
 */
export async function adapterModules(
	adapters: readonly CorpusAdapter[],
	packageDirectory: string = corpusPackageDirectory()
): Promise<Map<string, string>> {
	const graph = await cruiseModuleGraph(["lib/adapters.ts"], packageDirectory)
	// Matched by id rather than by identity: a test runner can load a second instance of the same module.
	const byID = new Map<string, string>()

	for (const module of graph.get("lib/adapters.ts") ?? []) {
		const exports = (await import(pathToFileURL(resolvePath(packageDirectory, module)).href)) as Record<string, unknown>

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
				`adapterModules: adapter ${adapter.id} is exported by no module lib/adapters.ts imports, so its code ` +
					`hash cannot be computed. Register it in BUILTIN_ADAPTERS.`
			)
		}

		modules.set(adapter.id, module)
	}

	return modules
}
