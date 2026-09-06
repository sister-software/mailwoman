/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The classifier's browser graph carries no STATIC `node:` import. The docs site bundles `@mailwoman/neural`'s
 *   classifier for the demo, and webpack has no shim for `node:fs/promises`; a static reach through
 *   `@mailwoman/core/fs/readers` broke the site build for three commits before anything in CI said so (#2168). The one
 *   sanctioned node reach on this graph is the tokenizer's `import(/* webpackIgnore: true *\/ "node:fs/promises")`,
 *   which is a DYNAMIC import behind an environment guard — so this test bundles the classifier entry with esbuild,
 *   reads the metafile, and refuses any `import-statement` edge onto a `node:` module or onto `@mailwoman/core`'s
 *   filesystem home.
 */

import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { build, type Plugin } from "esbuild"
import { describe, expect, it } from "vitest"

/**
 * Webpack honours `/* webpackIgnore: true *\/` on a dynamic import and leaves it unbundled; esbuild follows it. This
 * plugin gives esbuild webpack's view of the graph — every dynamic import stays external — so what remains is the
 * STATIC graph the docs client actually compiles.
 */
const dynamicImportsStayExternal: Plugin = {
	name: "dynamic-imports-stay-external",
	setup(builder) {
		builder.onResolve({ filter: /.*/ }, (args) =>
			args.kind === "dynamic-import" ? { path: args.path, external: true } : undefined
		)
	},
}

/**
 * The bare builtin names a dependency reaches without the `node:` prefix (graceful-fs, spliterator, unzipper do). A
 * `node:`-prefixed path is recognised by prefix; this list only has to cover the unprefixed spellings.
 */
const BARE_BUILTINS = new Set([
	"assert",
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
	"stream",
	"stream/web",
	"util",
	"url",
	"zlib",
])

const isNodeBuiltin = (path: string): boolean => path.startsWith("node:") || BARE_BUILTINS.has(path)

describe("the classifier's browser graph", () => {
	it("reaches node: modules only through dynamic imports", async () => {
		// A static reach past a builtin (graceful-fs, spliterator) fails to RESOLVE under the browser platform before
		// the metafile exists; those errors are the finding too, named by file rather than thrown as a wall of text.
		const result = await build({
			entryPoints: [resolvePackagePath("@mailwoman/neural", "lib", "classifier", "index.ts")],
			bundle: true,
			format: "esm",
			platform: "browser",
			// The dev exports map's `node` condition points at `.ts` source; without it esbuild reads `out/`, which lags
			// the source until the next compile, and the test would grade last build's graph.
			conditions: ["node"],
			target: "es2022",
			write: false,
			metafile: true,
			logLevel: "silent",
			plugins: [dynamicImportsStayExternal],
			external: ["onnxruntime-node", "onnxruntime-web"],
		}).catch((error: { errors?: Array<{ text: string; location?: { file: string } | null }> }) => {
			const named = (error.errors ?? []).map((m) => `${m.location?.file ?? "?"}: ${m.text}`)

			throw new Error(`the classifier's browser graph reaches node statically:\n  ${named.join("\n  ")}`)
		})

		const offenders: string[] = []

		for (const [input, meta] of Object.entries(result.metafile.inputs)) {
			for (const edge of meta.imports) {
				const staticEdge = edge.kind === "import-statement" || edge.kind === "require-call"
				const reachesNode = isNodeBuiltin(edge.path) || /packages\/core\/(lib|out)\/fs\//.test(edge.path)

				if (staticEdge && reachesNode) {
					offenders.push(`${input} → ${edge.path}`)
				}
			}
		}

		expect(offenders).toEqual([])
	})
})
