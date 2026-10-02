/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Docusaurus runtime-asset staging and bundle-policy entry point: the SQLite range worker the explainers
 *   resolve through. It also registers the MapLibre worker that the dashboard map spawns. The plugin configures webpack aliases
 *   and shims for packages the explainers import. It exposes the published data-bundle summary as page-global data.
 */

import type { LoadContext, Plugin } from "@docusaurus/types"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { stageSQLiteRuntimeAssets } from "@mailwoman/resolver-wof-wasm/host-assets"
import { resolvePath } from "path-ts"

import { stageMapLibreWorker } from "./artifacts.ts"
import { type RuntimeAssetsGlobalData, summarizePublishedBundles } from "./bundles.ts"
import { bundleAliases, configureRuntimeWebpack } from "./webpack-policy.ts"

export default async function runtimeAssetsPlugin(context: LoadContext): Promise<Plugin<RuntimeAssetsGlobalData>> {
	const docsDir = context.siteDir
	const staticDir = resolvePath(docsDir, "static", "mailwoman")

	// Both arms are resolved here, where awaiting is legal, because `configureWebpack`
	// below is called synchronously and only learns which one it needs at that moment.
	const aliases = {
		client: await bundleAliases(false),
		server: await bundleAliases(true),
	}

	return {
		name: "runtime-assets",

		async loadContent() {
			await makeDirectories(staticDir)
			const sqliteDir = resolvePath(staticDir, "sqlite")
			await makeDirectories(sqliteDir)
			await stageSQLiteRuntimeAssets(sqliteDir)
			const maplibreDir = resolvePath(staticDir, "maplibre")
			await makeDirectories(maplibreDir)
			await stageMapLibreWorker(maplibreDir)

			return summarizePublishedBundles()
		},

		async contentLoaded({ content, actions }) {
			actions.setGlobalData(content)
		},

		configureWebpack(config, isServer) {
			return configureRuntimeWebpack(config, isServer ? aliases.server : aliases.client, isServer)
		},
	}
}
