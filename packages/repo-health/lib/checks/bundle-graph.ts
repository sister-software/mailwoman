/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Bundles each browser and Worker subpath under its platform conditions and fails on a Node builtin in the
 *   static graph.
 *
 *   The check reads esbuild's metafile and reports any static edge onto a builtin or onto `@mailwoman/core`'s `fs/`
 *   directory. The fix for such an edge is a `browser` condition in the owning package. Dynamic imports stay external,
 *   and a dynamic import of a builtin passes only when the row lists it with a reason. The check bundles `out/`, so it
 *   requires a compiled tree.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { build, type Metafile, type Plugin } from "esbuild"
import { resolvePath } from "path-ts"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#check"

/**
 * A dynamic builtin import that a row allows.
 *
 * It records the importing file, the builtin, and the reason the import is Node-only.
 */
interface AllowedDynamicImport {
	file: RegExp
	builtin: string
	reason: string
}

/**
 * One bundle to check.
 *
 * It records the entry specifier, the target platform, and the files the bundle must or must not contain.
 */
export interface BundleRow {
	entry: string
	platform: "browser" | "neutral"
	conditions: readonly string[]
	/**
	 * Third-party packages left out of the bundle.
	 * They ship their own platform builds.
	 */
	external?: readonly string[]
	/**
	 * Whether to bundle dynamic imports instead of leaving them external.
	 *
	 * A row needs this to assert what a lazily imported specifier resolves to.
	 */
	followDynamicImports?: boolean
	allowedDynamicImports?: readonly AllowedDynamicImport[]
	/**
	 * Patterns that some metafile input path must match.
	 */
	mustInclude?: readonly RegExp[]
	/**
	 * Patterns that no metafile input path may match.
	 */
	mustExclude?: readonly RegExp[]
}

const WORKER_CONDITIONS = ["workerd", "worker", "browser"] as const
const BROWSER_CONDITIONS = ["browser"] as const

/**
 * The third-party packages that browser rows leave external.
 * Each ships its own platform builds.
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
 * The dynamic builtin imports on the neural client graph.
 * Each one sits in a Node-only branch.
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
 * The rows to check.
 *
 * The license subpaths use the Cloudflare Worker conditions, and the other rows use the browser conditions.
 */
const BUNDLE_ROWS: readonly BundleRow[] = [
	{
		entry: "@mailwoman/core/license/key",
		platform: "neutral",
		conditions: WORKER_CONDITIONS,
		mustInclude: [/license\/key\/index\.js$/u],
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
	browserRow("@mailwoman/core/pipeline/client-result"),
	browserRow("@mailwoman/resolver-wof-wasm/httpvfs/resolver"),
	browserRow("@mailwoman/resolver-wof-wasm/httpvfs/street"),
	browserRow("@mailwoman/resolver-wof-wasm/httpvfs/poi"),
	browserRow("@mailwoman/neural/viterbi"),
	browserRow("mailwoman/browser-runtime", { allowedDynamicImports: NEURAL_DYNAMIC_IMPORTS }),
	browserRow("@mailwoman/neural/web-loader", { allowedDynamicImports: NEURAL_DYNAMIC_IMPORTS }),
	browserRow("@mailwoman/cartographer/planetary"),
	browserRow("@mailwoman/astrogeology/search/tokens"),
	browserRow("@mailwoman/astrogeology/schema/nomenclature"),
	browserRow("@mailwoman/astrogeology/schema/manifest"),
	browserRow("@mailwoman/planetary/search"),
	browserRow("@mailwoman/neural/classifier", {
		followDynamicImports: true,
		allowedDynamicImports: NEURAL_DYNAMIC_IMPORTS,
		mustInclude: [/neural\/out\/classifier\/loader\/browser\.js$/u],
		mustExclude: [/neural\/out\/classifier\/loader\.js$/u],
	}),
]

/**
 * The unprefixed builtin names that dependencies import. {@link isNodeBuiltin}
 * recognizes `node:` paths by prefix.
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
 * Marks builtins and, unless the row follows them, dynamic imports as external.
 *
 * An external builtin keeps esbuild from failing to resolve it, so the metafile
 * records the edge with its importing file and kind.
 */
function edgePolicy(row: BundleRow): Plugin {
	return {
		name: "bundle-graph-edge-policy",
		setup(builder) {
			// Esbuild compiles the filter as a Go regular expression, which has no `u` flag.
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
		// A build can fail on resolution before it writes a metafile.
		// Each resolution error becomes a diagnostic on the importing file.
		const failure = error as BuildFailure

		return (failure.errors ?? [{ text: String(error) }]).map((entry) =>
			diagnostic(`${row.entry}: ${entry.text}`, entry.location?.file ?? undefined)
		)
	}
}

/**
 * Bundles one row and returns the diagnostics from its metafile.
 * Tests call it with rows that must fail.
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
 * The `bundle-graph` check.
 *
 * It reports an error for an uncompiled tree and for every row in {@link BUNDLE_ROWS} that fails.
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
