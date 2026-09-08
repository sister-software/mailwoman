// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
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
