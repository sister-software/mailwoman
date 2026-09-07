/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The per-locale releases manifest: the version pointer beside the versioned asset directories, and the one place
 *   its wire keys are read. Every spelling a published manifest has ever carried stays readable here, because a wire
 *   key is a string contract and a reader that drops one turns a release's gazetteer off with no error.
 */

import { DEFAULT_LOCALE } from "#browser-runtime/classify"
import { releasesManifestURL } from "#browser-runtime/resources"

export interface ReleaseInfo {
	version: string
	label: string
	description: string
	modelSize: string
	tokenizerVocab: number
	steps: number
	hasFST: boolean
	hasWOFDB: boolean
	hasAnchor?: boolean
	hasPolygons?: boolean
}

export interface ReleasesManifest {
	locale: string
	defaultVersion: string
	releases: ReleaseInfo[]
}

/**
 * The raw wire shape of one releases.json entry — either key generation may appear.
 */
export interface WireReleaseEntry extends Omit<ReleaseInfo, "hasFST" | "hasWOFDB"> {
	hasFST?: boolean
	hasWOFDB?: boolean
	/**
	 * Pre-2026-07-04 manifests published lowercase-acronym keys.
	 *
	 * @deprecated use `hasFST` instead
	 */
	// oxlint-disable-next-line sister-software/no-title-case-acronym -- legacy wire key published before whole-acronym casing
	hasFst?: boolean
	/**
	 * Pre-2026-07-04 manifests published lowercase-acronym keys.
	 *
	 * @deprecated use `hasWOFDB` instead
	 */
	// oxlint-disable-next-line sister-software/no-title-case-acronym -- legacy wire key published before whole-acronym casing
	hasWofDb?: boolean
	/**
	 * The spelling the LIVE 2026-08-11 manifest actually carries (WOF caps, lowercase b) — a wire key is a string
	 * contract, and every spelling ever published must stay readable here.
	 */
	hasWOFDb?: boolean
}

/**
 * The raw wire shape of a fetched releases.json.
 */
export interface WireReleasesManifest {
	locale: string
	defaultVersion: string
	releases: WireReleaseEntry[]
}

/**
 * Normalize a fetched releases.json into house-cased {@link ReleasesManifest} fields. ALL manifest consumption goes
 * through here — the wire tolerance lives in exactly one place, and everything past this boundary uses the acronym
 * convention (`hasFST` / `hasWOFDB`).
 *
 * Why the tolerance: the 2026-07-01 acronym sweep renamed the READS while the published R2 manifest kept the old keys —
 * every release read `undefined`, silently disabling the demo's WOF cascade AND the FST for three days (zero console
 * errors; "no WOF hits" was the only symptom). The fix is not to freeze the wire keys but to migrate them deliberately:
 * the publisher now writes house-cased keys, this normalizer accepts both generations (old HF mirrors still carry the
 * legacy keys), and the contract test pins all three parties.
 */
export function normalizeReleasesManifest(raw: WireReleasesManifest): ReleasesManifest {
	return {
		locale: raw.locale,
		defaultVersion: raw.defaultVersion,
		releases: raw.releases.map((r) => ({
			...r,
			hasFST: r.hasFST ?? r.hasFst ?? false,
			// The 2026-08-11 v9.1.0 manifest (live until the next model release) writes `hasWOFDb` — WOF caps,
			// lowercase b. The 08-14 casing sweep renamed reader AND writer to `hasWOFDB` but missed this third
			// live spelling, which turned the demo's whole WOF cascade off silently for four days.
			hasWOFDB: r.hasWOFDB ?? r.hasWOFDb ?? r.hasWofDb ?? false,
		})),
	}
}

/**
 * Fetch + normalize the demo's releases manifest. `cache: "reload"` bypasses the (immutable-Cache-Control) HTTP cache
 * for the version pointer so a returning visitor sees a `defaultVersion` bump.
 */
export async function fetchReleasesManifest(): Promise<ReleasesManifest | null> {
	const res = await fetch(releasesManifestURL(DEFAULT_LOCALE), { cache: "reload" })

	return res.ok ? normalizeReleasesManifest((await res.json()) as WireReleasesManifest) : null
}
