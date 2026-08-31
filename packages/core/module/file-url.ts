/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Conversion between `file:` URLs and filesystem paths — what `import.meta.resolve` answers with, and what a dynamic
 *   `import()` of a path wants. `import.meta.dirname` and `import.meta.filename` cover a module's own location, so
 *   these are for a URL that names SOMETHING ELSE: a resolved specifier, a sibling computed from one.
 */

import { fileURLToPath as nativeFileURLToPath, pathToFileURL as nativePathToFileURL } from "node:url"

import type { PathBuilderLike } from "path-ts"

/**
 * The filesystem path a `file:` URL names.
 *
 * @throws {TypeError} When the URL is not a `file:` URL.
 */
export function fileURLToPath(url: string | URL): string {
	return nativeFileURLToPath(url)
}

/**
 * The `file:` URL that names a filesystem path — the form a dynamic `import()` accepts for an absolute path.
 */
export function pathToFileURL(path: PathBuilderLike): URL {
	return nativePathToFileURL(path.toString())
}
