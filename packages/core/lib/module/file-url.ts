// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Converts between `file:` URLs and filesystem paths.
 */

import { fileURLToPath as nativeFileURLToPath, pathToFileURL as nativePathToFileURL } from "node:url"

import type { PathBuilderLike } from "path-ts"

/**
 * Converts a `file:` URL to a filesystem path.
 *
 * @throws {TypeError} When the URL isn't a `file:` URL.
 */
export function fileURLToPath(url: string | URL): string {
	return nativeFileURLToPath(url)
}

/**
 * Converts a filesystem path to a `file:` URL for dynamic `import()` of an absolute path.
 */
export function pathToFileURL(path: PathBuilderLike): URL {
	return nativePathToFileURL(path.toString())
}
