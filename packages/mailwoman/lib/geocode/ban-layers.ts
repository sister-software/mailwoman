/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Opens the national open-register (BAN) rooftop extracts under the data root for the geocode session.
 */

import type { BANRegionDatabaseProvider } from "@mailwoman/ban/region-database-provider"
import { resolvePathBuilder, type PathBuilderLike } from "path-ts"

/**
 * Open the BAN extracts under `dataRoot`.
 *
 * A country with no built extract answers an empty bundle, and the session
 * moves on to the next national source.
 * `@mailwoman/ban` is a runtime dependency of this package, so a failure to load
 * it is a broken installation rather than an absent layer.
 *
 * The import stays dynamic so a parse-only command does not load the provider.
 *
 * @throws When the package fails to load, or when the provider cannot read the extract directory.
 */
export async function openBANRegionDatabases(dataRoot: PathBuilderLike): Promise<BANRegionDatabaseProvider> {
	const { BANRegionDatabaseProvider } = await import("@mailwoman/ban/region-database-provider")

	return BANRegionDatabaseProvider.create(resolvePathBuilder(dataRoot))
}
