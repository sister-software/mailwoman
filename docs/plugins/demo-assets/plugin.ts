/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Docusaurus demo asset staging and bundle-policy entry point.
 */

import type { LoadContext, Plugin } from "@docusaurus/types"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { resolvePath } from "path-ts"

import { stagePairIndexes, stageSQLJSHTTPVFS } from "./artifacts.ts"
import { bundleAliases, configureDemoWebpack } from "./webpack-policy.ts"

export default async function demoAssetsPlugin(context: LoadContext): Promise<Plugin> {
	const docsDir = context.siteDir
	const staticDir = resolvePath(docsDir, "static", "mailwoman")
	const emptyShim = resolvePath(docsDir, "src", "empty-shim.js")

	// Both arms are resolved here, where awaiting is legal, because `configureWebpack` below is called synchronously and
	// only learns which one it needs at that moment.
	const aliases = {
		client: await bundleAliases(false, emptyShim),
		server: await bundleAliases(true, emptyShim),
	}

	return {
		name: "demo-assets",

		async loadContent() {
			await makeDirectories(staticDir)
			const sqljsDir = resolvePath(staticDir, "sqljs")
			await makeDirectories(sqljsDir)
			await stageSQLJSHTTPVFS(sqljsDir)
			const pairIndexDir = resolvePath(staticDir, "pair-index")
			await makeDirectories(pairIndexDir)
			await stagePairIndexes(pairIndexDir)

			return {}
		},

		async contentLoaded({ content, actions }) {
			actions.setGlobalData(content)
		},

		configureWebpack(config, isServer) {
			return configureDemoWebpack(config, docsDir, isServer ? aliases.server : aliases.client, isServer)
		},
	}
}
