/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Stage sql.js-httpvfs's runtime files (the UMD, the worker, the wasm) into an app's public directory before Vite
 *   builds or serves, so the httpvfs readers find them at a same-origin path. The files are never bundled: the readers
 *   load them by URL at run time, and a worker script must be a real file on the origin that serves the page.
 */

import { stageSQLJSAssets } from "@mailwoman/resolver-wof-wasm/host-assets"
import { resolvePath } from "path-ts"
import type { Plugin } from "vite"

/**
 * @param destDir The directory to stage into, relative to Vite's root (the package directory), e.g. `public/sqljs`.
 */
export function stageSQLJSPlugin(destDir: string): Plugin {
	let root = ""

	return {
		name: "mailwoman-stage-sqljs",
		configResolved(config) {
			root = config.root
		},
		async buildStart() {
			if (!(await stageSQLJSAssets(resolvePath(root, destDir)))) {
				throw new Error("sql.js-httpvfs runtime files could not be staged")
			}
		},
	}
}
