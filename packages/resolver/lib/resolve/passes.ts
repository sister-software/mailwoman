/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The resolver walk's per-node machinery: the trace recorder and its diagnostic bands, the walk's
 *   `ResolutionState`, and the span-rescore / postcode-recovery / postcode-consistency passes the walk applies.
 *   Split from `resolve.ts`, which owns `WOFResolver` — the walk itself over what this module provides.
 */

import type { PlacetypeMap } from "@mailwoman/codex/placetype-map"
import { walkNodes, type AddressNode } from "@mailwoman/core/decoder"
import {
	type CoincidentLocality,
	compareReferential,
	type ResolveCandidateTrace,
	type ResolveNodeTrace,
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
 * Cap on candidates recorded per {@link ResolveNodeTrace}.
 * The trace is a record rather than a dump.
 *
 * The count past the cap is reported in `candidatesTruncated`, so absence of a row is never silent.
 */
const TRACE_CANDIDATE_CAP = 10

/**
 * The fine end of the probe window: `microhood` and no finer.
 *
 * Everything above it — `postalcode`, `venue`, `campus`, `building`, `address` —
 * is excluded because a mislabeled admin span lands on another admin band,
 * and probing every venue in a country per miss provides a long tail of coincidental
 * name matches for a diagnostic that is meant to be read.
 */
const FINEST_DIAGNOSTIC_BAND = PLACETYPE_SPECIFICITY["microhood"]!

/**
 * The coarse end of the probe window.
 *
 * `country` and no coarser: a name matching at `continent` or `planet` says nothing about
 * a mislabeled admin span, and the walk resolves the country from its own node anyway.
 */
const COARSEST_DIAGNOSTIC_BAND = PLACETYPE_SPECIFICITY["country"]!

/**
 * The admin bands `ResolveOpts.diagnoseUnreachable` re-probes, coarse to fine.
 *
 * Derived from `PLACETYPE_SPECIFICITY` rather than typed out, so a placetype added
 * there is probed here without anyone remembering to.
 */
export const DIAGNOSTIC_BANDS: readonly string[] = Object.entries(PLACETYPE_SPECIFICITY)
	.filter(([, rank]) => rank !== undefined && rank <= FINEST_DIAGNOSTIC_BAND && rank >= COARSEST_DIAGNOSTIC_BAND)
	.toSorted((a, b) => (a[1] as number) - (b[1] as number))
	.map(([placetype]) => placetype)

/**
 * Per-lookup trace bookkeeping (#1721).
 *
 * `#lookupAndPick` talks to one of these unconditionally — a real recorder when
 * `ResolveOpts.traceSink` is set, the frozen {@link NOOP_TRACE_RECORDER} otherwise — so the hot
 * path carries no per-event branches and the no-sink walk costs a handful of empty calls per node.
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
	check(name: string): void
	stage(name: string, order: readonly ResolvedPlace[]): void
	reachable(bands: NonNullable<ResolveNodeTrace["reachableIn"]>): void
	emit(picked: NonNullable<ResolveNodeTrace["picked"]> | null): void
}

/**
 * A recorder that records nothing.
 * The walk's default when no trace was requested.
 */
export const NOOP_TRACE_RECORDER: NodeTraceRecorder = Object.freeze({
	bind() {},
	check() {},
	stage() {},
	reachable() {},
	emit() {},
})

export function createNodeTraceRecorder(sink: (record: ResolveNodeTrace) => void): NodeTraceRecorder {
	const checks: string[] = []
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
		check(name) {
			checks.push(name)
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
				checks,
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
	/**
	 * Nodes {@link ResolutionState.minWinningScore} refused, counted so a recovery
	 * pass can tell a refusal from a node nothing resolved.
	 *
	 * Both look identical in the tree — neither carries a `placeID` — and `applySpanRescore`
	 * runs on any tree holding no resolved place, so without this the refusal reopens the
	 * very lookup it just declined and the floor cannot express abstention at all.
	 */
	minScoreRefusals: number
	candidatesPerLookup: number
	defaultCountry?: string
	/**
	 * Whether {@link defaultCountry} came from the locale rather than the caller.
	 *
	 * Consulted only by `country`-placetype lookups, which skip an inferred scope —
	 * see `ResolveOpts.defaultCountryIsInferred`.
	 */
	defaultCountryIsInferred: boolean
	/**
	 * The tree's single value-containing node when it is locality-tagged (the bare-toponym shape), else null.
	 *
	 * Checks the country-placetype sibling race in `#lookupAndPick`.
	 * A bare name can be a country the parser tagged `locality` ("Japan", "China"), and the
	 * locality placetype filter makes the country row unreachable no matter how it ranks.
	 */
	bareLocalityNode: AddressNode | null
	parentFallback: boolean
	/**
	 * The address's postcode string, extracted once up front, passed to locality lookups
	 * so a coordinate-first backend can inject postcode-proximal locality candidates.
	 */
	postcode?: string
	/**
	 * Postcode-containment coherence (#31, Mechanism 2) — forwarded to locality lookups so a
	 * coordinate-first backend can re-rank name candidates by proximity to the postcode's own centroid.
	 *
	 * Opt-in.
	 * Off by default.
	 */
	postcodeContainmentCoherence: boolean
	/**
	 * Postcode-prefix prior (#31, Mechanism 3) — on a `postalcode` miss,
	 * derive the code's prefix and probe `postcodePrefixIndex`.
	 *
	 * Opt-in.
	 * Off by default.
	 */
	postcodePrefixPrior: boolean
	/**
	 * #1589 — the countries the parsed postcode's format implies (the #928 singles plus the shared `NNN NN` family). When
	 * set and no explicit country selection applies, the `postalcode` lookup probes
	 * exactly these countries and abstains if all miss — never falling through to
	 * an unconstrained probe, whose space-stripped fold collides across systems
	 * (`100 00` folded to `10000` answers Troyes FR while Prague sits in the artifact under both keyings).
	 */
	postcodeFormatCountries?: readonly string[]
	/**
	 * #1585 — the locale hint's country, forwarded to the backend as `fuzzyCountry` on every primary lookup. Scopes the
	 * typo-fuzzy tier only.
	 * Exact matches stay worldwide.
	 *
	 * See `ResolveOpts.fuzzyCountryScope`.
	 */
	fuzzyCountryScope?: string
	/**
	 * The injected PFX1 index (structural — `PostcodePrefixIndexLike`, core/resolver/types.ts).
	 * Absent = the prior cannot fire.
	 */
	postcodePrefixIndex?: PostcodePrefixIndexLike
	/**
	 * Proximity-bias points (viewport, user location) — forwarded to every primary lookup.
	 */
	bias?: Array<{ lat: number; lon: number; weight?: number }>
	/**
	 * Postcode-anchor country posterior (#369).
	 *
	 * Undefined = no re-rank (byte-stable default).
	 */
	anchorPosterior?: Record<string, number>
	/**
	 * Weight on the posterior in the locality re-rank.
	 *
	 * Only used when `anchorPosterior` is set.
	 */
	anchorWeight: number
	/**
	 * #1721 resolver-interior trace sink. Undefined (the default) = zero bookkeeping, byte-identical walk.
	 */
	traceSink?: (record: ResolveNodeTrace) => void
	/**
	 * Re-probe a resolved-nothing lookup across the other admin bands and record which hold it.
	 *
	 * Diagnostic only — never reaches the pick.
	 * See `ResolveOpts.diagnoseUnreachable`.
	 */
	diagnoseUnreachable?: boolean
	/**
	 * #27 locale-country soft prior for the bare-toponym admin walk. Undefined = no prior (the shipped default) →
	 * byte-stable.
	 *
	 * See `ResolveOpts.localeCountryPrior` for the calibration and why it ships opt-in.
	 */
	localeCountryPrior?: string
	/**
	 * Weight of that prior in log10-population units.
	 *
	 * Only consulted when `localeCountryPrior` is set.
	 */
	localeCountryPriorWeight: number
	/**
	 * #1880 capital status per candidate, from `ResolveOpts.capitalLevel`. Undefined → no promotion, byte-stable.
	 */
	capitalLevel?: (place: { name: string; country?: string; lat: number; lon: number }) => number
	/**
	 * #743/#194 confident-placer country as a hard filter (empty→unresolved, no global retry). Off = undefined.
	 */
	hardCountry?: string
	/**
	 * Dual-role hierarchy completion (#405).
	 *
	 * Off by default → byte-stable.
	 */
	hierarchyCompletion: boolean
	/**
	 * Attach ancestor lineage to each resolved node (#404).
	 *
	 * Off by default → byte-stable.
	 */
	includeAncestors: boolean
	/**
	 * Admin-containment re-rank (#1717 stage 2).
	 *
	 * Off by default → byte-stable.
	 * See `ResolveOpts.adminContainmentRerank`.
	 */
	adminContainmentRerank: boolean
	/**
	 * The tree's first parsed region-tagged span, extracted once up front
	 * (the `postcode` pattern above — region and locality are siblings, so the top-down
	 * walk wouldn't otherwise let the locality lookup see it).
	 *
	 * Only consulted when {@link adminContainmentRerank} is on.
	 */
	regionQualifier?: string
	/**
	 * Set while resolving when any tree node maps to the `locality` placetype (resolved or not).
	 *
	 * The completion only fires when the parser emitted no locality at all, never to override one.
	 */
	localityNodePresent: boolean
	/**
	 * The first region that resolved (its place — for the coincident-roles lookup).
	 */
	resolvedRegion: CoordinateOptionalPlace | null
	/**
	 * The decorated region node that produced {@link resolvedRegion} — completion pushes
	 * the locality interpretation onto it in place (no synthesized sibling).
	 */
	resolvedRegionNode: AddressNode | null
}

/**
 * Pick the completion locality when an admin maps to several coincident same-name candidates (#405).
 *
 * Referential likelihood is the primary signal.
 * The principal city is the populous one, and it can sit farther from the admin
 * centroid than a tiny same-name hamlet (the Niigata case from #403).
 *
 * Nearest centroid breaks a referential tie.
 * A genuine tie (same population and distance) abstains rather than guess.
 *
 * ROAD_TO_V9 §2: `compareReferential` is referential desc with raw population as its own
 * tiebreak, which is the same order as the plain `b.population - a.population` it replaced —
 * referential is strictly increasing in population below saturation and constant above it.
 * The abstention check below still reads raw population, deliberately: two megacities that saturate
 * to the same referential score are not tied, and abstaining there would be a new behavior.
 */
export function pickCompletion(candidates: readonly CoincidentLocality[]): CoincidentLocality | null {
	if (!candidates.length) return null

	if (candidates.length === 1) return candidates[0]!

	const ranked = [...candidates]
		.map((c) => ({ c, referential: referentialFromPopulation(c.population), population: c.population }))
		// oxlint-disable-next-line unicorn/no-array-sort -- sorts a freshly-built array. toSorted would double-allocate on a hot path
		.sort((a, b) => compareReferential(a, b) || a.c.distanceKm - b.c.distanceKm)
		.map((x) => x.c)

	const [first, second] = ranked

	if (first!.population === second!.population && first!.distanceKm === second!.distanceKm) return null

	return first!
}

/**
 * Find the first postcode value anywhere in the tree (a one-shot pre-scan. Postcode and locality
 * are siblings, so the top-down walk wouldn't otherwise let the locality lookup see it).
 */
export function firstPostcodeValue(roots: readonly AddressNode[]): string | undefined {
	for (const n of walkNodes(roots)) {
		// #31 Mechanism 1: a shape-excluded span keeps its tag but contributes nothing. Its code must never become the address's postcode (it would poison the country-scope pass's anchor).
		if (n.tag === "postcode" && !isShapeExcludedPostcode(n) && n.value.trim().length) return n.value.trim()
	}

	return undefined
}

/**
 * Span-rescore tier (#370): opt-in last-resort locality recovery.
 *
 * Runs only when the tree resolved nothing (the #685 brake — never disturb a working coordinate).
 * Enumerates raw-token spans, exact- matches the same-country gazetteer
 * (longest-wins + postcode-consistency check. See `span-rescore.ts`), and on a hit injects
 * a resolved `locality` node decorated exactly like a normally-resolved one.
 *
 * Default-on (#370, promoted 2026-06-25); byte-stable opt-out via `opts.spanRescore: false`.
 * Async (it queries the backend), so it's awaited.
 */
export async function applySpanRescore(
	roots: AddressNode[],
	raw: string,
	backend: ResolverBackend,
	opts: ResolveOpts
): Promise<void> {
	// Already resolved — never second-guess a working coordinate.
	// `spanRescoreWeakResolution` narrows what counts as working: a pick the gazetteer
	// recorded no population for, or one that failed the query's own containment check,
	// is not a coordinate the brake was written to guard.
	if (hasResolvedPlace(roots, opts.spanRescoreWeakResolution ?? false)) return
	// Default-on since 2026-06-25, so this runs on every unresolved tree.
	// A backend hiccup here must degrade to no-rescore, never crash the resolve
	// (the same fall-through the main walk gives).
	let hit

	try {
		hit = await findRescoreCandidate(raw, roots, backend, {
			country: opts.defaultCountry,
			postcode: firstPostcodeValue(roots),
			thresholdKm: opts.spanRescoreThresholdKm,
			// Default-on (promoted 2026-07-03); explicit `false` opts out — the spanRescore idiom.
			postalCompoundRecovery: opts.postalCompoundRecovery !== false,
			spanRescoreRequireContextRemainder: opts.spanRescoreRequireContextRemainder,
		})
	} catch {
		return
	}

	// #942 postal-compound recovery, part 2: when no city span matched, decorate the failed postcode node from its code-shaped token subset ("1382 Kožljek" → the bare "1382" row) — a postcode-tier coordinate floor, strictly subordinate to a recovered locality. Only-on-miss matters: a GeoNames medoid postcode centroid is coarser than the exact village centroid, and consumers that rank postcode above locality (the eval harness does) would otherwise trade a 0.2 km village pin for a 5 km area centroid. Same unresolved tree, so the #685 brake semantics hold.
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
		// No model confidence for a post-hoc recovery.
		// A mid-tier value marks it as recovered rather than asserted.
		confidence: 0.5,
		children: [],
	}

	// #1537: the same-span namesake runner-ups rather than an empty list. A name the model reads as a `street` ("Springfield", "Berlin", "Moscow") never reaches the admin walk, so this tier is the only thing that resolves it — and decorating with `[]` meant the geocode path's `candidates` held one entry and the dominance margin `declared_ambiguity` reads was uncomputable for exactly the famous-homonym class. The winner is unchanged (see findRescoreCandidate); this is additive.
	decorateNode(node, hit.place, hit.alternatives)
	// `rescore_postcode_verified` carries the check's precision signal as an explicit handle —
	// not folded into the calibrated `confidence`, which would violate the isotonic bound
	// (a true calibrated 0.83 must not be confused with a rescore plug-in estimate. DeepSeek 2026-06-23).
	// True = postcode check fired (high-precision); false = unrestricted
	// (no postcode→point coverage for this country, ~83%-precision).
	node.metadata = { ...node.metadata, span_rescore: true, rescore_postcode_verified: hit.postcodeVerified }
	roots.push(node)

	// #1721 follow-up: this tier answers off the walk, and it used to answer off the record too. The famous-name class ("Frankfurt") returned a coordinate beside an empty resolver trace, blinding every retrieval account. One record per rescue keeps the trace's promise: no resolved coordinate without a lookup record.
	if (opts.traceSink) {
		const rec = createNodeTraceRecorder(opts.traceSink)

		rec.bind(node, "locality", opts.defaultCountry ? { country: opts.defaultCountry } : {}, 1)
		rec.check("span_rescore")
		rec.check(hit.postcodeVerified ? "rescore_postcode_verified" : "rescore_postcode_unverified")
		rec.stage("rescore", [hit.place, ...hit.alternatives])
		rec.emit({ id: hit.place.id, name: hit.place.name, source: "span_rescore" })
	}
}

/**
 * #942: find the first confident-but-unresolved postcode node whose value is a polluted compound ("1382 Kožljek"),
 * resolve its code-shaped token subset as a `postalcode`, and decorate the node from
 * that hit (`postal_compound_recovered` metadata marks the provenance).
 *
 * No-op when every postcode node resolved, the value has no digit-containing tokens,
 * or the subset equals the full value (then the walk already tried it).
 */
async function recoverPostcodeNode(
	roots: AddressNode[],
	backend: ResolverBackend,
	country: string | undefined,
	traceSink?: (record: ResolveNodeTrace) => void
): Promise<void> {
	for (const n of walkNodes(roots)) {
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
					rec.check("postal_compound_recovery")
					rec.stage("recovery", hits)
					rec.emit({ id: top.id, name: top.name, source: "postal_compound_recovery" })
				}
			}

			return // first postcode node only — one recovery per tree
		}
	}
}

/**
 * How far step 3 below may move a coordinate before the answer keeps the locality it selected instead.
 *
 * Above the 99th percentile (153.3 km) of postcode-to-settlement distance for pairs that agree —
 * 800,762 rows across 33 countries, admin1 corroborating — so a correct postcode is never refused.
 * Measured on 5,300 real addresses published with their government point, no arm from a
 * cap of zero upward differs from unbounded by a single row, because the pass's wins there
 * are all step-2 re-picks: `docs/records/evals/2026-09-15-postcode-move-cap.md`.
 */
export const DEFAULT_POSTCODE_MAX_MOVE_KM = 300

/**
 * Postcode-disambiguated locality selection (#370 "Change A").
 *
 * The single biggest miss on the EU/AU panel is a same-named town resolved to the wrong
 * instance — "06260 Saint-Pierre" lands 617 km off — while the postcode that would
 * disambiguate it (06260 → Alpes-Maritimes) sits resolved in the same tree, discarded
 * because the coordinate-picker prefers the (wrong) locality node and never cross- checks it.
 * This post-walk pass closes that loop, backend-agnostically and with no extra query:
 *
 * 1. Find the resolved postcode's coordinate (the trustworthy anchor — a postcode is unambiguous within a country in a way
 *    a town name is not).
 * 2. For each resolved locality node farther than `thresholdKm` from it: re-pick the same-named candidate from the node's
 *    already-captured `alternatives` that is nearest the postcode and within the radius. This keeps locality
 *    granularity at the correct instance.
 * 3. If no alternative reconciles, the locality instance is unreliable — fall its coordinate back to the postcode point
 *    (right area, the safe answer) and flag `postcode_city_mismatch`.
 *
 * Step 3 rests on the postcode being the more reliable of the two, which holds
 * while the postcode is correct.
 * A postcode carries no checksum, so a transposed one is a valid code naming a real place
 * and the step relocates the answer there; `maxMoveKm` bounds that relocation,
 * at {@link DEFAULT_POSTCODE_MAX_MOVE_KM} unless a caller names one.
 *
 * Past the bound the coordinate stays on the selected locality and the node is still flagged,
 * because the components did disagree — what changes is which one the answer follows.
 * Unbounded, the step moved `Nawāda, 744301` 1,914 km onto Port Blair while keeping Nawada's place id.
 *
 * Only fires where the postcode resolved to a point, so it composes with postcode coverage
 * (#193) — add a country's postcodes and this immediately disambiguates its same-named
 * towns. **Default-on** since the #370 operator promotion (2026-07-04, commit `0010bb8c`) —
 * `opts.postcodeConsistency: false` opts out, and the pass is byte-stable on every tree
 * with no resolved postcode point (the `!anchor` early return below).
 */
export function applyPostcodeConsistency(
	roots: readonly AddressNode[],
	thresholdKm: number,
	maxMoveKm = DEFAULT_POSTCODE_MAX_MOVE_KM
): void {
	// The resolved postcode anchor (first one with a real coordinate).
	let anchor: { lat: number; lon: number } | null = null

	for (const n of walkNodes(roots)) {
		// #31 Mechanism 1: a shape-excluded span never anchors the consistency re-pick either.
		if (n.tag === "postcode" && !isShapeExcludedPostcode(n) && isResolvedWithCoord(n)) {
			anchor = { lat: n.lat!, lon: n.lon! }

			break
		}
	}

	// No postcode→point — nothing to disambiguate against (the check cannot fire).
	if (!anchor) return

	for (const node of walkNodes(roots)) {
		if ((node.tag !== "locality" && node.tag !== "dependent_locality") || !isResolvedWithCoord(node)) continue

		const gapKm = haversineKm(anchor.lat, anchor.lon, node.lat!, node.lon!)

		if (gapKm <= thresholdKm) continue // already consistent

		// Re-pick: the same-named candidate nearest the postcode, within the radius.
		// `alternatives` is typed `unknown[]` on the node (decoder/types.ts can't import resolver types).
		// They are the `ResolvedPlace` runner-ups decorateNode attached, so the cast is sound.
		const alts = (node.alternatives as ResolvedPlace[] | undefined) ?? []

		const reconciling = alts
			.filter((a) => a.lat !== 0 || a.lon !== 0)
			.map((a) => ({ a, d: haversineKm(anchor!.lat, anchor!.lon, a.lat, a.lon) }))
			.filter((x) => x.d <= thresholdKm)
			// oxlint-disable-next-line unicorn/no-array-sort -- sorts a freshly-built array. toSorted would double-allocate on a hot path
			.sort((x, y) => x.d - y.d)[0]

		if (reconciling) {
			// Swap to the consistent instance.
			// The displaced winner becomes an alternative.
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

		// Past the cap the postcode is the likelier error of the two, so the answer
		// keeps the locality it selected.
		// The disagreement is still reported; `coordinate_source` is absent
		// because the coordinate was not moved.
		if (gapKm > maxMoveKm) {
			node.metadata = { ...node.metadata, postcode_city_mismatch: true, postcode_move_refused_km: gapKm }

			continue
		}

		// No same-named instance near the postcode → the town is unreliable.
		// Trust the postcode's area.
		node.lat = anchor.lat
		node.lon = anchor.lon
		node.metadata = { ...node.metadata, postcode_city_mismatch: true, coordinate_source: "postcode_fallback" }
	}
}
