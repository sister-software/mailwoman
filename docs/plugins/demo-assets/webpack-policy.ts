/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Browser/SSR bundle policy for the geocoder page.
 *
 *   What remains here is Docusaurus-specific: the workspace source aliases for development, the SSR bundle's
 *   externals, the WASM asset rule, and a cache key that follows the alias map. Module resolution for `@mailwoman/*`
 *   is NOT rewritten here: a package the client reaches carries a `browser` export condition, and the `bundle-graph`
 *   health check refuses a Node builtin on the client's static path.
 */

import { md5Hex } from "@mailwoman/core/hash"
import type { Configuration } from "webpack"

import { buildWorkspaceAliases } from "./workspace-aliases.ts"
import { resolvePackageFile } from "./workspace-resolution.ts"

function hashAliases(alias: Record<string, string>): string {
	const entries = Object.keys(alias)
		.toSorted()
		.map((key) => `${key}=${alias[key]}`)

	return md5Hex(entries.join("\n"))
}

export async function bundleAliases(isServer: boolean): Promise<Record<string, string>> {
	const alias = await buildWorkspaceAliases()

	if (isServer) {
		// The SSR bundle resolves the `node` condition, under which `@mailwoman/neural/onnx-runner` is the
		// `onnxruntime-node` half, which webpack cannot bundle. The page is browser-only; the server bundle only has to
		// build, so it takes the browser runner.
		const browserRunner = await resolvePackageFile("@mailwoman/neural", "onnx-runner-browser")

		if (browserRunner) {
			alias["@mailwoman/neural/onnx-runner"] = browserRunner
			alias["#onnx-runner"] = browserRunner
		}
	}

	return alias
}

function filesystemCache(config: Configuration, alias: Record<string, string>): Pick<Configuration, "cache"> {
	const baseCache = config.cache

	if (typeof baseCache !== "object" || baseCache?.type !== "filesystem") return {}

	return {
		cache: { type: "filesystem", version: `${baseCache.version ?? ""}-${hashAliases(alias)}` },
	}
}

/**
 * Docusaurus calls `configureWebpack` SYNCHRONOUSLY, so the alias map is resolved by the caller — the plugin factory,
 * which Docusaurus does await — and handed in here. Resolving it at this point would return a promise the lifecycle
 * never unwraps.
 */
export function configureDemoWebpack(
	config: Configuration,
	alias: Record<string, string>,
	isServer: boolean
): Configuration {
	return {
		...filesystemCache(config, alias),
		// isomorphic-dompurify's Node build constructs a jsdom window at import, and jsdom cannot be webpack-bundled
		// (`__dirname is not defined` inside the SSR bundle). The server bundle requires the real package from
		// node_modules at render time instead, so SSR sanitizes through the same jsdom-backed engine as any other Node
		// process. The client bundle keeps bundling it — the package's `browser` build, plain DOMPurify.
		...(isServer ? { externals: [{ "isomorphic-dompurify": "commonjs isomorphic-dompurify" }] } : {}),
		resolve: {
			alias,
			extensionAlias: { ".js": [".ts", ".js"] },
		},
		module: { rules: [{ test: /[.]wasm$/, type: "asset/resource" }] },
	}
}
