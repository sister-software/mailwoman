/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Docusaurus demo asset staging and bundle-policy entry point.
 */

import { mkdirSync } from "node:fs"
import { resolve } from "node:path"

import type { LoadContext, Plugin } from "@docusaurus/types"

import { stagePairIndexes, stageSQLJSHTTPVFS } from "./artifacts.ts"
import { configureDemoWebpack } from "./webpack-policy.ts"

export default function demoAssetsPlugin(context: LoadContext): Plugin {
	const docsDir = context.siteDir
	const staticDir = resolve(docsDir, "static", "mailwoman")

	return {
		name: "demo-assets",

		async loadContent() {
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
			return configureDemoWebpack(config, isServer, docsDir)
		},
	}
}
