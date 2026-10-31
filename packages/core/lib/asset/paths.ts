/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Path builders for Mailwoman's platform-native application directories.
 *
 *   The builders read the typed environment and `path-ts`, so this module is for Node callers. A bundle that
 *   needs only a tileset name reads `asset-names.ts`, a module of string constants.
 */

import { createPathBuilderResolver, type PathBuilder } from "path-ts"
import type { $brand } from "zod"
// TODO: Move this to "path-ts/zod" once the resolver is fully typed
// import { createPathBuilderResolver } from "path-ts/zod"

import { $public } from "#env"

/**
 * Infer the brand type from a Zod-branded string.
 */
type InferZodBrand<T> = T extends string & $brand<infer U> ? U : T

/**
 * Create a custom path builder resolver with a branded Zod string.
 *
 * This is useful for creating higher-order path builders that are relative to a project root.
 */
function createZodPathBuilderResolver<
	T extends string,
	B = InferZodBrand<T>,
	S extends string = B extends string ? B : T,
>(input: () => T): PathBuilder<S> {
	return createPathBuilderResolver(input)
}

/**
 * The public URL to the tile server endpoint.
 */
export const publicTilesURL = createZodPathBuilderResolver(() => $public.MAILWOMAN_TILES_URL)

/**
 * The public assets URL.
 */
export const publicAssetsURL = createZodPathBuilderResolver(() => $public.MAILWOMAN_ASSETS_URL)
