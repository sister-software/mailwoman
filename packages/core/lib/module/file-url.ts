/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Converts between `file:` URLs and filesystem paths.
 */

import { fileURLToPath as nativeFileURLToPath, pathToFileURL as nativePathToFileURL } from "node:url"

import type { PathBuilderLike } from "path-ts"

/**
 * Converts a `file:` URL to a filesystem path.
 *
 * @throws {TypeError} When the URL is not a `file:` URL.
 */
export function fileURLToPath(url: string | URL): string {
	return nativeFileURLToPath(url)
}

/**
 * Converts a filesystem path to a `file:` URL, which a dynamic `import()` accepts for an absolute path.
 */
export function pathToFileURL(path: PathBuilderLike): URL {
	return nativePathToFileURL(path.toString())
}
