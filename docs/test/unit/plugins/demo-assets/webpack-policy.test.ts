/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readDirectory, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { bundleAliases, configureDemoWebpack } from "@mailwoman/docs/plugins/demo-assets/webpack-policy"
import { buildWorkspaceAliases } from "@mailwoman/docs/plugins/demo-assets/workspace-aliases"
import { join, resolvePath } from "path-ts"
import { describe, expect, test } from "vitest"

const docsDir = resolvePackagePath("@mailwoman/docs")

/**
 * Directory subpaths whose barrel re-exports a Node-only sibling, and which the demo must therefore never import whole.
 *
 * `@mailwoman/resolver-wof-sqlite/fst` carries `fst/freshness`, and `/street` carries `street/morphology-fst-loader`;
 * both reach `@mailwoman/core/fs`, and the package declares no `sideEffects`, so webpack cannot shake them out of the
 * client bundle. Enter through the leaf instead — `fst/deserialize-web`, `fst/autocomplete`, `street/normalize`.
 *
 * This is a cheap stand-in for a five-minute `docusaurus build`, which is otherwise the only thing that catches the
 * class. It was added after the prefix fold repointed four demo imports from those leaves onto the barrels and produced
 * 27 `'x' is not exported from 'node:fs/promises'` errors in CI — green unit suite, green typecheck, red build.
 */
const NODE_BACKED_BARRELS = ["@mailwoman/resolver-wof-sqlite/fst", "@mailwoman/resolver-wof-sqlite/street"]

async function* browserSources(directory: string): AsyncGenerator<string> {
	for (const entry of await readDirectory(directory)) {
		const full = join(directory, entry)

		if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
			yield String(full)
		} else if (!entry.includes(".")) {
			yield* browserSources(String(full))
		}
	}
}

describe("docs webpack policy", () => {
	test("the demo enters browser-safe leaves, never a Node-backed barrel", async () => {
		const offenders: string[] = []

		for await (const file of browserSources(String(resolvePath(docsDir, "src")))) {
			const text = await readLocalTextFile(file)

			for (const barrel of NODE_BACKED_BARRELS) {
				if (text.includes(`"${barrel}"`)) {
					offenders.push(`${file} → ${barrel}`)
				}
			}
		}

		expect(offenders, "import the leaf module instead — see NODE_BACKED_BARRELS").toEqual([])
	})

	test("places browser-safe leaf aliases before their Node-backed barrels", async () => {
		const keys = Object.keys(await buildWorkspaceAliases())

		expect(keys.indexOf("@mailwoman/core/resources/whosonfirst/specificity")).toBeLessThan(
			keys.indexOf("@mailwoman/core/resources")
		)
	})

	test("routes both public and private neural runner specifiers to the browser implementation for SSR", async () => {
		const emptyShim = resolvePath(docsDir, "src", "empty-shim.js")

		const config = configureDemoWebpack({ cache: false }, emptyShim, await bundleAliases(true, emptyShim), true)

		expect(config.externals).toEqual([{ "isomorphic-dompurify": "commonjs isomorphic-dompurify" }])

		const aliases = config.resolve?.alias as Record<string, string>

		expect(aliases["#onnx-runner"]).toMatch(/onnx-runner-browser[.]ts$/)
		expect(aliases["@mailwoman/neural/onnx-runner"]).toBe(aliases["#onnx-runner"])
	})
})
