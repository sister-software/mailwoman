/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tree resolution over a browser-side place lookup.
 *
 *   This lived in the docs site (`docs/src/shared/`), which made it unreachable from the packages that
 *   need it: `hot-db.test.ts` here had to reach across a workspace boundary into a private Docusaurus
 *   app, dragging its React graph into a project that has no business type-checking it. Nothing in this
 *   file is docs-specific — it is the browser half of the same resolve cascade the node path runs.
 *
 *   The lookup is structural (`MailwomanLookupLike`) rather than a concrete class, so the demo's HTTPVFS
 *   lookup, the WASM lookup here, and any future one all satisfy it.
 */

import type { ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"
import { createWOFResolver } from "@mailwoman/resolver/resolve"

/**
 * One additional admin role a resolved place ALSO fulfils — the dual-role / city-state relation (#402). Berlin resolves
 * as a locality but `role: "region"` here surfaces that it is also a federal state. `relationshipType` is the
 * gazetteer-derived class (`city-state`, `capital-seat`, …).
 */
export interface DualRole {
	id: number
	name: string
	placetype: string
	relationshipType: string
	role: "region" | "locality"
}

export interface MailwomanLookupLike {
	findPlace: (q: {
		text: string
		/**
		 * Requested placetype(s). Widened from the demo's original locality/postalcode/region union for the #861
		 * shared-resolver convergence: `resolveTree` + its coherence passes also query `country`, `county`, and pass arrays
		 * (the placetype-equivalence groups).
		 */
		placetype?: string | string[] | undefined
		country?: string
		/**
		 * Point-in-bbox filter — constrains candidates to a parsed region/state's bounds.
		 */
		bbox?: { minLat: number; maxLat: number; minLon: number; maxLon: number }
		limit?: number
		postcode?: string
		/**
		 * Soft proximity hints (#938 — the demo's map viewport / user location). With bias present, exact-tier candidates
		 * near a hint sort ahead of distant ones; never a hard filter. Absent → population-first order.
		 */
		bias?: Array<{ lat: number; lon: number; weight?: number }>
	}) => Promise<
		Array<{
			id: number
			name: string
			placetype: string
			/**
			 * ISO country code of the resolved place — lets the cascade country-gate an ambiguous postcode.
			 */
			country?: string
			lat: number
			lon: number
			score: number
			/**
			 * True when the candidate's name, abbreviation, or an alias EXACTLY matched the query (vs a partial token match).
			 * The cascade accepts alias-exact hits ("New York City" → New York) the same way it accepts canonical-name
			 * matches.
			 */
			exactMatch?: boolean
			bbox?: { minLat: number; maxLat: number; minLon: number; maxLon: number }
		}>
	>
	/**
	 * Dual-role partner roles for a resolved place id (#402). Optional — absent on lookups built from a slim DB that
	 * predates the `coincident_roles` relation.
	 */
	coincidentRolesFor?: (placeID: number) => Promise<DualRole[]>
}

type CascadeHits = Awaited<ReturnType<MailwomanLookupLike["findPlace"]>>

/**
 * Soft proximity hints (#938 `bias[]`): ordered, weighted, never a hard filter.
 */
export type ResolveBias = Array<{ lat: number; lon: number; weight?: number }>

type LookupHit = Awaited<ReturnType<MailwomanLookupLike["findPlace"]>>[number]

type BBox = NonNullable<LookupHit["bbox"]>

/**
 * What the adapter remembers about every candidate it has surfaced, keyed by place id.
 */
interface CandidateMeta {
	bbox?: BBox
	country?: string
	placetype: string
}

/**
 * Minimal structural view of a decorated `AddressTree` node (decoupled from core's types).
 */
interface ResolvedTreeNode {
	source?: string
	sourceID?: string
	value?: unknown
	lat?: number
	lon?: number
	placeID?: string
	metadata?: Record<string, unknown>
	alternatives?: unknown[]
	children?: ResolvedTreeNode[]
}

/**
 * WOF hierarchy rank of a locality.
 */
const WOF_RANK_LOCALITY = 5

/**
 * WOF hierarchy rank of a region, one step up from a locality.
 */
const WOF_RANK_REGION = 4

/**
 * How the demo picks THE pin from a resolved tree: prefer the most address-precise resolved node. Same ordering the
 * eval harnesses use; `postalcode` outranks `locality` (the old cascade's "postcode first, most precise" tier), peers
 * of locality sit just below it.
 */
const PIN_RANK: Record<string, number> = {
	postalcode: 6,
	locality: 5,
	borough: 4,
	localadmin: 4,
	neighbourhood: 4,
	county: 3,
	macrocounty: 3,
	region: 2,
	macroregion: 2,
	country: 1,
}

export class CandidateResolverBackend implements ResolverBackend {
	readonly #lookup: MailwomanLookupLike
	readonly #meta = new Map<number, CandidateMeta>()

	constructor(lookup: MailwomanLookupLike) {
		this.#lookup = lookup
	}

	/**
	 * The memoized bbox/country/placetype of a previously returned candidate (for hit assembly).
	 */
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
			// #938: forward the proximity hints (map viewport / user location) so the candidate lookup
			// re-ranks the exact tier by nearness — dropped here, the demo's viewport bias was inert.
			bias: query.bias,
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

export async function runCascade(
	lookup: MailwomanLookupLike,
	tree: { roots: unknown[] },
	rawText: string,
	bias?: ResolveBias
): Promise<CascadeHits> {
	const usable = (cs: CascadeHits): CascadeHits => cs.filter((c) => !(c.lat === 0 && c.lon === 0))

	const backend = new CandidateResolverBackend(lookup)
	const resolver = createWOFResolver(backend as never)

	// adminCoherence is the point of the convergence (the passes the old cascade approximated);
	// spanRescore + hierarchyCompletion ride their shared defaults. No defaultCountry — the demo is
	// global by design (the placer/population ranking routes, never a hardcoded country).
	// bias (#938): the map viewport (and optional geolocation) as SOFT proximity hints — an in-view
	// namesake sorts ahead of a distant one at equal exact-tier, and no-bias stays byte-identical
	// (48026 → Fraser MI vs Russi IT, the rule the library gate pins). Omitted when empty.
	const resolved = (await resolver.resolveTree(tree as never, {
		adminCoherence: true,
		...(bias && bias.length ? { bias } : {}),
	})) as unknown as {
		roots: ResolvedTreeNode[]
	}

	// Collect every resolver-decorated node, best-pin first.
	const collected: Array<{ hit: CascadeHits[number]; rank: number }> = []
	const alternativesOf = new Map<number, CascadeHits>()

	const visit = (node: ResolvedTreeNode): void => {
		if (node.source === "resolver" && node.sourceID && typeof node.lat === "number" && typeof node.lon === "number") {
			const sep = node.sourceID.indexOf(":")
			const placetype = sep === -1 ? node.sourceID : node.sourceID.slice(0, sep)
			const id = Number(node.placeID?.replace(/^wof:/, "") ?? node.sourceID.slice(sep + 1))
			const meta = backend.metaFor(id)

			const hit: CascadeHits[number] = {
				id,
				name: String(node.metadata?.["resolver_name"] ?? node.value ?? ""),
				placetype,
				country: meta?.country,
				lat: node.lat,
				lon: node.lon,
				score: typeof node.metadata?.["resolver_score"] === "number" ? (node.metadata["resolver_score"] as number) : 0,
				exactMatch: true,
				bbox: meta?.bbox,
			}

			if (!(hit.lat === 0 && hit.lon === 0)) {
				collected.push({ hit, rank: PIN_RANK[placetype] ?? 0 })

				const alts = (node.alternatives as Array<Record<string, unknown>> | undefined) ?? []

				alternativesOf.set(
					id,
					usable(
						alts.map((a) => ({
							id: Number(a.id),
							name: String(a.name ?? ""),
							placetype: String(a.placetype ?? placetype),
							country: typeof a.country === "string" && a.country ? a.country : undefined,
							lat: Number(a.lat),
							lon: Number(a.lon),
							score: typeof a.score === "number" ? a.score : 0,
							exactMatch: a.exactMatch === true,
							bbox: backend.metaFor(Number(a.id))?.bbox,
						}))
					)
				)
			}
		}

		for (const child of node.children ?? []) {
			visit(child)
		}
	}

	for (const root of resolved.roots) {
		visit(root)
	}

	if (!collected.length) {
		// Nothing in the tree resolved (span-rescore included) — the old cascade's last resort.
		return usable(await lookup.findPlace({ text: rawText, limit: 5 }))
	}

	collected.sort((a, b) => b.rank - a.rank || b.hit.score - a.hit.score)

	// Cross-country postcode gate, carried over from the old cascade: an ambiguous INTERNATIONAL
	// postcode (10115 = Berlin DE and a New York US ZIP shape) must not out-pin the parsed city
	// across countries. When the top pin is a postcode whose country differs from the resolved
	// locality's, the locality wins the pin; the postcode stays in the list.
	const top = collected[0]!
	const localityEntry = collected.find((c) => c.rank === WOF_RANK_LOCALITY || c.rank === WOF_RANK_REGION)

	let pinOrder = collected

	if (
		top.hit.placetype === "postalcode" &&
		localityEntry &&
		top.hit.country &&
		localityEntry.hit.country &&
		top.hit.country !== localityEntry.hit.country
	) {
		pinOrder = [localityEntry, ...collected.filter((c) => c !== localityEntry)]
	}

	const seen = new Set<number>()
	const hits: CascadeHits = []

	for (const { hit } of pinOrder) {
		if (!seen.has(hit.id)) {
			seen.add(hit.id)
			hits.push(hit)
		}

		for (const alt of alternativesOf.get(hit.id) ?? []) {
			if (!seen.has(alt.id)) {
				seen.add(alt.id)
				hits.push(alt)
			}
		}
	}

	return hits
}
