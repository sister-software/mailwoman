/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/ban` SDK — the Base Adresse Nationale ingestion surface. PERMISSIVE CODE ONLY: this
 *   workspace contains no BAN data bytes. It reads the open `adresses-<dept>.csv` dumps
 *   (adresse.data.gouv.fr) and writes a national FR rooftop address-point shard on the SHARED situs
 *   schema (`@mailwoman/resolver-wof-sqlite/address-point-schema`). BAN is published under the Licence
 *   Ouverte / Etalab (attribution, NO share-alike), so — unlike the ODbL OSM tier — the built shard
 *   ships under the same terms as the permissive core; only the per-row attribution obligation rides
 *   on it. See `ban/README.md` for the licensing boundary.
 */

export * from "./fetch.js"
export * from "./extract.js"
export * from "./street-locale.js"
export * from "./shard-provider.js"
