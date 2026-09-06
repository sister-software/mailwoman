/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Every subpath a browser or Worker bundle reaches must bundle under that platform's export conditions with no
 *   Node builtin on its static graph. A bundler resolves `exports` and `imports` under `browser` (wrangler: `workerd`,
 *   `worker`, `browser`) before `default`; this check bundles each entry the same way, reads esbuild's metafile, and
 *   refuses a static edge onto a builtin or onto `@mailwoman/core`'s filesystem home. Such an edge is a package whose
 *   browser half is missing, and the fix is a `browser` condition in the owning package, never a stub in a consumer's
 *   bundler config.
 *
 *   Dynamic imports stay external, which is webpack's view of a `webpackIgnore` import and the view every bundler gets
 *   once the imported specifier carries a `browser` condition. A dynamic import of a builtin is tolerated ONLY when a
 *   row lists it with a reason; the list is the whole allowance, and a new one is an error until it is removed or
 *   listed.
 *
 *   Resolution goes to `out/`, which is what a consumer bundles, so the check refuses an uncompiled tree rather than
 *   grading the source under a condition no consumer has.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { build, type Metafile, type Plugin } from "esbuild"
import { resolvePath } from "path-ts"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#check"

/**
 * A dynamic import of a builtin the row tolerates: the file that makes it, the builtin, and why it is Node-only.
 */
interface AllowedDynamicImport {
	file: RegExp
	builtin: string
	reason: string
}

/**
 * One bundle to grade: the entry specifier, the platform a consumer bundles it for, and what the bundle must and must
 * not carry.
 */
export interface BundleRow {
	entry: string
	platform: "browser" | "neutral"
	conditions: readonly string[]
	/**
	 * Third-party packages left out of the bundle because they are not under test and carry their own platform builds.
	 */
	external?: readonly string[]
	/**
	 * Follow dynamic imports into the bundle instead of leaving them external. A row that asserts what a lazily imported
	 * specifier resolves to under the row's conditions needs this; every other row grades the static graph alone.
	 */
	followDynamicImports?: boolean
	allowedDynamicImports?: readonly AllowedDynamicImport[]
	/**
	 * Files that must be in the bundle, matched against the metafile's input path.
	 */
	mustInclude?: readonly RegExp[]
	mustExclude?: readonly RegExp[]
}

const WORKER_CONDITIONS = ["workerd", "worker", "browser"] as const
const BROWSER_CONDITIONS = ["browser"] as const

/**
 * What a browser bundle of a mailwoman package never bundles itself: the UI runtime and the engines behind it, each
 * shipping its own platform builds.
 */
const BROWSER_EXTERNALS = [
	"react",
	"react/*",
	"react-dom",
	"react-dom/*",
	"onnxruntime-web",
	"onnxruntime-web/*",
	"onnxruntime-node",
	"maplibre-gl",
	"sql.js-httpvfs",
	"@sqlite.org/*",
] as const

/**
 * The two dynamic builtin imports on the neural client graph, each a Node-only branch behind an environment guard.
 */
const NEURAL_DYNAMIC_IMPORTS: readonly AllowedDynamicImport[] = [
	{
		file: /neural\/out\/tokenizer\.js$/u,
		builtin: "node:fs/promises",
		reason: "loadFromFile is Node-only; the import runs only when it is called",
	},
	{
		file: /sentencepiece-wasm\/sentencepiece\.mjs$/u,
		builtin: "node:module",
		reason: "the emscripten preamble's Node branch, behind its own environment check",
	},
]

const browserRow = (entry: string, extra: Partial<BundleRow> = {}): BundleRow => ({
	entry,
	platform: "browser",
	conditions: BROWSER_CONDITIONS,
	external: BROWSER_EXTERNALS,
	...extra,
})

/**
 * Every entry graded, in two condition sets: the license key's subpaths as the Cloudflare Worker bundles them, and the
 * `@mailwoman/core` and `@mailwoman/neural` subpaths the browser client reaches.
 */
const BUNDLE_ROWS: readonly BundleRow[] = [
	{
		entry: "@mailwoman/core/license/key",
		platform: "neutral",
		conditions: WORKER_CONDITIONS,
		mustInclude: [/license\/key\.js$/u],
	},
	{
		entry: "@mailwoman/core/license/register",
		platform: "neutral",
		conditions: WORKER_CONDITIONS,
		mustInclude: [/license\/register\.js$/u],
	},
	browserRow("@mailwoman/core/objects"),
	browserRow("@mailwoman/core/json"),
	browserRow("@mailwoman/core/resolver"),
	browserRow("@mailwoman/core/decoder"),
	browserRow("@mailwoman/core/decoder/types"),
	browserRow("@mailwoman/core/errors"),
	browserRow("@mailwoman/core/pipeline"),
	browserRow("@mailwoman/neural/viterbi"),
	browserRow("@mailwoman/neural/web-loader", { allowedDynamicImports: NEURAL_DYNAMIC_IMPORTS }),
	browserRow("@mailwoman/neural/classifier", {
		followDynamicImports: true,
		allowedDynamicImports: NEURAL_DYNAMIC_IMPORTS,
		mustInclude: [/neural\/out\/classifier\/loader-browser\.js$/u],
		mustExclude: [/neural\/out\/classifier\/loader\.js$/u],
	}),
]

/**
 * The bare builtin names a dependency reaches without the `node:` prefix (graceful-fs, spliterator and unzipper do). A
 * `node:`-prefixed path is recognised by prefix; this list only has to cover the unprefixed spellings.
 */
const BARE_BUILTINS = new Set([
	"assert",
	"async_hooks",
	"buffer",
	"child_process",
	"constants",
	"crypto",
	"events",
	"fs",
	"fs/promises",
	"module",
	"os",
	"path",
	"perf_hooks",
	"process",
	"stream",
	"stream/promises",
	"stream/web",
	"url",
	"util",
	"worker_threads",
	"zlib",
])

const isNodeBuiltin = (path: string): boolean => path.startsWith("node:") || BARE_BUILTINS.has(path)

const CORE_FS_HOME = /packages\/core\/(?:lib|out)\/fs\//u

/**
 * A builtin stays external so the metafile records the edge onto it with the file that made it and the import kind,
 * instead of esbuild refusing to resolve it under the browser platform. A dynamic import stays external unless the row
 * follows them, so the metafile is the STATIC graph: what a bundler compiles once each dynamic specifier resolves under
 * its own condition or is left to run time.
 */
function edgePolicy(row: BundleRow): Plugin {
	return {
		name: "bundle-graph-edge-policy",
		setup(builder) {
			// esbuild compiles the filter as a Go regular expression, which has no `u` flag.
			// oxlint-disable-next-line unicorn/require-unicode-regexp -- Go regexp syntax
			builder.onResolve({ filter: /.*/ }, (args) => {
				if (isNodeBuiltin(args.path)) return { path: args.path, external: true }

				if (args.kind === "dynamic-import" && !row.followDynamicImports) {
					return { path: args.path, external: true }
				}

				return undefined
			})
		},
	}
}

interface BuildFailure {
	errors?: Array<{ text: string; location?: { file: string } | null }>
}

function diagnostic(message: string, file?: string): Diagnostic {
	return { severity: DiagnosticSeverity.Error, message, file }
}

async function bundleRow(row: BundleRow, repoRoot: string): Promise<Metafile | Diagnostic[]> {
	try {
		const result = await build({
			stdin: {
				contents: `import "${row.entry}"`,
				resolveDir: repoRoot,
				sourcefile: "bundle-graph-entry.ts",
				loader: "ts",
			},
			bundle: true,
			format: "esm",
			platform: row.platform,
			conditions: [...row.conditions],
			mainFields: ["browser", "module", "main"],
			target: "es2022",
			write: false,
			metafile: true,
			logLevel: "silent",
			plugins: [edgePolicy(row)],
			external: [...(row.external ?? [])],
		})

		return result.metafile
	} catch (error) {
		// A static reach past a builtin can fail to RESOLVE under the browser platform before a metafile exists; each
		// resolution error is the finding, named by the file that made the import.
		const failure = error as BuildFailure

		return (failure.errors ?? [{ text: String(error) }]).map((entry) =>
			diagnostic(`${row.entry}: ${entry.text}`, entry.location?.file ?? undefined)
		)
	}
}

/**
 * Grade one row: bundle it and read the metafile. Exported so a test can run a row that must fail.
 */
export async function evaluateBundleRow(row: BundleRow, repoRoot: string): Promise<Diagnostic[]> {
	const bundled = await bundleRow(row, repoRoot)

	if (Array.isArray(bundled)) return bundled

	const diagnostics: Diagnostic[] = []
	const allowed = row.allowedDynamicImports ?? []

	for (const [file, input] of Object.entries(bundled.inputs)) {
		for (const edge of input.imports) {
			if (edge.kind === "dynamic-import") {
				if (!isNodeBuiltin(edge.path)) continue

				const listed = allowed.some((allowance) => allowance.file.test(file) && allowance.builtin === edge.path)

				if (!listed) {
					diagnostics.push(
						diagnostic(`${row.entry}: ${file} dynamically imports ${edge.path}, which no row lists`, file)
					)
				}

				continue
			}

			const entersCoreFS = CORE_FS_HOME.test(edge.path) && !CORE_FS_HOME.test(file)

			if (isNodeBuiltin(edge.path) || entersCoreFS) {
				diagnostics.push(diagnostic(`${row.entry}: ${file} → ${edge.path} on a static chain`, file))
			}
		}
	}

	const inputs = Object.keys(bundled.inputs)

	for (const pattern of row.mustInclude ?? []) {
		if (!inputs.some((path) => pattern.test(path))) {
			diagnostics.push(diagnostic(`${row.entry}: the bundle lacks a file matching ${pattern}`))
		}
	}

	for (const pattern of row.mustExclude ?? []) {
		const carried = inputs.find((path) => pattern.test(path))

		if (carried) {
			diagnostics.push(diagnostic(`${row.entry}: the bundle carries ${carried}, which the row excludes`, carried))
		}
	}

	return diagnostics
}

/**
 * The `bundle-graph` check: every row in {@link BUNDLE_ROWS} bundles clean, or the tree is not compiled.
 */
export const bundleGraphCheck: RepoCheck = {
	id: "bundle-graph",
	description:
		"Every browser- and Worker-bundled subpath resolves under its platform conditions with no Node builtin on the static graph.",
	async run(context) {
		const compiledMarker = "packages/core/out/index.js"

		if (!(await pathExists(resolvePath(context.repoRoot, compiledMarker)))) {
			return [
				diagnostic(
					`${compiledMarker} is missing — run \`yarn compile\`; this check grades out/, which is what a consumer bundles`
				),
			]
		}

		const diagnostics: Diagnostic[] = []

		for (const row of BUNDLE_ROWS) {
			diagnostics.push(...(await evaluateBundleRow(row, context.repoRoot)))
		}

		return diagnostics
	},
}
