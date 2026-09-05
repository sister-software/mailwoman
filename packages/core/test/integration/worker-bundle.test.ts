/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The license key's two subpaths must bundle for a Cloudflare Worker with no Node builtin in the graph. Wrangler
 *   resolves `exports` under the `workerd`, `worker` and `browser` conditions before `default`; this test bundles the
 *   same way and reads the import list. A `node:` specifier here is a core module that leaked onto the worker's path,
 *   and the fix is a platform-neutral implementation or a conditional export, never a shim in the worker.
 */

import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { build } from "esbuild"
import { expect, test } from "vitest"

const ENTRY = [
	'export { encodeLicenseKey, verifyLicenseKey, licenseKeyID } from "@mailwoman/core/license/key"',
	'export { trustedLicenseSigningKeys, publishedLicenseKeys } from "@mailwoman/core/license/register"',
].join("\n")

test("@mailwoman/core/license/key and /register bundle for a Worker with no node: import", async () => {
	const result = await build({
		stdin: {
			contents: ENTRY,
			resolveDir: String(resolvePackagePath("@mailwoman/core")),
			sourcefile: "worker-entry.ts",
			loader: "ts",
		},
		bundle: true,
		format: "esm",
		platform: "neutral",
		conditions: ["workerd", "worker", "browser"],
		mainFields: ["module", "main"],
		target: "es2022",
		write: false,
		metafile: true,
		logLevel: "silent",
	})

	const inputs = Object.keys(result.metafile.inputs)

	const nodeImports = Object.entries(result.metafile.inputs)
		.flatMap(([file, input]) => input.imports.map((entry) => ({ file, path: entry.path })))
		.filter(({ path }) => path.startsWith("node:"))
		.map(({ file, path }) => `${file} → ${path}`)

	expect(nodeImports, `node builtins reached from the worker entry:\n${nodeImports.join("\n")}`).toEqual([])
	expect(inputs.some((path) => /license\/key\.(?:ts|js)$/u.test(path))).toBe(true)
	expect(inputs.some((path) => /license\/register\.(?:ts|js)$/u.test(path))).toBe(true)
})
