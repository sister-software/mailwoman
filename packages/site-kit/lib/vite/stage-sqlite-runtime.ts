/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Stage the range worker and the sqlite-wasm runtime into an app's public directory before Vite builds or
 *   serves, so the httpvfs readers find them at a same-origin path. The files are never bundled: the readers
 *   load them by URL at run time. A worker script must be a real file on the origin that serves the page.
 */

import { stageSQLiteRuntimeAssets } from "@mailwoman/resolver-wof-wasm/host-assets"
import { resolvePath } from "path-ts"
import type { PathBuilderLike } from "path-ts"
import type { Plugin } from "vite"

/**
 * @param destDir The directory to stage into, relative to Vite's root
 * (the package directory), e.g. `public/sqlite`.
 */
export function stageSQLiteRuntimePlugin(destDir: PathBuilderLike): Plugin {
	let root = ""

	return {
		name: "mailwoman-stage-sqlite-runtime",
		configResolved(config) {
			root = config.root
		},
		async buildStart() {
			if (!(await stageSQLiteRuntimeAssets(resolvePath(root, destDir)))) {
				throw new Error("The range worker and sqlite-wasm runtime files could not be staged")
			}
		},
	}
}
