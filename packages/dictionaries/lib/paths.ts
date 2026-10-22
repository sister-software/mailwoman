/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Resolvers for the files under this package's `data/` directory. They resolve through the package's own
 *   `package.json`, so a checkout and an npm install return the same layout.
 */

import { resolvePackagePathFrom } from "@mailwoman/core/module/resolve-from"
import { PathBuilder } from "path-ts"

/**
 * A data family that keeps its tables under a `dictionaries/` subdirectory.
 */
export type DictionaryResource = "libpostal" | "internal"

/**
 * The directory of this package's `data/` tree, or a path beneath it.
 */
export function dictionariesDataPath(...pathSegments: string[]): PathBuilder {
	return PathBuilder.from(resolvePackagePathFrom(import.meta.url, "@mailwoman/dictionaries", "data", ...pathSegments))
}

/**
 * A path under a resource's `dictionaries/` subdirectory, such as `libpostal/dictionaries/en/stopwords.txt`.
 */
export function resourceDictionaryPathBuilder(resource: DictionaryResource, ...pathSegments: string[]): PathBuilder {
	return dictionariesDataPath(resource, "dictionaries", ...pathSegments)
}

/**
 * The absolute-path string of {@link resourceDictionaryPathBuilder}.
 */
export function resourceDictionaryPath(resource: DictionaryResource, ...pathSegments: string[]): string {
	return resourceDictionaryPathBuilder(resource, ...pathSegments).toString()
}

/**
 * The directory of Google libaddressinput's per-country address metadata, one `<CC>.json` per country.
 */
export function sslAddressSpecsPath(): PathBuilder {
	return dictionariesDataPath("chromium-i18n", "ssl-address")
}
