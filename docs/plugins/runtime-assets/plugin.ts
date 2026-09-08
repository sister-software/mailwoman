/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Docusaurus runtime-asset staging and bundle-policy entry point: the sql.js worker the explainers resolve
 *   through, the MapLibre worker the dashboard map spawns, and the webpack aliases and shim policy for the packages
 *   the explainers import.
 */

import type { LoadContext, Plugin } from "@docusaurus/types"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { stageSQLJSAssets } from "@mailwoman/resolver-wof-wasm/host-assets"
import { resolvePath } from "path-ts"

import { stageMapLibreWorker } from "./artifacts.ts"
import { bundleAliases, configureRuntimeWebpack } from "./webpack-policy.ts"

export default async function runtimeAssetsPlugin(context: LoadContext): Promise<Plugin> {
	const docsDir = context.siteDir
	const staticDir = resolvePath(docsDir, "static", "mailwoman")

	// Both arms are resolved here, where awaiting is legal, because `configureWebpack` below is called synchronously and
	// only learns which one it needs at that moment.
	const aliases = {
		client: await bundleAliases(false),
		server: await bundleAliases(true),
	}

	return {
		name: "runtime-assets",

		async loadContent() {
			await makeDirectories(staticDir)
			const sqljsDir = resolvePath(staticDir, "sqljs")
			await makeDirectories(sqljsDir)
			await stageSQLJSAssets(sqljsDir)
			const maplibreDir = resolvePath(staticDir, "maplibre")
			await makeDirectories(maplibreDir)
			await stageMapLibreWorker(maplibreDir)

			return {}
		},

		async contentLoaded({ content, actions }) {
			actions.setGlobalData(content)
		},

		configureWebpack(config, isServer) {
			return configureRuntimeWebpack(config, isServer ? aliases.server : aliases.client, isServer)
		},
	}
}
