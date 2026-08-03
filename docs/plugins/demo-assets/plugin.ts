/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Docusaurus plugin that manages the /demo page's static assets (model.onnx, tokenizer.model,
 *   fst-en-US.bin) and the workspace webpack aliases needed to bundle @mailwoman/*
 *   packages for the browser.
 *
 *   Replaces the previous build-demo-assets.sh script + inline workspaceAliasPlugin. All heavy binary
 *   artifacts are derived from the neural-weights-en-us model-card.json (source of truth for
 *   version + expected sizes), so a tokenizer/model mismatch is caught at build time.
 *
 *   Asset staging runs in loadContent() — before webpack — so both `yarn start` (dev) and `yarn
 *   build` (prod) get correct artifacts without a separate pre-build step.
 */

import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"

import type { LoadContext, Plugin } from "@docusaurus/types"
import webpack from "webpack"

import {
	buildWorkspaceAliases,
	resolveWorkspaceDir,
	resolveWorkspaceFile,
	stagePairIndexes,
	stageSQLJSHTTPVFS,
} from "./resolve.ts"

/**
 * A stable digest of the alias map — same specifiers pointing at the same files hash the same, whatever order
 * `buildWorkspaceAliases` happened to insert them in.
 */
function hashAliases(alias: Record<string, string>): string {
	const entries = Object.keys(alias)
		.toSorted()
		.map((key) => `${key}=${alias[key]}`)

	return createHash("md5").update(entries.join("\n")).digest("hex")
}

export default function demoAssetsPlugin(context: LoadContext): Plugin {
	const docsDir = context.siteDir
	const staticDir = resolve(docsDir, "static", "mailwoman")
	const emptyShim = resolve(docsDir, "src", "empty-shim.js")

	return {
		name: "demo-assets",

		async loadContent() {
			// Every asset the demo loads at runtime — model, tokenizer, fst, postcodes, the resolver DBs,
			// releases.json — is served from the R2 bucket (see docs/src/shared/resources.tsx). The
			// assets that must be same-origin are (1) the sql.js-httpvfs worker (browsers block cross-origin
			// `new Worker()`) and (2) the placetype-pair indexes (#1278 — not on R2 yet; that's the
			// release-train repoint), so we stage both into the Pages deploy at `/mailwoman/sqljs/` +
			// `/mailwoman/pair-index/`. Nothing else lands in the Pages deploy.
			mkdirSync(staticDir, { recursive: true })
			const sqljsDir = resolve(staticDir, "sqljs")
			mkdirSync(sqljsDir, { recursive: true })
			stageSQLJSHTTPVFS(sqljsDir)
			const pairIndexDir = resolve(staticDir, "pair-index")
			mkdirSync(pairIndexDir, { recursive: true })
			stagePairIndexes(pairIndexDir)

			return {}
		},

		async contentLoaded({ content, actions }) {
			actions.setGlobalData(content)
		},

		configureWebpack(config, isServer) {
			const alias = buildWorkspaceAliases()

			// The SSR compile resolves under the `node` condition — correctly, it targets Node — so
			// `@mailwoman/neural/onnx-runner` reaches the real runner and drags onnxruntime-node's `.node`
			// binaries into a bundle webpack then cannot parse. The client compile needs nothing: its
			// `browser` condition already picks the counterpart.
			//
			// Aliasing just this specifier rather than adding `browser` to the server's conditionNames: that
			// would flip every browser-conditioned package in node_modules for SSR, and `@mailwoman/neural` is
			// the only workspace carrying such a condition.
			if (isServer) {
				const neuralDir = resolveWorkspaceDir("@mailwoman/neural")

				if (neuralDir) {
					alias["@mailwoman/neural/onnx-runner"] = resolveWorkspaceFile(neuralDir, "onnx-runner-browser")
				}
			}

			// Webpack does not evict its filesystem cache when an alias changes (webpack#13627), and an
			// alias map is not a file, so it reaches no part of the cache identity on its own: Docusaurus
			// fills `cache.buildDependencies.config` with exactly its base.js, its client/server entry,
			// and docusaurus.config.ts. A warm cache (~600 MB under docs/node_modules/.cache/webpack)
			// therefore keeps serving modules resolved under the OLD map — an alias added to point at
			// workspace SOURCE goes on resolving through package `exports` to a stale `out/*.js`, with no
			// build error to notice it by.
			//
			// Docusaurus solves this for THEME aliases by hashing them into `cache.version`, and the same
			// move works here: hash the map and extend the version Docusaurus computed rather than
			// replacing it, so its docusaurusVersion + themeAliasesHash keep their say. Measured on this
			// site: warm rebuild 4.4s server / 7.0s client, and 27s / 32s after one alias entry changes —
			// the cache does evict. Adding the plugin's sources to `buildDependencies.config` instead was
			// measured NOT to work (touching resolve.ts left both compiles at their warm times), and it
			// would key on mtime rather than on the resolved targets even if it had.
			//
			// Guarded on the incoming cache's shape: with DOCUSAURUS_NO_PERSISTENT_CACHE set, Docusaurus
			// leaves `cache` undefined, and merging a version onto that yields a type-less cache object
			// that fails webpack's schema.
			const baseCache = config.cache

			const cache =
				typeof baseCache === "object" && baseCache?.type === "filesystem"
					? {
							cache: {
								// Restated, not chosen: webpack's config type makes `type` required, and the merge
								// lands on top of the filesystem cache the guard above just confirmed.
								type: "filesystem" as const,
								version: `${baseCache.version ?? ""}-${hashAliases(alias)}`,
							},
						}
					: {}

			return {
				...cache,
				plugins: [
					new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
						resource.request = require.resolve(emptyShim)
					}),
				],
				resolve: {
					alias,
					extensionAlias: {
						".js": [".ts", ".js"],
					},
					fallback: {
						fs: false,
						path: false,
						module: false,
						url: false,
						crypto: false,
						stream: false,
						buffer: false,
						worker_threads: false,
						util: false,
						perf_hooks: false,
						"node:fs": false,
						"node:path": false,
						"node:module": false,
						"node:url": false,
						"node:crypto": false,
						"node:stream": false,
						"node:buffer": false,
						"node:worker_threads": false,
						"node:util": false,
						"node:perf_hooks": false,
						"node:os": false,
						"node:child_process": false,
						"node:fs/promises": false,
					},
				},
				module: {
					rules: [
						{
							test: /\.wasm$/,
							type: "asset/resource",
						},
					],
				},
			}
		},
	}
}
