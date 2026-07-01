/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Docusaurus plugin that manages the /demo page's static assets (model.onnx, tokenizer.model,
 *   fst-en-US.bin, wof-hot.db) and the workspace webpack aliases needed to bundle @mailwoman/*
 *   packages for the browser.
 *
 *   Replaces the previous build-demo-assets.sh script + inline workspaceAliasPlugin. All heavy binary
 *   artifacts are derived from the neural-weights-en-us model-card.json (source of truth for
 *   version + expected sizes), so a tokenizer/model mismatch is caught at build time.
 *
 *   Asset staging runs in loadContent() — before webpack — so both `yarn start` (dev) and `yarn
 *   build` (prod) get correct artifacts without a separate pre-build step.
 */

import { mkdirSync } from "node:fs"
import { resolve } from "node:path"

import type { LoadContext, Plugin } from "@docusaurus/types"
import webpack from "webpack"

import { buildWorkspaceAliases, stageSQLJSHTTPVFS } from "./resolve.js"

export default function demoAssetsPlugin(context: LoadContext): Plugin {
	const docsDir = context.siteDir
	const staticDir = resolve(docsDir, "static", "mailwoman")
	const emptyShim = resolve(docsDir, "src", "empty-shim.js")

	return {
		name: "demo-assets",

		async loadContent() {
			// Every asset the demo loads at runtime — model, tokenizer, fst, postcodes, the resolver DBs,
			// releases.json — is served from the R2 bucket (see docs/src/shared/resources.tsx). The ONLY
			// asset that must be same-origin is the sql.js-httpvfs worker (browsers block cross-origin
			// `new Worker()`), so we stage its runtime files (worker + wasm + UMD) into the Pages deploy
			// at `/mailwoman/sqljs/`. Nothing else lands in the Pages deploy.
			mkdirSync(staticDir, { recursive: true })
			const sqljsDir = resolve(staticDir, "sqljs")
			mkdirSync(sqljsDir, { recursive: true })
			stageSQLJSHTTPVFS(sqljsDir)

			return {}
		},

		async contentLoaded({ content, actions }) {
			actions.setGlobalData(content)
		},

		configureWebpack() {
			return {
				plugins: [
					new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
						resource.request = require.resolve(emptyShim)
					}),
				],
				resolve: {
					alias: buildWorkspaceAliases(),
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
