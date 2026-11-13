// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The `publiccode.yml` version bump as a textual replacement of two lines.
 *
 *   The file is hand-written YAML whose comments and key order a parse-then-dump write would lose.
 *   A release bump edits exactly `softwareVersion` and `releaseDate`, and it refuses
 *   a file in which it can't find each of them once.
 */

const SOFTWARE_VERSION_LINE = /^softwareVersion: "([^"]*)"$/mu
const RELEASE_DATE_LINE = /^releaseDate: "\d{4}-\d{2}-\d{2}"$/mu

/**
 * Set `softwareVersion` to `targetVersion` and `releaseDate` to `releaseDate`, a `YYYY-MM-DD` date.
 *
 * @throws When either line is absent or repeated, or when `softwareVersion` isn't `currentVersion`.
 */
export function bumpPublicCodeVersion(
	text: string,
	currentVersion: string,
	targetVersion: string,
	releaseDate: string
): string {
	for (const line of [SOFTWARE_VERSION_LINE, RELEASE_DATE_LINE]) {
		const matches = text.match(new RegExp(line.source, "gmu"))?.length ?? 0

		if (matches !== 1) {
			throw new Error(
				`publiccode.yml has ${matches} lines matching ${line.source}; the bump edits exactly one. ` +
					`Fix the file's formatting, or bump it by hand.`
			)
		}
	}

	const recorded = SOFTWARE_VERSION_LINE.exec(text)![1]

	if (recorded !== currentVersion) {
		throw new Error(
			`publiccode.yml's softwareVersion is ${recorded} but the root is at ${currentVersion}. ` +
				`The tree is not version-synced, so the bump refuses to write on top of it.`
		)
	}

	return text
		.replace(SOFTWARE_VERSION_LINE, `softwareVersion: "${targetVersion}"`)
		.replace(RELEASE_DATE_LINE, `releaseDate: "${releaseDate}"`)
}
