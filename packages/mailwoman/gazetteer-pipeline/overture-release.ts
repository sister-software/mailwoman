/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Does a pinned Overture release still exist?
 *
 *   Overture DELETES releases from the bucket on roughly a monthly window — a 2026-08-19 listing held two. Every build
 *   that reads Overture carries its own pin (divisions for admin, places for POI, addresses for the corpus ingest;
 *   independent on purpose, because bumping one is a new-vintage decision for that artifact alone), and each pin dies
 *   silently when its release is pruned.
 *
 *   The cost of finding out late is the reason this exists. The admin build reaches `fold-overture` only AFTER the WOF
 *   ingest, so a dead pin surfaced after 2.9 million records and ~30 minutes as `IO Error: No files found that match
 *   the pattern` — a message that reads like a network fault rather than an expired pin. The bucket listing answers in
 *   one request.
 *
 *   Anonymous HTTP against the public bucket, not the S3 SDK or DuckDB: this must be answerable before any heavy
 *   optional dependency loads and the same listing a human would check.
 */

import { APIClient } from "@mailwoman/core/api"

const BUCKET_URL = "https://overturemaps-us-west-2.s3.amazonaws.com"

/**
 * Releases currently in the bucket, oldest first.
 */
export async function listOvertureReleases(client?: APIClient): Promise<string[]> {
	const api =
		client ??
		new APIClient({
			displayName: "overture-release-listing",
			axios: { baseURL: BUCKET_URL, timeout: 30_000 },
		})

	const response = await api.fetch<string>({
		url: "/",
		params: { "list-type": 2, prefix: "release/", delimiter: "/" },
		responseType: "text",
	})

	return [...String(response.data).matchAll(/<Prefix>release\/([^<]+?)\/?<\/Prefix>/g)]
		.map((match) => match[1]!)
		.filter((release) => release.length > 0)
		.toSorted()
}

export interface ReleaseCheck {
	release: string
	present: boolean
	available: string[]
	/**
	 * `undefined` when the listing itself failed. An unreachable bucket is NOT evidence that a release was pruned, and a
	 * build must not refuse to start because the network blinked.
	 */
	reachable: boolean
	message: string
}

/**
 * Check one pin against the bucket.
 *
 * A failed listing reports `reachable: false` and `present: true` — deliberately permissive. This is a pre-flight whose
 * only job is to turn a 30-minute failure into an immediate one; letting it BLOCK a build on its own network trouble
 * would trade a slow failure for a spurious one.
 */
export async function checkOvertureRelease(release: string, client?: APIClient): Promise<ReleaseCheck> {
	let available: string[]

	try {
		available = await listOvertureReleases(client)
	} catch (error) {
		return {
			release,
			present: true,
			available: [],
			reachable: false,
			message: `could not list Overture releases (${(error as Error).message}) — proceeding, which is NOT confirmation that ${release} exists`,
		}
	}

	// An EMPTY listing is not an empty bucket. Overture has never held zero releases, so nothing-found means the query
	// was wrong or the response was not the listing — and the first version of this file proved the point by dropping
	// its own query parameters and then reporting a live pin as pruned. Zero is treated as no answer, never as absence.
	if (!available.length) {
		return {
			release,
			present: true,
			available,
			reachable: false,
			message: `Overture release listing came back EMPTY, which is not a bucket with no releases — proceeding, which is NOT confirmation that ${release} exists`,
		}
	}

	const present = available.includes(release)

	return {
		release,
		present,
		available,
		reachable: true,
		message: present
			? `Overture ${release} present (${available.length} release(s) in the bucket: ${available.join(", ")})`
			: `Overture ${release} has been PRUNED — the bucket holds ${available.join(", ")}. ` +
				`Bump the pin for this artifact and treat it as a new-vintage decision.`,
	}
}
