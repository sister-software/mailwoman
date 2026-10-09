/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Writes the search index into the built site: one record per heading-scoped section and per
 *   reference-table row of every built page, in a gzip-compressed SQLite file the browser opens whole.
 */

import type { LoadContext, Plugin } from "@docusaurus/types"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import type { SearchRecord } from "@mailwoman/react/search/types"
import { resolvePath } from "path-ts"

import { SEARCH_INDEX_FILENAME } from "../../src/search/constants.ts"

/**
 * Docusaurus loads this file through jiti.
 * That loader cannot resolve `node:sqlite` or parse `using`.
 *
 * The extractor and the writer load through the runtime's own module loader instead.
 * `process.getBuiltinModule` keeps jiti from rewriting the lookup of `node:module`.
 */
const { createRequire } = process.getBuiltinModule("node:module")

export default function searchIndexPlugin(context: LoadContext): Plugin {
	return {
		name: "search-index",

		async postBuild({ outDir, routesPaths }) {
			const nativeRequire = createRequire(resolvePath(context.siteDir, "package.json").toString())

			const { extractRecords, isIndexedRoute } = nativeRequire(
				"./plugins/search-index/extract.ts"
			) as typeof import("./extract.ts")

			const { writeSearchIndex } = nativeRequire(
				"./plugins/search-index/write-index.ts"
			) as typeof import("./write-index.ts")

			const records: SearchRecord[] = []
			let pages = 0

			for (const route of routesPaths) {
				if (!isIndexedRoute(route)) continue

				// `trailingSlash: false` emits `<route>.html`, and the root route `index.html`.
				const file = resolvePath(outDir, route === "/" ? "index.html" : `${route.replace(/^\//, "")}.html`)

				records.push(...extractRecords(await readLocalTextFile(file), route))

				pages++
			}

			const report = await writeSearchIndex(records, resolvePath(outDir, SEARCH_INDEX_FILENAME), {
				commit: String(context.siteConfig.customFields?.buildCommit ?? ""),
				builtAt: new Date().toISOString(),
			})

			console.log(
				`search-index: ${records.length} records from ${pages} pages, ${ByteFormatter.formatIEC(report.bytes)} raw, ${ByteFormatter.formatIEC(report.gzipBytes)} gzip`
			)
		},
	}
}
