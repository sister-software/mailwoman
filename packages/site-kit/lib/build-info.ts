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
	 * The same revision, full length. Kept BESIDE `revision` rather than replacing it: a production smoke already reads
	 * `revision` and compares it against a short form, and a commit URL wants the whole thing.
	 */
	commit: string
	/**
	 * ISO-8601 seconds, `Z` suffix.
	 */
	buildTime: string
}

/**
 * `https://github.com/sister-software/mailwoman/commit/<sha>` for a build's own revision.
 *
 * Takes the sha rather than the record so it IS the `commitHref` shape `@mailwoman/react`'s `<AppIdentity>` asks for —
 * that prop is injected because `@mailwoman/react` publishes to npm and this package is private, and when the argument
 * was the record instead, both apps wrapped this function in the same one-line adapter.
 */
export function commitURL(commit: BuildInfo["commit"]): string {
	return `https://github.com/sister-software/mailwoman/commit/${commit}`
}

export function renderBuildInfo(info: BuildInfo): string {
	return `${JSON.stringify(info, null, "\t")}\n`
}
