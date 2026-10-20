/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The license and attribution of the `osm` adapter's rows.
 *
 *   These sit apart from the adapter so a reader of the license, such as the effective training manifest, does not
 *   import the adapter. The corpus build's code hash follows imports, and an import of the adapter would put every
 *   OSM edit into every source's hash.
 */

/**
 * OpenStreetMap's license.
 *
 * Its recorded obligations include share-alike, so a build run under
 * `LicensePolicy.ShareAlikeFree` refuses every row carrying it.
 */
export const OSM_LICENSE = "ODbL-1.0"

/**
 * The URL of the ODbL license text.
 */
export const OSM_LICENSE_URL = "https://opendatacommons.org/licenses/odbl/1-0/"

/**
 * The attribution OSM requires in redistributed data and derived works.
 *
 * A database built from OSM embeds it.
 * A model card holds it when OSM-derived rows reach the checkpoint.
 * The effective training manifest records those rows.
 */
export const OSM_ATTRIBUTION =
	"© OpenStreetMap contributors. Data licensed under the Open Database License (ODbL) 1.0 " +
	`(${OSM_LICENSE_URL}); see https://www.openstreetmap.org/copyright.`
