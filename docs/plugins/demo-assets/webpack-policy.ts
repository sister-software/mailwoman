/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Browser/SSR bundle policy for the docs demo.
 */

import { md5Hex } from "@mailwoman/core/utils/hash"
import { resolvePath } from "path-ts"
import type { Configuration } from "webpack"
import webpack from "webpack"

import { buildWorkspaceAliases } from "./workspace-aliases.ts"
import { resolvePackageFile } from "./workspace-resolution.ts"

const NODE_BUILTIN_SHIMS = {
	"node:path": "./node-path-shim.js",
	"node:fs": "./node-builtin-stubs.js",
	"node:fs/promises": "./node-builtin-stubs.js",
	"node:worker_threads": "./node-builtin-stubs.js",
	"node:stream/web": "./node-builtin-stubs.js",
} as const

const EMPTY_NODE_BUILTINS = [
	"module",
	"url",
	"crypto",
	"stream",
	"buffer",
	"util",
	"perf_hooks",
	"os",
	"child_process",
	"node:module",
	"node:url",
	"node:crypto",
	"node:stream",
	"node:buffer",
	"node:util",
	"node:perf_hooks",
	"node:os",
	"node:child_process",
] as const

function hashAliases(alias: Record<string, string>): string {
	const entries = Object.keys(alias)
		.toSorted()
		.map((key) => `${key}=${alias[key]}`)

	return md5Hex(entries.join("\n"))
}

export async function bundleAliases(isServer: boolean, emptyShim: string): Promise<Record<string, string>> {
	const alias = await buildWorkspaceAliases()

	if (isServer) {
		const browserRunner = await resolvePackageFile("@mailwoman/neural", "onnx-runner-browser")

		if (browserRunner) {
			alias["@mailwoman/neural/onnx-runner"] = browserRunner
			alias["#onnx-runner"] = browserRunner
		}
	} else {
		alias["read-excel-file/node"] = emptyShim
		alias["write-excel-file/node"] = emptyShim
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

function fallbackMap(): NonNullable<NonNullable<Configuration["resolve"]>["fallback"]> {
	const fallback: NonNullable<NonNullable<Configuration["resolve"]>["fallback"]> = {
		fs: require.resolve("./node-builtin-stubs.js"),
		path: require.resolve("./node-path-shim.js"),
		worker_threads: require.resolve("./node-builtin-stubs.js"),
		"node:fs": require.resolve("./node-builtin-stubs.js"),
		"node:fs/promises": require.resolve("./node-builtin-stubs.js"),
		"node:path": require.resolve("./node-path-shim.js"),
		"node:worker_threads": require.resolve("./node-builtin-stubs.js"),
		"node:stream/web": require.resolve("./node-builtin-stubs.js"),
	}

	for (const builtin of EMPTY_NODE_BUILTINS) {
		fallback[builtin] = false
	}

	return fallback
}

/**
 * Docusaurus calls `configureWebpack` SYNCHRONOUSLY, so the alias map is resolved by the caller — the plugin factory,
 * which Docusaurus does await — and handed in here. Resolving it at this point would return a promise the lifecycle
 * never unwraps.
 */
export function configureDemoWebpack(
	config: Configuration,
	docsDir: string,
	alias: Record<string, string>,
	isServer: boolean
): Configuration {
	const emptyShim = resolvePath(docsDir, "src", "empty-shim.js")

	return {
		...filesystemCache(config, alias),
		// isomorphic-dompurify's Node build constructs a jsdom window at import, and jsdom cannot be webpack-bundled
		// (`__dirname is not defined` inside the SSR bundle). The server bundle requires the real package from
		// node_modules at render time instead, so SSR sanitizes through the same jsdom-backed engine as any other Node
		// process. The client bundle keeps bundling it — the package's `browser` build, plain DOMPurify.
		...(isServer ? { externals: [{ "isomorphic-dompurify": "commonjs isomorphic-dompurify" }] } : {}),
		plugins: [
			new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
				const shim = NODE_BUILTIN_SHIMS[resource.request as keyof typeof NODE_BUILTIN_SHIMS]
				resource.request = shim ? require.resolve(shim) : require.resolve(emptyShim)
			}),
		],
		resolve: {
			alias,
			extensionAlias: { ".js": [".ts", ".js"] },
			fallback: fallbackMap(),
		},
		module: { rules: [{ test: /[.]wasm$/, type: "asset/resource" }] },
	}
}
