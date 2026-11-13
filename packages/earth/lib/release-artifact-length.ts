// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The byte length a release manifest records for a release file, as the service worker's
 *   torn-body check reads it.
 *
 *   An origin that serves a release file without `Content-Length` leaves the check without a
 *   length of its own.
 *   The manifest's `artifacts` table then supplies the length the file must have.
 */

import type { ExpectedLengthLookup } from "@mailwoman/service-worker-cache/torn-body"
import { expectedArtifactLength, readArtifactIntegrityTable } from "mailwoman/browser-runtime/integrity"

/**
 * A release file's path: `…/<locale>/<version>/<file>`, with `releases.json` in the locale directory.
 */
const RELEASE_FILE_PATH = /^(?<locale>.*\/)(?<version>[^/]+)\/(?<file>[^/]+)$/u

/**
 * Where one release file sits: the locale's manifest URL, the release version and the file name.
 */
export interface ReleaseFileLocation {
	manifestURL: string
	version: string
	file: string
}

/**
 * The manifest URL, version and file name of a URL in the `<locale>/<version>/<file>`
 * layout, or `null` for a shorter path.
 */
export function releaseFileLocation(url: URL): ReleaseFileLocation | null {
	const match = RELEASE_FILE_PATH.exec(url.pathname)
	const groups = match?.groups

	if (!groups?.["locale"] || !groups["version"] || !groups["file"]) return null

	return {
		manifestURL: `${url.origin}${groups["locale"]}releases.json`,
		version: groups["version"],
		file: groups["file"],
	}
}

/**
 * A torn-body length lookup over the release manifests `readManifest` answers.
 *
 * `readManifest` returns the parsed `releases.json` at a URL, or `null` when none is available.
 * The service worker reads the copy its manifest cache holds.
 *
 * The page fetches that manifest before it requests any release file.
 *
 * The lookup answers `null`, and the plugin then stores the response unchecked,
 * when the URL isn't a release file or its manifest, release or record is absent.
 * A malformed `artifacts` table also answers `null`, with a console warning naming the release.
 *
 * The page's own manifest parser refuses that table, so the page reports the failure.
 */
export function createReleaseArtifactLengthLookup(
	readManifest: (url: string) => Promise<unknown>
): ExpectedLengthLookup {
	return async (request) => {
		const location = releaseFileLocation(new URL(request.url))

		if (!location) return null

		const manifest = await readManifest(location.manifestURL)
		const releases = (manifest as { releases?: unknown } | null)?.releases

		if (!Array.isArray(releases)) return null

		const entry: unknown = releases.find(
			(release: unknown) => (release as { version?: unknown } | null)?.version === location.version
		)

		if (typeof entry !== "object" || entry === null) return null

		try {
			const artifacts = readArtifactIntegrityTable((entry as { artifacts?: unknown }).artifacts, location.version)

			return expectedArtifactLength({ artifacts }, location.file)
		} catch (error) {
			console.warn(`[service-worker] ${location.manifestURL}: ${String(error)}; ${location.file} is stored unchecked`)

			return null
		}
	}
}
