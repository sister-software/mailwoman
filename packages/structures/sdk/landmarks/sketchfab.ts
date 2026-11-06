// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Resolves a Sketchfab model page to the binary glTF its download endpoint signs.
 */

import { $private } from "#env"

/**
 * A Sketchfab model page, `https://sketchfab.com/3d-models/<slug>-<uid>`.
 * The 32-digit uid identifies the model.
 */
const SKETCHFAB_MODEL_PAGE = /^https:\/\/sketchfab\.com\/3d-models\/(?:[a-z0-9-]+-)?([0-9a-f]{32})$/

/**
 * The model uid in a Sketchfab model page URL, or `null` when the URL is another host's.
 */
export function sketchfabModelUID(sourceURL: string): string | null {
	return SKETCHFAB_MODEL_PAGE.exec(sourceURL)?.[1] ?? null
}

/**
 * The URL a converter fetches for a landmark's `sourceURL`.
 *
 * A Sketchfab model page resolves to the binary glTF that Sketchfab's download
 * endpoint signs for the `SKETCHFAB_API_KEY` account.
 * That signed URL expires, so the manifest records the page and each run resolves it.
 * Any other URL is returned as given.
 *
 * @throws When the URL is a Sketchfab page and the key is unset, the endpoint refuses,
 * or it offers no binary glTF.
 */
export async function resolveModelDownloadURL(
	sourceURL: string,
	apiKey: string | null = $private.SKETCHFAB_API_KEY ?? null
): Promise<string> {
	const uid = sketchfabModelUID(sourceURL)

	if (!uid) return sourceURL

	if (!apiKey) throw new Error(`${sourceURL} needs SKETCHFAB_API_KEY, because Sketchfab refuses anonymous downloads`)

	const response = await fetch(`https://api.sketchfab.com/v3/models/${uid}/download`, {
		headers: { Authorization: `Token ${apiKey}` },
	})

	if (!response.ok) throw new Error(`Sketchfab's download endpoint answered ${response.status} for ${sourceURL}`)

	const offers = (await response.json()) as { glb?: { url?: string } }
	const url = offers.glb?.url

	if (!url) throw new Error(`Sketchfab offers no binary glTF for ${sourceURL}`)

	return url
}
