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

import { existsSync, mkdirSync, statSync } from "node:fs"
import { resolve } from "node:path"
import webpack from "webpack"
import {
	buildFstBinary,
	buildSlimWofDb,
	buildWorkspaceAliases,
	fetchArtifactFromHf,
	readModelCard,
	resolveWeightsArtifact,
	stageSqlJsHttpvfs,
	syncArtifact,
} from "./resolve.mjs"

/**
 * @param {import("@docusaurus/types").LoadContext} context
 *
 * @returns {import("@docusaurus/types").Plugin}
 */
export default function demoAssetsPlugin(context) {
	const docsDir = context.siteDir
	const repoRoot = resolve(docsDir, "..")
	const staticDir = resolve(docsDir, "static", "mailwoman")
	const emptyShim = resolve(docsDir, "src", "empty-shim.js")

	return {
		name: "demo-assets",

		async loadContent() {
			mkdirSync(staticDir, { recursive: true })

			const modelCard = readModelCard()
			const version = modelCard?.version ?? "unknown"

			console.log(`[demo-assets] Model card version: ${version}`)

			// --- Model ONNX ---
			const modelSource = resolveWeightsArtifact("model.onnx")
			const modelDest = resolve(staticDir, "model.onnx")
			if (modelSource) {
				syncArtifact(modelSource, modelDest, "model.onnx")
			} else if (!existsSync(modelDest)) {
				console.warn("[demo-assets] model.onnx: not found in weights package and not in static/")
			}

			// --- Tokenizer ---
			const tokenizerSource = resolveWeightsArtifact("tokenizer.model")
			const tokenizerDest = resolve(staticDir, "tokenizer.model")
			if (tokenizerSource) {
				syncArtifact(tokenizerSource, tokenizerDest, "tokenizer.model")
			} else if (!existsSync(tokenizerDest)) {
				console.warn("[demo-assets] tokenizer.model: not found in weights package and not in static/")
			}

			// --- FST gazetteer ---
			const fstDest = resolve(staticDir, "fst-en-US.bin")
			if (!existsSync(fstDest)) {
				buildFstBinary(fstDest, { repoRoot })
			}

			// --- Resolver DBs (served same-origin from Pages for sql.js-httpvfs range loading) ---
			// Pulled from HF at build time: CI has no /mnt/playpen to build them, and serving them from
			// the same Pages origin as the demo is what makes range-loading work (same-origin → no CORS;
			// Pages/Fastly → range-capable + redirect-free, unlike HF's per-request-redirect resolve URL).
			// The local buildSlimWofDb path stays as a fallback for offline dev with playpen mounted.
			const hfVersion = `v${version}`
			const wofDest = resolve(staticDir, "wof-hot.db")
			if (!existsSync(wofDest)) {
				const fetched = await fetchArtifactFromHf("wof-hot.db", wofDest, { version: hfVersion })
				if (!fetched && !existsSync(wofDest)) buildSlimWofDb(wofDest, { repoRoot })
			}
			const polyDest = resolve(staticDir, "wof-polygons.db")
			if (!existsSync(polyDest)) {
				await fetchArtifactFromHf("wof-polygons.db", polyDest, { version: hfVersion })
			}

			// --- sql.js-httpvfs runtime assets (worker + wasm + UMD), for range-loading the DBs ---
			const sqljsDir = resolve(staticDir, "sqljs")
			mkdirSync(sqljsDir, { recursive: true })
			stageSqlJsHttpvfs(sqljsDir)

			// --- Report ---
			const assets = ["model.onnx", "tokenizer.model", "fst-en-US.bin", "wof-hot.db", "wof-polygons.db"]
			/** @type {Record<string, number>} */
			const manifest = {}
			for (const name of assets) {
				const p = resolve(staticDir, name)
				if (existsSync(p)) {
					manifest[name] = statSync(p).size
				}
			}

			console.log("[demo-assets] Staged assets:")
			for (const [name, size] of Object.entries(manifest)) {
				console.log(`  ${name}: ${(size / 1024 / 1024).toFixed(1)} MB`)
			}

			return { version, manifest }
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
