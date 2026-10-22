/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   PLATEAU's hosted 3D Tiles building sets, and the selection of the ones a published map may draw.
 *
 *   `data/plateau-tilesets.json` lists one untextured LoD2 building tileset per municipal dataset, with the license
 *   its CKAN record states. `sdk/plateau-tilesets.run.ts` regenerates it from PLATEAU VIEW's catalog.
 */

/**
 * The license title of the PLATEAU datasets that the `jp-plateau-site-policy` decision covers.
 */
export const PLATEAU_SITE_POLICY_LICENSE = "PLATEAU Site Policy 「３．著作権について」に拠る"

/**
 * One municipality's untextured LoD2 building tileset.
 */
export interface PlateauTileset {
	/**
	 * The five-digit municipal code, such as `13101` for Chiyoda.
	 */
	cityCode: string
	city: string
	prefecture: string
	year: number
	/**
	 * The CKAN dataset name on geospatial.jp, such as `plateau-13101-chiyoda-ku-2025`.
	 */
	dataset: string
	/**
	 * The `license_title` of that CKAN record, or null when no record of that name was found.
	 */
	licenseTitle: string | null
	url: string
	/**
	 * The tileset root's extent as `[west, south, east, north]` in degrees.
	 */
	bounds: [number, number, number, number]
	/**
	 * The geoid height in meters at the center of `bounds`, from GSI's geoid model.
	 *
	 * PLATEAU writes building heights above the WGS84 ellipsoid.
	 * A map whose ground is at 0 m lowers the tileset by this value.
	 */
	geoidHeight: number
}

/**
 * The tilesets whose CKAN record states the elected PLATEAU site policy.
 */
export function electedPlateauTilesets(tilesets: readonly PlateauTileset[]): PlateauTileset[] {
	return tilesets.filter((tileset) => tileset.licenseTitle === PLATEAU_SITE_POLICY_LICENSE)
}

/**
 * The tilesets whose extent intersects `[west, south, east, north]`.
 */
export function plateauTilesetsInView(
	tilesets: readonly PlateauTileset[],
	[west, south, east, north]: readonly [number, number, number, number]
): PlateauTileset[] {
	return tilesets.filter(({ bounds: [w, s, e, n] }) => w <= east && e >= west && s <= north && n >= south)
}
