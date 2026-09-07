/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `build.json`: the static deployment record a production smoke reads instead of a health endpoint. A site's build
 *   emits it (see `vite/build-info.ts`); the app and the smoke read it.
 */

export interface BuildInfo {
	/**
	 * The deployment's name: `mailwoman-earth`, `mailwoman-moon`, `mailwoman-mars`.
	 */
	app: string
	/**
	 * The short git revision the build was made from.
	 */
	revision: string
	/**
	 * ISO-8601 seconds, `Z` suffix.
	 */
	buildTime: string
}

export function renderBuildInfo(info: BuildInfo): string {
	return `${JSON.stringify(info, null, "\t")}\n`
}
