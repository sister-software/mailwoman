/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { WorkerRoute } from "../routing.ts"
import { TileMetadataRoute, TileRoute } from "./tile.ts"

//#region Tile Retrieval

/** Serves a per-provider broadband tile, keyed by provider, state and tile set. */
export const BroadbandProviderTileRoute = WorkerRoute.GET(
	"/providers/:providerID(\\d+)/:stateCode(\\d+)/:tileSetName([a-z0-9_\\-]+)/:z(\\d+)/:x(\\d+)/:y(\\d+).:fileExtension([a-z0-9]+)",
	async ({ params, ...context }) => {
		const { providerID, stateCode, tileSetName } = params

		return TileRoute.handler({
			...context,
			params: {
				...params,
				tileSetName: `providers/${providerID}/${stateCode}/${tileSetName}`,
			},
		})
	}
)

//#endregion

//#region Metadata Lookup

/** Serves TileJSON metadata for a per-provider broadband tile set. */
export const BroadbandProviderTileMetadataRoute = WorkerRoute.GET(
	"/providers/:providerID(\\d+)/:stateCode(\\d+)/:tileSetName([a-z0-9_\\-]+).json",
	async ({ params, ...context }) => {
		const { providerID, stateCode, tileSetName } = params

		return TileMetadataRoute.handler({
			...context,
			params: {
				...params,
				tileSetName: `providers/${providerID}/${stateCode}/${tileSetName}`,
			},
		})
	}
)

//#endregion
