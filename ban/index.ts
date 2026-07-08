/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/ban` — Base Adresse Nationale (France) rooftop address-point ingestion. The FR
 *   counterpart of the 50-state US situs layer (#1012): the national government address register (26M
 *   addresses) that closes the rooftop gap OSM-FR (~1.1M points) can't. PERMISSIVE CODE ONLY — this
 *   workspace contains no BAN data bytes. It reads the open `adresses-<dept>.csv` dumps
 *   (adresse.data.gouv.fr, Licence Ouverte/Etalab) and writes a national FR shard on the SHARED situs
 *   schema (`@mailwoman/resolver-wof-sqlite/address-point-schema`), so the existing
 *   `AddressPointSqliteLookup` reads it with zero changes. See `./sdk` for the ingestion surface and
 *   `./scripts/build-address-point-shard` for the build CLI.
 */

export * from "./sdk/index.js"
