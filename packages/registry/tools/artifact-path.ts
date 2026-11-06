/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * Returns the module an artifact's bytes live in under `lib/artifacts/`, grouped by the dataset it reads.
 */
export function artifactModulePath(name: string): string {
	return name.replace(/^(iso3166-1|iata-airport)-/u, "$1/")
}
