/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tree resolution over a browser-side place lookup, with the lookup kept structural (`MailwomanLookupLike`).
 */

import { areaPostcodeLeadsLocality, isUnitGradePostcodeHit } from "@mailwoman/codex"
import type { AddressTree } from "@mailwoman/core/decoder/types"
import { EMPTY_PLACE_FIELDS, type ResolvedPlace, type ResolverBackend } from "@mailwoman/core/resolver"
import { createWOFResolver } from "@mailwoman/resolver/resolve"

/**
 * One additional admin role a resolved place also fulfills, such as Berlin's
 * federal-state role beside its locality role.
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
		 * Requested placetype(s); arrays express the placetype-equivalence groups.
		 */
		placetype?: string | string[] | undefined
		country?: string
		/**
		 * Constrains candidates to a parsed region/state's bounds.
		 */
		bbox?: { minLat: number; maxLat: number; minLon: number; maxLon: number }
		limit?: number
		postcode?: string
		/**
		 * Soft proximity hints that re-rank exact-tier candidates by nearness,
		 * never a hard filter, with population-first order when absent.
		 */
		bias?: Array<{ lat: number; lon: number; weight?: number }>
	}) => Promise<
		Array<{
			id: number
			name: string
			placetype: string
			/**
			 * ISO country code of the resolved place, used to country-restrict an ambiguous postcode.
			 */
			country?: string
			lat: number
			lon: number
			score: number
			/**
			 * True when the candidate's name, abbreviation, or an alias exactly matched
			 * the query rather than partially.
			 */
			exactMatch?: boolean
			bbox?: { minLat: number; maxLat: number; minLon: number; maxLon: number }
		}>
	>
	/**
	 * Dual-role partner roles for a resolved place id.
	 *
	 * Absent on lookups built from a slim DB that predates the `coincident_roles` relation.
	 */
	coincidentRolesFor?: (placeID: number) => Promise<DualRole[]>
}

type CascadeHits = Awaited<ReturnType<MailwomanLookupLike["findPlace"]>>

/**
 * Soft proximity hints: ordered, weighted, never a hard filter.
 */
export type ResolveBias = Array<{ lat: number; lon: number; weight?: number }>

type LookupHit = Awaited<ReturnType<MailwomanLookupLike["findPlace"]>>[number]

type BBox = NonNullable<LookupHit["bbox"]>

interface CandidateMeta {
	bbox?: BBox
	country?: string
	placetype: string
}

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

const WOF_RANK_LOCALITY = 5

const WOF_RANK_REGION = 4

/**
 * Area-class postcodes rank below the whole locality tier because a postcode
 * centroid is coarser than the locality it sits in.
 */
const PIN_RANK: Record<string, number> = {
	locality: 5,
	borough: 4,
	localadmin: 4,
	neighbourhood: 4,
	postalcode: 3.5,
	county: 3,
	macrocounty: 3,
	region: 2,
	macroregion: 2,
	country: 1,
}

/**
 * The rank a postcode takes when it leads, above locality and matching Node's
 * `ADMIN_LADDER_POSTCODE_FIRST`, reached by a unit-grade exact hit or an area-grade
 * system whose codes are finer than its localities.
 */
const PIN_RANK_POSTCODE_FIRST = 6

export class CandidateResolverBackend implements ResolverBackend {
	readonly #lookup: MailwomanLookupLike
	readonly #meta = new Map<number, CandidateMeta>()
	readonly artifactCoverage = null

	constructor(lookup: MailwomanLookupLike) {
		this.#lookup = lookup
	}

	/**
	 * The memoized bbox/country/placetype of a previously returned candidate.
	 */
	metaFor(id: number): CandidateMeta | null {
		return this.#meta.get(id) ?? null
	}

	async findPlace(query: Parameters<ResolverBackend["findPlace"]>[0]): Promise<ResolvedPlace[]> {
		let bbox: BBox | null = null
		let country = query.country

		if (query.parentID !== undefined) {
			const parent = this.#meta.get(Number(query.parentID))

			// A parent the table cannot scope by answers "no descendants" so the resolver's parentFallback retries unscoped.
			if (!parent) return []

			if (parent.placetype === "country" && parent.country) {
				country = parent.country
			} else if (parent.bbox) {
				bbox = parent.bbox
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
			bbox: bbox ?? undefined,
			postcode: query.postcode,
			limit: query.limit,
			bias: query.bias,
		})

		return hits.map((h) => {
			this.#meta.set(h.id, { bbox: h.bbox, country: h.country, placetype: h.placetype })

			return {
				...EMPTY_PLACE_FIELDS,
				id: h.id,
				name: h.name,
				placetype: h.placetype,
				lat: h.lat,
				lon: h.lon,
				score: h.score,
				country: h.country ?? null,
				exactMatch: h.exactMatch ?? null,
			}
		})
	}
}

export async function runCascade(
	lookup: MailwomanLookupLike,
	tree: AddressTree,
	rawText: string,
	bias?: ResolveBias
): Promise<CascadeHits> {
	const usable = (cs: CascadeHits): CascadeHits => cs.filter((c) => !(c.lat === 0 && c.lon === 0))

	const backend = new CandidateResolverBackend(lookup)
	const resolver = createWOFResolver(backend)

	// adminCoherence performs the convergence and no defaultCountry is deliberate, because the demo ranks globally.
	const resolved = (await resolver.resolveTree(tree, {
		adminCoherence: true,
		...(bias && bias.length ? { bias } : {}),
	})) as {
		roots: ResolvedTreeNode[]
	}

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
				// Both routes to the top rank are read so the demo pins where the Node ladder pins.
				const postcodeLeads =
					placetype === "postalcode" &&
					(isUnitGradePostcodeHit(String(node.value ?? ""), String(node.metadata?.["resolver_name"] ?? "")) ||
						areaPostcodeLeadsLocality(hit.country ?? null))

				collected.push({ rank: postcodeLeads ? PIN_RANK_POSTCODE_FIRST : (PIN_RANK[placetype] ?? 0), hit })

				const alts = (node.alternatives as Array<Record<string, unknown>> | null) ?? []

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
		return usable(await lookup.findPlace({ text: rawText, limit: 5 }))
	}

	collected.sort((a, b) => b.rank - a.rank || b.hit.score - a.hit.score)

	// An ambiguous international postcode must not out-pin the parsed city across countries,
	// so the locality wins the pin and the postcode stays in the list.
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
