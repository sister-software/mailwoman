/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   An open-source declaration gives a public source URL. On each re-issuance the worker reads the repository's license
 *   file and records whether it found an AGPL-compatible license. The reading is a record for the operator and never
 *   decides the token: an unverified declaration stays valid.
 */

import type { SourceVerification } from "#ledger/schema"

/**
 * The text an AGPL-compatible license file contains, one entry per license family.
 * A match on any entry verifies.
 */
const COMPATIBLE_LICENSE_MARKS = [
	"GNU AFFERO GENERAL PUBLIC LICENSE",
	"GNU GENERAL PUBLIC LICENSE",
	"GNU LESSER GENERAL PUBLIC LICENSE",
	"Apache License",
	"MIT License",
	"Mozilla Public License",
	"BSD",
] as const

const GITHUB_REPOSITORY = /^https:\/\/github\.com\/(?<owner>[^/]+)\/(?<repo>[^/#?]+)/u

/**
 * The URLs to read for a source URL's license file, in order.
 *
 * A GitHub repository reads `LICENSE` and then `LICENSE.md` from the raw host at `HEAD`.
 * Any other URL reads `LICENSE` beside it.
 */
export function licenseFileCandidates(url: string): string[] {
	const github = GITHUB_REPOSITORY.exec(url)

	if (github?.groups) {
		const owner = github.groups["owner"]
		const repo = github.groups["repo"]?.replace(/\.git$/u, "")
		const base = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/`

		return [`${base}LICENSE`, `${base}LICENSE.md`]
	}

	return [`${url.replace(/\/+$/u, "")}/LICENSE`]
}

/**
 * Whether a license file at the declared source URL names an AGPL-compatible license.
 *
 * A fetch failure, a response outside the 200 range, and a body that matches no entry all read `unverified`.
 */
export async function verifySourceURL(fetchImpl: typeof fetch, url: string): Promise<SourceVerification> {
	for (const candidate of licenseFileCandidates(url)) {
		let response: Response

		try {
			response = await fetchImpl(candidate)
		} catch {
			return "unverified"
		}

		if (!response.ok) continue

		const body = await response.text()

		if (COMPATIBLE_LICENSE_MARKS.some((mark) => body.includes(mark))) return "verified"
	}

	return "unverified"
}
