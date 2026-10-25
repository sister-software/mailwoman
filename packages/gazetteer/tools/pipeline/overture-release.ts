/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Does a pinned Overture release still exist?
 *
 * Overture deletes releases from the bucket on roughly a monthly window. Every build that reads
 * Overture uses its own pin, so each pin dies silently when its release is pruned. The cost of
 * finding out late is why this exists: the admin build reaches `fold-overture` only after the WOF
 * ingest, so a dead pin surfaced after ~30 minutes as an `IO Error` that reads like a network fault.
 *
 * Anonymous http against the public bucket rather than the S3 SDK or DuckDB, so this is answerable
 * before any heavy optional dependency loads and is the same listing a human would check.
 */

import { APIClient } from "@mailwoman/core/api"
import { elementText, elementTexts } from "@mailwoman/core/html/document"

const BUCKET_URL = "https://overturemaps-us-west-2.s3.amazonaws.com"

/**
 * What this function needs from an http client: one `fetch`.
 *
 * Narrower than {@link APIClient} on purpose.
 * A parameter shaped like the whole client makes a test double an assertion instead of an object.
 *
 * That assertion can survive a signature change the double does not.
 */
export interface OvertureListingClient {
	fetch(request: {
		url: string
		params?: Record<string, string | number>
		responseType?: string
	}): Promise<{ data: unknown }>
}

/**
 * S3 returns at most 1,000 keys per `ListObjectsV2` response and reports the truncation in `IsTruncated`.
 *
 * A reader that only matches `<Prefix>` cannot see that field.
 * A truncated first page then reads as the whole bucket, so every later release appears pruned.
 * This module exists to answer that question correctly.
 */
const LISTING_PAGE_LIMIT = 100

export async function listOvertureReleases(client?: OvertureListingClient): Promise<string[]> {
	const api =
		client ??
		new APIClient({
			displayName: "overture-release-listing",
			axios: { baseURL: BUCKET_URL, timeout: 30_000 },
		})

	const releases: string[] = []
	let continuationToken: string | null = null

	for (let page = 0; page < LISTING_PAGE_LIMIT; page++) {
		const response: { data: unknown } = await api.fetch<string>({
			url: "/",
			params: {
				"list-type": 2,
				prefix: "release/",
				delimiter: "/",
				...(continuationToken ? { "continuation-token": continuationToken } : {}),
			},
			responseType: "text",
		})

		const body = String(response.data)

		// Every `<Prefix>` element includes the request echo `<Prefix>release/</Prefix>`
		// beside the `<CommonPrefixes>` entries.
		// The echo reduces to an empty name and is dropped with any other.
		for (const prefix of elementTexts(body, "Prefix", { xml: true })) {
			const release = prefix.replace(/^release\//, "").replace(/\/$/, "")

			if (release) {
				releases.push(release)
			}
		}

		if (elementText(body, "IsTruncated", { xml: true })?.trim() !== "true") {
			return releases.toSorted()
		}

		continuationToken = elementText(body, "NextContinuationToken", { xml: true })?.trim() ?? null

		if (!continuationToken) {
			throw new Error(
				"overture release listing: the bucket reported IsTruncated with no NextContinuationToken, so the remaining releases cannot be read — a short list here would read as a pruned release"
			)
		}
	}

	throw new Error(
		`overture release listing: still truncated after ${LISTING_PAGE_LIMIT} pages (${releases.length} releases read) — refusing to report a partial list as the bucket's contents`
	)
}

export interface ReleaseCheck {
	release: string
	present: boolean
	available: string[]
	/**
	 * `undefined` when the listing itself failed.
	 *
	 * An unreachable bucket does not show that a release was pruned.
	 * A build must not refuse to start because the network blinked.
	 */
	reachable: boolean
	message: string
}

/**
 * Check one pin against the bucket.
 *
 * A failed listing reports `reachable: false` and `present: true` — deliberately permissive.
 * This is a pre-flight whose only job is to turn a 30-minute failure into an immediate one.
 *
 * A build should not block on a network failure from this check.
 * That would trade a slow failure for a spurious one.
 */
export async function checkOvertureRelease(release: string, client?: OvertureListingClient): Promise<ReleaseCheck> {
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

	// An empty listing is not an empty bucket — Overture has never held zero releases —
	// so zero is treated as no answer, never as absence.
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
