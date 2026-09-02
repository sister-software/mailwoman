/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The resolver walk's per-node machinery: the trace recorder and its diagnostic bands, the walk's
 *   `ResolutionState`, and the span-rescore / postcode-recovery / postcode-consistency passes the walk applies.
 *   Split from `resolve.ts`, which owns `WOFResolver` — the walk itself over what this module provides.
 */

import type { AddressNode } from "@mailwoman/core/decoder"
import {
	type CoincidentLocality,
	compareReferential,
	type ResolveCandidateTrace,
	type ResolveNodeTrace,
	type PlacetypeMap,
	type PostcodePrefixIndexLike,
	referentialFromPopulation,
	type ResolvedPlace,
	type ResolveOpts,
	type ResolverBackend,
} from "@mailwoman/core/resolver"
import { PLACETYPE_SPECIFICITY } from "@mailwoman/core/resources/whosonfirst/specificity"
import { haversineKm } from "@mailwoman/spatial"

import { decorateNode, isResolvedWithCoord } from "#decorate-node"
import type { CoordinateOptionalPlace } from "#postcode/prefix"
import { isShapeExcludedPostcode } from "#postcode/shape-coherence"
import { findRescoreCandidate, hasResolvedPlace, postcodeCodeSubset } from "#span-rescore"

/**
 * Cap on candidates recorded per {@link ResolveNodeTrace} — the trace is a record, not a dump. The count past the cap is
 * reported in `candidatesTruncated`, so absence of a row is never silent.
 */
const TRACE_CANDIDATE_CAP = 10

/**
 * The fine end of the probe window: `microhood` and no finer.
 *
 * Everything above it — `postalcode`, `venue`, `campus`, `building`, `address` — is excluded because a mislabeled ADMIN
 * span lands on another admin band, and probing every venue in a country per miss buys a long tail of coincidental name
 * matches for a diagnostic that is meant to be read.
 */
const FINEST_DIAGNOSTIC_BAND = PLACETYPE_SPECIFICITY["microhood"]!

/**
 * The coarse end of the probe window. `country` and no coarser: a name matching at `continent` or `planet` says nothing
 * about a mislabeled admin span, and the walk resolves the country from its own node anyway.
 */
const COARSEST_DIAGNOSTIC_BAND = PLACETYPE_SPECIFICITY["country"]!

/**
 * The admin bands `ResolveOpts.diagnoseUnreachable` re-probes, coarse to fine.
 *
 * Derived from `PLACETYPE_SPECIFICITY` rather than typed out, so a placetype added there is probed here without anyone
 * remembering to.
 */
export const DIAGNOSTIC_BANDS: readonly string[] = Object.entries(PLACETYPE_SPECIFICITY)
	.filter(([, rank]) => rank !== undefined && rank <= FINEST_DIAGNOSTIC_BAND && rank >= COARSEST_DIAGNOSTIC_BAND)
	.toSorted((a, b) => (a[1] as number) - (b[1] as number))
	.map(([placetype]) => placetype)

/**
 * Per-lookup trace bookkeeping (#1721). `#lookupAndPick` talks to ONE of these unconditionally — a real recorder when
 * `ResolveOpts.traceSink` is set, the frozen {@link NOOP_TRACE_RECORDER} otherwise — so the hot path carries no
 * per-event branches and the no-sink walk costs a handful of empty calls per node.
 */
export interface NodeTraceRecorder {
	bind(
		node: AddressNode,
		placetype: string,
		query: {
			country?: string
			parentID?: string | number
			postcode?: string
			regionQualifier?: string
			limit?: number
		},
		defaultLimit: number
	): void
	gate(name: string): void
	stage(name: string, order: readonly ResolvedPlace[]): void
	reachable(bands: NonNullable<ResolveNodeTrace["reachableIn"]>): void
	emit(picked: NonNullable<ResolveNodeTrace["picked"]> | null): void
}

/**
 * A recorder that records nothing — the walk's default when no trace was requested.
 */
export const NOOP_TRACE_RECORDER: NodeTraceRecorder = Object.freeze({
	bind() {},
	gate() {},
	stage() {},
	reachable() {},
	emit() {},
})

export function createNodeTraceRecorder(sink: (record: ResolveNodeTrace) => void): NodeTraceRecorder {
	const gates: string[] = []
	const stageOrders: Array<[string, readonly ResolvedPlace[]]> = []

	let reachableIn: ResolveNodeTrace["reachableIn"]

	let ctx: {
		node: AddressNode
		placetype: string
		query: Parameters<NodeTraceRecorder["bind"]>[2]
		defaultLimit: number
	} | null = null

	return {
		bind(node, placetype, query, defaultLimit) {
			ctx = { node, placetype, query, defaultLimit }
		},
		gate(name) {
			gates.push(name)
		},
		stage(name, order) {
			stageOrders.push([name, order])
		},
		reachable(bands) {
			reachableIn = bands
		},
		emit(picked) {
			if (!ctx) return

			const rankMap = new Map<ResolvedPlace, Record<string, number>>()

			for (const [stage, order] of stageOrders) {
				order.forEach((candidate, index) => {
					let ranks = rankMap.get(candidate)

					if (!ranks) {
						ranks = {}
						rankMap.set(candidate, ranks)
					}

					ranks[stage] = index + 1
				})
			}

			const finalOrder = stageOrders.at(-1)?.[1] ?? []

			const rows: ResolveCandidateTrace[] = finalOrder.slice(0, TRACE_CANDIDATE_CAP).map((c) => ({
				id: c.id,
				name: c.name,
				country: c.country,
				placetype: c.placetype,
				score: c.score,
				...(c.prominence !== undefined ? { prominence: c.prominence } : {}),
				...(c.importance !== undefined ? { importance: c.importance } : {}),
				...(c.population !== undefined ? { population: c.population } : {}),
				...(c.exactMatch !== undefined ? { exactMatch: c.exactMatch } : {}),
				...(c.containedByQualifier !== undefined ? { containedByQualifier: c.containedByQualifier } : {}),
				ranks: rankMap.get(c) ?? {},
			}))

			sink({
				tag: ctx.node.tag,
				value: ctx.node.value,
				placetype: ctx.placetype,
				query: {
					...(ctx.query.country ? { country: ctx.query.country } : {}),
					...(ctx.query.parentID !== undefined ? { parentID: ctx.query.parentID } : {}),
					...(ctx.query.postcode ? { postcode: ctx.query.postcode } : {}),
					...(ctx.query.regionQualifier ? { regionQualifier: ctx.query.regionQualifier } : {}),
					limit: ctx.query.limit ?? ctx.defaultLimit,
				},
				gates,
				...(reachableIn ? { reachableIn } : {}),
				candidates: rows,
				candidatesTruncated: Math.max(0, finalOrder.length - TRACE_CANDIDATE_CAP),
				picked,
			})
		},
	}
}

export interface ResolutionState {
	lookupsRemaining: number
	placetypeMap: PlacetypeMap
	minWinningScore: number
	candidatesPerLookup: number
	defaultCountry?: string
	/**
	 * Whether {@link defaultCountry} came from the locale rather than the caller. Consulted only by `country`-placetype
	 * lookups, which skip an inferred scope — see `ResolveOpts.defaultCountryIsInferred`.
	 */
	defaultCountryIsInferred: boolean
	/**
	 * The tree's single value-bearing node when it is locality-tagged (the bare-toponym shape), else null. Checks the
	 * country-placetype sibling race in `#lookupAndPick` — a bare name can be a country the parser tagged `locality`
	 * ("Japan", "China"), and the locality placetype filter makes the country row unreachable no matter how it ranks.
	 */
	bareLocalityNode: AddressNode | null
	parentFallback: boolean
	/**
	 * The address's postcode string, extracted once up front, passed to locality lookups so a coordinate-first backend
	 * can inject postcode-proximal locality candidates.
	 */
	postcode?: string
	/**
	 * Postcode-containment coherence (#31, Mechanism 2) — forwarded to locality lookups so a coordinate-first backend can
	 * re-rank name candidates by proximity to the postcode's own centroid. Opt-in; OFF by default.
	 */
	postcodeContainmentCoherence: boolean
	/**
	 * Postcode-prefix prior (#31, Mechanism 3) — on a `postalcode` miss, derive the code's prefix and probe
	 * `postcodePrefixIndex`. Opt-in; OFF by default.
	 */
	postcodePrefixPrior: boolean
	/**
	 * #1589 — the countries the parsed postcode's FORMAT implies (the #928 singles plus the shared `NNN NN` family). When
	 * set AND no country constraint survives, the `postalcode` lookup probes exactly these countries and abstains if all
	 * miss — never falling through to an unconstrained probe, whose space-stripped fold collides across systems (`100 00`
	 * folded to `10000` answers Troyes FR while Prague sits in the artifact under both keyings).
	 */
	postcodeFormatCountries?: readonly string[]
	/**
	 * #1585 — the locale hint's country, forwarded to the backend as `fuzzyCountry` on every primary lookup. Scopes the
	 * typo-fuzzy tier only; exact matches stay worldwide. See `ResolveOpts.fuzzyCountryScope`.
	 */
	fuzzyCountryScope?: string
	/**
	 * The injected PFX1 index (structural — `PostcodePrefixIndexLike`, core/resolver/types.ts). Absent = the prior cannot
	 * fire.
	 */
	postcodePrefixIndex?: PostcodePrefixIndexLike
	/**
	 * Proximity-bias points (viewport, user location) — forwarded to every primary lookup.
	 */
	bias?: Array<{ lat: number; lon: number; weight?: number }>
	/**
	 * Postcode-anchor country posterior (#369). Undefined = no re-rank (byte-stable default).
	 */
	anchorPosterior?: Record<string, number>
	/**
	 * Weight on the posterior in the locality re-rank. Only used when `anchorPosterior` is set.
	 */
	anchorWeight: number
	/**
	 * #1721 resolver-interior trace sink. Undefined (the default) = zero bookkeeping, byte-identical walk.
	 */
	traceSink?: (record: ResolveNodeTrace) => void
	/**
	 * Re-probe a resolved-nothing lookup across the other admin bands and record which hold it. Diagnostic only — never
	 * reaches the pick. See `ResolveOpts.diagnoseUnreachable`.
	 */
	diagnoseUnreachable?: boolean
	/**
	 * #27 locale-country SOFT prior for the bare-toponym admin walk. Undefined = no prior (the shipped default) →
	 * byte-stable. See `ResolveOpts.localeCountryPrior` for the calibration and why it ships opt-in.
	 */
	localeCountryPrior?: string
	/**
	 * Weight of that prior in log10-population units. Only consulted when `localeCountryPrior` is set.
	 */
	localeCountryPriorWeight: number
	/**
	 * #1880 capital status per candidate, from `ResolveOpts.capitalLevel`. Undefined → no promotion, byte-stable.
	 */
	capitalLevel?: (place: { name: string; country?: string; lat: number; lon: number }) => number
	/**
	 * #743/#194 confident-placer country as a HARD filter (empty→unresolved, no global retry). Off = undefined.
	 */
	hardCountry?: string
	/**
	 * Dual-role hierarchy completion (#405). Off by default → byte-stable.
	 */
	hierarchyCompletion: boolean
	/**
	 * Attach ancestor lineage to each resolved node (#404). Off by default → byte-stable.
	 */
	includeAncestors: boolean
	/**
	 * Admin-containment re-rank (#1717 stage 2). Off by default → byte-stable. See `ResolveOpts.adminContainmentRerank`.
	 */
	adminContainmentRerank: boolean
	/**
	 * The tree's first parsed region-tagged span, extracted once up front (the `postcode` pattern above — region and
	 * locality are siblings, so the top-down walk wouldn't otherwise let the locality lookup see it). Only consulted when
	 * {@link adminContainmentRerank} is on.
	 */
	regionQualifier?: string
	/**
	 * Set while resolving when ANY tree node maps to the `locality` placetype (resolved or not) — the completion only
	 * fires when the parser emitted no locality at all, never to override one.
	 */
	localityNodePresent: boolean
	/**
	 * The first region that resolved (its place — for the coincident-roles lookup).
	 */
	resolvedRegion: CoordinateOptionalPlace | null
	/**
	 * The decorated region NODE that produced {@link resolvedRegion} — completion pushes the locality interpretation onto
	 * it in place (no synthesized sibling).
	 */
	resolvedRegionNode: AddressNode | null
}

/**
 * Pick the completion locality when an admin maps to several coincident same-name candidates (#405). REFERENTIAL
 * likelihood is the PRIMARY signal — the principal city is the populous one, and it can sit FARTHER from the admin
 * centroid than a tiny same-name hamlet (the Niigata case from #403). Nearest centroid breaks a referential tie; a
 * genuine tie (same population AND distance) ABSTAINS rather than guess.
 *
 * ROAD_TO_V9 §2: `compareReferential` is referential DESC with raw population as its own tiebreak, which is the SAME
 * ORDER as the plain `b.population - a.population` it replaced — referential is strictly increasing in population below
 * saturation and constant above it. The abstention check below still reads raw population, deliberately: two megacities
 * that saturate to the same referential score are not tied, and abstaining there would be a new behavior.
 */
export function pickCompletion(candidates: readonly CoincidentLocality[]): CoincidentLocality | null {
	if (!candidates.length) return null

	if (candidates.length === 1) return candidates[0]!

	const ranked = [...candidates]
		.map((c) => ({ c, referential: referentialFromPopulation(c.population), population: c.population }))
		// oxlint-disable-next-line unicorn/no-array-sort -- sorts a freshly-built array; toSorted would double-allocate on a hot path
		.sort((a, b) => compareReferential(a, b) || a.c.distanceKm - b.c.distanceKm)
		.map((x) => x.c)

	const [first, second] = ranked

	if (first!.population === second!.population && first!.distanceKm === second!.distanceKm) return null

	return first!
}

/**
 * Find the first postcode value anywhere in the tree (a one-shot pre-scan; postcode and locality are siblings, so the
 * top-down walk wouldn't otherwise let the locality lookup see it).
 */
export function firstPostcodeValue(roots: readonly AddressNode[]): string | undefined {
	const stack = [...roots]

	while (stack.length) {
		const n = stack.pop()!

		// #31 Mechanism 1: a shape-excluded span keeps its tag but contributes nothing — its code
		// must never become the address's postcode (it would poison the country-scope pass's anchor).
		if (n.tag === "postcode" && !isShapeExcludedPostcode(n) && n.value.trim().length) return n.value.trim()
		stack.push(...n.children)
	}

	return undefined
}

/**
 * Span-rescore tier (#370): opt-in last-resort locality recovery. Runs ONLY when the tree resolved NOTHING (the #685
 * brake — never disturb a working coordinate). Enumerates raw-token spans, exact- matches the same-country gazetteer
 * (longest-wins + postcode-consistency check; see `span-rescore.ts`), and on a hit INJECTS a resolved `locality` node
 * decorated exactly like a normally-resolved one. Default-ON (#370, promoted 2026-06-25); byte-stable opt-out via
 * `opts.spanRescore: false`. Async (it queries the backend), so it's awaited.
 */
export async function applySpanRescore(
	roots: AddressNode[],
	raw: string,
	backend: ResolverBackend,
	opts: ResolveOpts
): Promise<void> {
	if (hasResolvedPlace(roots)) return // already resolved — never second-guess a working coordinate
	// Default-ON since 2026-06-25, so this runs on every unresolved tree — a backend hiccup here must
	// degrade to no-rescore, never crash the resolve (the same fall-through the main walk gives).
	let hit

	try {
		hit = await findRescoreCandidate(raw, roots, backend, {
			country: opts.defaultCountry,
			postcode: firstPostcodeValue(roots),
			gateKm: opts.spanRescoreGateKm,
			// Default-ON (promoted 2026-07-03); explicit `false` opts out — the spanRescore idiom.
			postalCompoundRecovery: opts.postalCompoundRecovery !== false,
		})
	} catch {
		return
	}

	// #942 postal-compound recovery, part 2: when NO city span matched, decorate the FAILED postcode
	// node from its code-shaped token subset ("1382 Kožljek" → the bare "1382" row) — a postcode-tier
	// coordinate FLOOR, strictly subordinate to a recovered locality. Only-on-miss matters: a GeoNames
	// medoid postcode centroid is COARSER than the exact village centroid, and consumers that rank
	// postcode above locality (the eval harness does) would otherwise trade a 0.2 km village pin for a
	// 5 km area centroid. Same unresolved tree, so the #685 brake semantics hold.
	if (!hit && opts.postalCompoundRecovery !== false) {
		try {
			await recoverPostcodeNode(roots, backend, opts.defaultCountry, opts.traceSink)
		} catch {
			// degrade to no-recovery, never crash the resolve
		}
	}

	if (!hit) return

	const node: AddressNode = {
		tag: "locality",
		value: hit.text,
		start: hit.start,
		end: hit.end,
		// No model confidence for a post-hoc recovery; a mid-tier value marks it as recovered, not asserted.
		confidence: 0.5,
		children: [],
	}

	// #1537: the same-span namesake runner-ups, not an empty list. A name the model reads as a `street`
	// ("Springfield", "Berlin", "Moscow") never reaches the admin walk, so this tier is the ONLY thing that
	// resolves it — and decorating with `[]` meant the geocode path's `candidates` held one entry and the
	// dominance margin `declared_ambiguity` reads was uncomputable for exactly the famous-homonym class.
	// The winner is unchanged (see findRescoreCandidate); this is additive.
	decorateNode(node, hit.place, hit.alternatives)
	// `rescore_gated` carries the check's precision signal as an EXPLICIT handle — NOT folded into the
	// calibrated `confidence`, which would break the isotonic guarantee (a true calibrated 0.83 must not
	// be confused with a rescore plug-in estimate; DeepSeek 2026-06-23). true = postcode check fired
	// (high-precision); false = unrestricted (no postcode→point coverage for this country, ~83%-precision).
	node.metadata = { ...node.metadata, span_rescore: true, rescore_gated: hit.gated }
	roots.push(node)

	// #1721 follow-up: this tier answers OFF the walk, and it used to answer off the record too — the famous-name
	// class ("Frankfurt") returned a coordinate beside an empty resolver trace, blinding every retrieval account.
	// One record per rescue keeps the trace's promise: no resolved coordinate without a lookup record.
	if (opts.traceSink) {
		const rec = createNodeTraceRecorder(opts.traceSink)

		rec.bind(node, "locality", opts.defaultCountry ? { country: opts.defaultCountry } : {}, 1)
		rec.gate("span_rescore")
		rec.gate(hit.gated ? "rescore_gated" : "rescore_ungated")
		rec.stage("rescore", [hit.place, ...hit.alternatives])
		rec.emit({ id: hit.place.id, name: hit.place.name, source: "span_rescore" })
	}
}

/**
 * #942: find the first confident-but-UNRESOLVED postcode node whose value is a polluted compound ("1382 Kožljek"),
 * resolve its code-shaped token subset as a `postalcode`, and decorate the node from that hit
 * (`postal_compound_recovered` metadata marks the provenance). No-op when every postcode node resolved, the value has
 * no digit-bearing tokens, or the subset equals the full value (then the walk already tried it).
 */
async function recoverPostcodeNode(
	roots: AddressNode[],
	backend: ResolverBackend,
	country: string | undefined,
	traceSink?: (record: ResolveNodeTrace) => void
): Promise<void> {
	const stack: AddressNode[] = [...roots]

	while (stack.length) {
		const n = stack.pop()!

		if (n.tag === "postcode" && !n.placeID && n.value.trim()) {
			const code = postcodeCodeSubset(n.value)

			if (!code || code === n.value.trim()) continue
			const hits = await backend.findPlace({ text: code, placetype: "postalcode", country, limit: 1 })
			const top = hits.find((h) => h.lat !== 0 || h.lon !== 0)

			if (top) {
				decorateNode(n, top, [])
				n.metadata = { ...n.metadata, postal_compound_recovered: true }

				// The same off-the-record hole the span-rescore record closes (#1721 follow-up).
				if (traceSink) {
					const rec = createNodeTraceRecorder(traceSink)

					rec.bind(n, "postalcode", { ...(country ? { country } : {}), limit: 1 }, 1)
					rec.gate("postal_compound_recovery")
					rec.stage("recovery", hits)
					rec.emit({ id: top.id, name: top.name, source: "postal_compound_recovery" })
				}
			}

			return // first postcode node only — one recovery per tree
		}

		if (n.children?.length) {
			stack.push(...n.children)
		}
	}
}

/**
 * Postcode-disambiguated locality selection (#370 "Lever A"). The single biggest miss on the EU/AU panel is a
 * same-named town resolved to the WRONG instance — "06260 Saint-Pierre" lands 617 km off — while the postcode that
 * would disambiguate it (06260 → Alpes-Maritimes) sits resolved in the same tree, discarded because the
 * coordinate-picker prefers the (wrong) locality node and never cross- checks it. This post-walk pass closes that loop,
 * backend-agnostically and with no extra query:
 *
 * 1. Find the resolved postcode's coordinate (the trustworthy anchor — a postcode is unambiguous within a country in a way
 *    a town name is not).
 * 2. For each resolved locality node farther than `gateKm` from it: re-pick the same-named candidate from the node's
 *    already-captured `alternatives` that is NEAREST the postcode and within the radius. This keeps locality
 *    granularity at the CORRECT instance.
 * 3. If no alternative reconciles, the locality instance is unreliable — fall its coordinate back to the postcode point
 *    (right area, the safe answer) and flag `postcode_city_mismatch`.
 *
 * Only fires where the postcode resolved to a point, so it composes with postcode coverage (#193) — add a country's
 * postcodes and this immediately disambiguates its same-named towns. **Default-ON** since the #370 operator promotion
 * (2026-07-04, commit `0010bb8c`) — `opts.postcodeConsistency: false` opts out, and the pass is byte-stable on every
 * tree with no resolved postcode point (the `!anchor` early return below).
 */
export function applyPostcodeConsistency(roots: readonly AddressNode[], gateKm: number): void {
	// The resolved postcode anchor (first one with a real coordinate).
	let anchor: { lat: number; lon: number } | null = null
	const findAnchor: AddressNode[] = [...roots]

	while (findAnchor.length) {
		const n = findAnchor.pop()!

		// #31 Mechanism 1: a shape-excluded span never anchors the consistency re-pick either.
		if (n.tag === "postcode" && !isShapeExcludedPostcode(n) && isResolvedWithCoord(n)) {
			anchor = { lat: n.lat!, lon: n.lon! }

			break
		}

		findAnchor.push(...n.children)
	}

	if (!anchor) return // no postcode→point — nothing to disambiguate against (gate can't fire)

	const stack: AddressNode[] = [...roots]

	while (stack.length) {
		const node = stack.pop()!
		stack.push(...node.children)

		if ((node.tag !== "locality" && node.tag !== "dependent_locality") || !isResolvedWithCoord(node)) continue

		if (haversineKm(anchor.lat, anchor.lon, node.lat!, node.lon!) <= gateKm) continue // already consistent

		// Re-pick: the same-named candidate nearest the postcode, within the radius. `alternatives` is
		// typed `unknown[]` on the node (decoder/types.ts can't import resolver types) — they ARE the
		// `ResolvedPlace` runner-ups decorateNode attached, so the cast is sound.
		const alts = (node.alternatives as ResolvedPlace[] | undefined) ?? []

		const reconciling = alts
			.filter((a) => a.lat !== 0 || a.lon !== 0)
			.map((a) => ({ a, d: haversineKm(anchor!.lat, anchor!.lon, a.lat, a.lon) }))
			.filter((x) => x.d <= gateKm)
			// oxlint-disable-next-line unicorn/no-array-sort -- sorts a freshly-built array; toSorted would double-allocate on a hot path
			.sort((x, y) => x.d - y.d)[0]

		if (reconciling) {
			// Swap to the consistent instance; the displaced winner becomes an alternative.
			const displaced: ResolvedPlace = {
				id: 0,
				name: String(node.metadata?.["resolver_name"] ?? node.value),
				placetype: "locality",
				country: reconciling.a.country,
				lat: node.lat!,
				lon: node.lon!,
				score: 0,
			}

			const rest = alts.filter((a) => a !== reconciling.a)
			decorateNode(node, reconciling.a, [displaced, ...rest])
			node.metadata = { ...node.metadata, postcode_repicked: true }

			continue
		}

		// No same-named instance near the postcode → the town is unreliable; trust the postcode's area.
		node.lat = anchor.lat
		node.lon = anchor.lon
		node.metadata = { ...node.metadata, postcode_city_mismatch: true, coordinate_source: "postcode_fallback" }
	}
}
