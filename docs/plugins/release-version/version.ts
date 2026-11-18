// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Reads the release version the docs substitute into install and run instructions.
 *
 *   Every workspace in `.release-it.json` publishes at one synced version, so the `mailwoman`
 *   manifest's `version` is the version of every package an instruction installs.
 *   Between the merge of a release's version-bump PR and the publish that follows it,
 *   this version is ahead of npm.
 */

import { readPackageJSON } from "@mailwoman/core/module/resolve-from"

/**
 * The substitution values a `{{release.<key>}}` token can refer to.
 */
export interface ReleaseValues {
	/**
	 * The synced release version, such as `11.1.0`.
	 */
	version: string
}

let pending: Promise<ReleaseValues> | undefined

/**
 * Reads the release values once per build.
 *
 * @throws When the `mailwoman` manifest has no string `version`.
 */
export function readReleaseValues(): Promise<ReleaseValues> {
	pending ??= readPackageJSON(import.meta.url, "mailwoman").then((manifest) => {
		if (typeof manifest.version !== "string" || !manifest.version) {
			throw new Error("The mailwoman package.json has no version to substitute into the docs")
		}

		return { version: manifest.version }
	})

	return pending
}
