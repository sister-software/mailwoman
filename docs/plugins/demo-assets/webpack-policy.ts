/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Browser/SSR bundle policy for the docs demo.
 */

import { createHash } from "node:crypto"
import { resolve } from "node:path"

import type { Configuration } from "webpack"
import webpack from "webpack"

import { buildWorkspaceAliases, resolveWorkspaceDir, resolveWorkspaceFile } from "./resolve.ts"

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

	return createHash("md5").update(entries.join("\n")).digest("hex")
}

function bundleAliases(isServer: boolean, emptyShim: string): Record<string, string> {
	const alias = buildWorkspaceAliases()

	if (isServer) {
		const neuralDir = resolveWorkspaceDir("@mailwoman/neural")

		if (neuralDir) {
			const browserRunner = resolveWorkspaceFile(neuralDir, "onnx-runner-browser")
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

export function configureDemoWebpack(config: Configuration, isServer: boolean, docsDir: string): Configuration {
	const emptyShim = resolve(docsDir, "src", "empty-shim.js")
	const alias = bundleAliases(isServer, emptyShim)

	return {
		...filesystemCache(config, alias),
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
