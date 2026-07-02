/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The #861 convergence seam: adapt the demo's byte-range candidate lookup
 *   (`MailwomanLookupLike`) to the shared resolver's `ResolverBackend` contract, so the browser
 *   runs the SAME `resolveTree` — greedy walk + admin/explicit-country coherence + span-rescore —
 *   the server runs, instead of the bespoke `runCascade` tier order that re-implemented (and
 *   silently trailed) the resolver's joint-consistency passes.
 *
 *   The one semantic gap this adapter bridges: `ResolverBackend.findPlace` scopes descendant
 *   lookups by `parentID` (the coherence passes' descent test), while the candidate table carries
 *   no parent/ancestry relation. The adapter translates a parent scope into the constraints the
 *   table CAN answer, from a memo of every candidate it has returned:
 *
 *   - parent is a **country** candidate → `country` filter (exact — the table's `country_id`).
 *   - parent carries a **bbox** (regions/counties do) → point-in-bbox filter — the same
 *     approximation the old cascade used for its region constraint, now applied inside the shared
 *     pass instead of beside it.
 *   - parent unknown / unbounded → return `[]`; the resolver's `parentFallback` then retries
 *     unscoped, so recall is never sacrificed to a scope the table can't express.
 *
 *   Everything else (placetype expansion, country filter, postcode-keyed postal-city aliasing,
 *   population-first ranking) is the lookup's own behavior, unchanged.
 */

import type { ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"

import type { MailwomanLookupLike } from "./resources.tsx"

type LookupHit = Awaited<ReturnType<MailwomanLookupLike["findPlace"]>>[number]
type BBox = NonNullable<LookupHit["bbox"]>

/** What the adapter remembers about every candidate it has surfaced, keyed by place id. */
interface CandidateMeta {
	bbox?: BBox
	country?: string
	placetype: string
}

export class CandidateResolverBackend implements ResolverBackend {
	readonly #lookup: MailwomanLookupLike
	readonly #meta = new Map<number, CandidateMeta>()

	constructor(lookup: MailwomanLookupLike) {
		this.#lookup = lookup
	}

	/** The memoized bbox/country/placetype of a previously returned candidate (for hit assembly). */
	metaFor(id: number): CandidateMeta | undefined {
		return this.#meta.get(id)
	}

	async findPlace(query: Parameters<ResolverBackend["findPlace"]>[0]): Promise<ResolvedPlace[]> {
		let bbox: BBox | undefined
		let country = query.country

		if (query.parentID !== undefined) {
			const parent = this.#meta.get(Number(query.parentID))

			// A parent the table can't scope by: answer "no descendants" and let the resolver's
			// parentFallback retry unscoped. Silent unscoped results here would defeat the descent test.
			if (!parent) return []

			if (parent.placetype === "country" && parent.country) {
				country = parent.country
			} else if (parent.bbox) {
				bbox = parent.bbox

				// A region's country still constrains — "Springfield under Georgia (US state)" must not
				// admit Georgian (GE) rows that happen to fall in the bbox overlap.
				country ??= parent.country
			} else if (parent.country) {
				country = parent.country
			} else {
				return []
			}
		}

		const hits = await this.#lookup.findPlace({
			text: query.text,
			placetype: query.placetype,
			country,
			bbox,
			postcode: query.postcode,
			limit: query.limit,
		})

		return hits.map((h) => {
			this.#meta.set(h.id, { bbox: h.bbox, country: h.country, placetype: h.placetype })

			return {
				id: h.id,
				name: h.name,
				placetype: h.placetype,
				lat: h.lat,
				lon: h.lon,
				score: h.score,
				// ResolvedPlace requires a country; "" is the honest unknown (matches no ISO code, so
				// the coherence passes treat it as un-scopable rather than accidentally matching).
				country: h.country ?? "",
				exactMatch: h.exactMatch,
			}
		})
	}
}
