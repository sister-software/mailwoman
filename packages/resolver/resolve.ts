/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `resolveTree` — walk an `AddressTree` top-down and decorate matched nodes with resolver- supplied
 *   attribution + coordinates.
 *
 *   The walk is parent-constraint-aware: when a parent node resolves to a place id, its children's
 *   lookups are scoped to descendants of that parent. This dramatically narrows the search space
 *   for ambiguous names — `Springfield` under a resolved `Illinois` parent resolves to the IL one,
 *   not the MA one.
 */

import { isStreetDirectionalToken } from "@mailwoman/codex/us"
import type { AddressNode, AddressTree, ComponentTag, Interpretation } from "@mailwoman/core/decoder"
import { loneValueBearingNode } from "@mailwoman/core/decoder"
import {
	type AddressPointLookup,
	type BackendCapabilityGap,
	type CoincidentLocality,
	compareReferential,
	DEFAULT_PLACETYPE_MAP,
	type InterpolationLookup,
	isPlacetypeFallback,
	type PlacetypeMap,
	type PostcodePrefixIndexLike,
	referentialFromPopulation,
	type ResolvedPlace,
	type ResolveOpts,
	type Resolver,
	type ResolverBackend,
	type StreetCentroidLookup,
	countriesFromPostcodeFormat,
} from "@mailwoman/core/resolver"
import { haversineKm } from "@mailwoman/spatial"

import {
	applyAdminCoherence,
	applyExplicitCountryCoherence,
	applyRegionCountryCoherence,
} from "./admin-coherence-passes.ts"
import { adminContainmentVerdict, firstRegionQualifier, partitionByContainment } from "./admin-containment.ts"
import { describeCapabilityGaps, reportCapabilityGaps } from "./backend-capabilities.ts"
import {
	BARE_REGION_DOMINANCE_LOG10,
	bareCountryCandidate,
	bareRegionCandidate,
	logPopulation,
	loneBareLocalityNode,
	pickLargerAdmin,
} from "./bare-toponym-race.ts"
import { decorateNode, isResolvedWithCoord } from "./decorate-node.ts"
import { foldName } from "./fold-name.ts"
import {
	findPostcodeCountryScope,
	type PostcodeCountryScope,
	stampPostcodeCountryScope,
} from "./postcode-country-coherence.ts"
import { type CoordinateOptionalPlace, postcodePrefixResolvedPlace, probePostcodePrefix } from "./postcode-prefix.ts"
import { applyPostcodeShapeCoherence, isShapeExcludedPostcode } from "./postcode-shape-coherence.ts"
import { findRescoreCandidate, hasResolvedPlace, postcodeCodeSubset } from "./span-rescore.ts"
import { applyAddressPoint, applyInterpolation, applyStreetCentroid } from "./street-tier.ts"
import { DEFAULT_COUNTRY_PRIOR_WEIGHT, rankByCountryPrior, rankByImportance } from "./toponym-prior.ts"

/**
 * Build a `Resolver` backed by a `ResolverBackend`. The backend can be any concrete impl structurally compatible with
 * `PlaceLookup` — e.g. `new WOFSqlitePlaceLookup({ databasePath }).asResolverBackend()` or a fake for tests.
 */
export function createWOFResolver(backend: ResolverBackend): Resolver {
	return new WOFResolver(backend)
}

interface ResolutionState {
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
	 * The tree's single value-bearing node when it is locality-tagged (the bare-toponym shape), else null. Gates the
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
	 * #27 locale-country SOFT prior for the bare-toponym admin walk. Undefined = no prior (the shipped default) →
	 * byte-stable. See `ResolveOpts.localeCountryPrior` for the calibration and why it ships opt-in.
	 */
	localeCountryPrior?: string
	/**
	 * Weight of that prior in log10-population units. Only consulted when `localeCountryPrior` is set.
	 */
	localeCountryPriorWeight: number
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
function pickCompletion(candidates: readonly CoincidentLocality[]): CoincidentLocality | null {
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
function firstPostcodeValue(roots: readonly AddressNode[]): string | undefined {
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
 * (longest-wins + postcode-consistency gate; see `span-rescore.ts`), and on a hit INJECTS a resolved `locality` node
 * decorated exactly like a normally-resolved one. Default-ON (#370, promoted 2026-06-25); byte-stable opt-out via
 * `opts.spanRescore: false`. Async (it queries the backend), so it's awaited.
 */
async function applySpanRescore(
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
			await recoverPostcodeNode(roots, backend, opts.defaultCountry)
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
	// `rescore_gated` carries the gate's precision signal as an EXPLICIT handle — NOT folded into the
	// calibrated `confidence`, which would break the isotonic guarantee (a true calibrated 0.83 must not
	// be confused with a rescore plug-in estimate; DeepSeek 2026-06-23). true = postcode gate fired
	// (high-precision); false = ungated (no postcode→point coverage for this country, ~83%-precision).
	node.metadata = { ...node.metadata, span_rescore: true, rescore_gated: hit.gated }
	roots.push(node)
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
	country: string | undefined
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
 *    already-captured `alternatives` that is NEAREST the postcode and within the gate. This keeps locality granularity
 *    at the CORRECT instance.
 * 3. If no alternative reconciles, the locality instance is unreliable — fall its coordinate back to the postcode point
 *    (right area, the safe answer) and flag `postcode_city_mismatch`.
 *
 * Only fires where the postcode resolved to a point, so it composes with postcode coverage (#193) — add a country's
 * postcodes and this immediately disambiguates its same-named towns. **Default-ON** since the #370 operator promotion
 * (2026-07-04, commit `0010bb8c`) — `opts.postcodeConsistency: false` opts out, and the pass is byte-stable on every
 * tree with no resolved postcode point (the `!anchor` early return below).
 */
function applyPostcodeConsistency(roots: readonly AddressNode[], gateKm: number): void {
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

		// Re-pick: the same-named candidate nearest the postcode, within the gate. `alternatives` is
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

class WOFResolver implements Resolver {
	readonly #backend: ResolverBackend
	/**
	 * The gazetteer artifact's self-declared coverage facts, passed through from the backend so pipeline-level consumers
	 * read them from the resolver handle they already hold. Absent on artifacts predating the coverage manifest.
	 */
	readonly artifactCoverage: Resolver["artifactCoverage"]
	/**
	 * Optional backend methods this backend omits, each naming the default-ON option it silently disables. Computed once
	 * here rather than at each guard site so a caller can read the gap before running a query that would quietly skip the
	 * feature. See `backend-capabilities.ts`.
	 */
	readonly capabilityGaps: readonly BackendCapabilityGap[]

	constructor(backend: ResolverBackend) {
		this.#backend = backend
		this.artifactCoverage = backend.artifactCoverage
		this.capabilityGaps = describeCapabilityGaps(backend)
		reportCapabilityGaps(this.capabilityGaps)
	}

	async resolveTree(tree: AddressTree, opts: ResolveOpts = {}): Promise<AddressTree> {
		// Postcode-shape coherence (#31, Mechanism 1): the earliest pass in the tree — pure-sync and
		// backend-free, run BEFORE `state.postcode` is read so an excluded span can never become the
		// address's postcode. Opt-in (`postcodeShapeCoherence: true`), OFF by default (D-rule: demotion
		// is the failure mode with teeth). A confirmed span's narrowed systems — the intersection of
		// its codex shape with the tree's confident sibling systems — bound the country-scope pass
		// below; a pure subset of codex's own candidate list, so it can only narrow, never widen.
		// See postcode-shape-coherence.ts.
		const shapeVerdict = opts.postcodeShapeCoherence === true ? applyPostcodeShapeCoherence(tree.roots) : null

		const state: ResolutionState = {
			lookupsRemaining: opts.maxLookups ?? 10,
			// Full replacement when `placetypeMap` is supplied — callers that want to extend rather
			// than replace should spread DEFAULT_PLACETYPE_MAP themselves.
			placetypeMap: opts.placetypeMap ?? DEFAULT_PLACETYPE_MAP,
			minWinningScore: opts.minWinningScore ?? 0,
			candidatesPerLookup: opts.candidatesPerLookup ?? 5,
			defaultCountry: opts.defaultCountry,
			defaultCountryIsInferred: opts.defaultCountryIsInferred === true,
			bareLocalityNode: loneBareLocalityNode(tree, opts.placetypeMap ?? DEFAULT_PLACETYPE_MAP),
			parentFallback: opts.parentFallback ?? true,
			postcode: firstPostcodeValue(tree.roots),
			// #31 Mechanism 2 — forwarded to locality lookups (see #lookupAndPick). Opt-in, OFF by default.
			postcodeContainmentCoherence: opts.postcodeContainmentCoherence === true,
			// #31 Mechanism 3 — the prefix prior + its injected index (see #lookupAndPick). Opt-in, OFF by default.
			postcodePrefixPrior: opts.postcodePrefixPrior === true,
			postcodePrefixIndex: opts.postcodePrefixIndex,
			// #1589: derived here when the caller didn't thread it, so the browser cascade and the
			// drop-ins get the implied-set probe without per-caller wiring (the staged-repoint e2e
			// caught `100 00` resolving in Node and not in the browser over the same artifact).
			postcodeFormatCountries:
				opts.postcodeFormatCountries ?? countriesFromPostcodeFormat(firstPostcodeValue(tree.roots)),
			fuzzyCountryScope: opts.fuzzyCountryScope,
			bias: opts.bias,
			anchorPosterior: opts.anchorPosterior,
			anchorWeight: opts.anchorWeight ?? 2,
			localeCountryPrior: opts.localeCountryPrior,
			localeCountryPriorWeight: opts.localeCountryPriorWeight ?? DEFAULT_COUNTRY_PRIOR_WEIGHT,
			hardCountry: opts.hardCountry,
			// Default-ON (#402): completion only fires for a dual-role region whose locality the parser
			// dropped, and no-ops entirely when the backend has no relation (the browser WASM resolver, or
			// a gazetteer without `coincident_roles`). Pass `hierarchyCompletion: false` to opt out.
			//
			// Default-ON is nominal on the SHIPPED backend: `WOFCandidateTableLookup` implements no
			// `coincidentLocalitiesFor`, so this attaches nothing there. Measured 2026-08-15 on FTS, which
			// does implement it, the flag changed 0 of 837 board inputs — see ResolveOpts.hierarchyCompletion.
			hierarchyCompletion: opts.hierarchyCompletion ?? true,
			includeAncestors: opts.includeAncestors ?? false,
			// #1717 stage 2 — default OFF (D-rule); the qualifier is pre-scanned like `postcode` above
			// because region and locality are siblings the walk visits independently.
			adminContainmentRerank: opts.adminContainmentRerank === true,
			regionQualifier: firstRegionQualifier(tree.roots),
			localityNodePresent: false,
			resolvedRegion: null,
			resolvedRegionNode: null,
		}

		// Postcode-country coherence (#42): the one pre-walk LOOKUP pass (the shape verdict above is
		// pure-sync, backend-free), and the only mechanism allowed to override `defaultCountry`. Its three
		// sibling coherence passes re-pick nodes AFTER the walk; that shape cannot work here, because what
		// needs correcting is the walk's country SCOPE — which poisons the postcode node's own resolution,
		// the postcode-consistency fallback that then drags the locality onto it, and the hard `country`
		// filter on every admin lookup. So the verdict is taken once, up front, and the walk runs under the
		// corrected country. Default-ON (operator-promoted 2026-08-05; `false` opts out) — needs a default
		// country to correct and both a postcode and a locality to be coherent about; abstains unless
		// EXACTLY one country (never the already-coherent default) makes the pair consistent. See
		// postcode-country-coherence.ts.
		let postcodeScope: PostcodeCountryScope | null = null

		// The pass also runs with NO default in force (#1585/#861 convergence): there is nothing to
		// override, but the same exactly-one-country abstention lets the postcode+locality pair
		// CONSTRAIN an otherwise population-first walk — `Zabiče 8, 6250 Zabiče` picks the SI row
		// coherent with the SI 6250 centroid instead of the more-populous Polish namesake. The
		// browser cascade (which sets no default by design) is the consumer this exists for.
		if (opts.postcodeCountryCoherence !== false && state.postcode) {
			postcodeScope = await findPostcodeCountryScope(tree.roots, this.#backend, {
				postcode: state.postcode,
				defaultCountry: state.defaultCountry,
				...(shapeVerdict?.narrowing !== undefined ? { candidateSystems: shapeVerdict.narrowing } : {}),
				...(opts.postcodeCountryCoherenceGateKm !== undefined ? { gateKm: opts.postcodeCountryCoherenceGateKm } : {}),
			})

			if (postcodeScope) {
				// The override. `hardCountry` is not cleared because it is never consulted while a
				// `defaultCountry` is set (`#lookupAndPick`'s precedence chain reaches it only as the last
				// fallback), so replacing the default is sufficient to re-scope the entire walk.
				state.defaultCountry = postcodeScope.country
			}
		}

		const newRoots: AddressNode[] = []

		for (const root of tree.roots) {
			newRoots.push(await this.#walk(root, /* parentResolved */ null, state))
		}

		// Attribution for the override, stamped on the two nodes that bought it. Additive metadata only.
		if (postcodeScope) {
			stampPostcodeCountryScope(newRoots, postcodeScope)
		}

		// Dual-role hierarchy completion (#405/#415). Only when enabled, a region resolved, and the parser
		// emitted NO locality — record the dropped locality as a SECONDARY ROLE (an interpretation) on the
		// resolved region node, from the backend's precomputed coincident-roles relation (#403). One node,
		// one span, two roles — no synthesized sibling. See ResolveOpts.hierarchyCompletion.
		if (state.hierarchyCompletion && state.resolvedRegion && state.resolvedRegionNode && !state.localityNodePresent) {
			this.#completeRegionRole(state.resolvedRegion, state.resolvedRegionNode)
		}

		// Admin descendant-consistency (#263): default-ON (#895 settled drift D1; `false` opts out). Re-pick a
		// (region, locality) pair so the locality descends from the region — runs BEFORE postcode-consistency
		// (it resolves the locality the postcode pass may then refine) and before the street tiers (which key
		// off the postcode/street, not the admin coordinate this adjusts). Byte-stable when nothing fell
		// through or the backend lacks `ancestors`.
		if (opts.adminCoherence !== false) {
			await applyAdminCoherence(newRoots, this.#backend)
			// #822 — same joint-consistency family, inverse trigger: an explicit country token whose resolved
			// locality landed in the wrong country (the populous US namesake). Runs after the region pass so the
			// two never contend (region-fallthrough vs resolved-but-foreign are disjoint locality states).
			await applyExplicitCountryCoherence(newRoots, this.#backend)
			// Region-country coherence: a region qualifier the locale-inferred default-country hard filter could not
			// resolve (a foreign subdivision — "Montreal QC" under a US locale). The default filter discarded "QC" and
			// force-matched the locality to the US namesake; this re-resolves the subdivision + its same-named locality
			// under the subdivision's OWN country. Disjoint from the two passes above (unresolved region + resolved
			// locality); evidence-gated + byte-stable on the domestic path (a US region resolves under `US`).
			await applyRegionCountryCoherence(newRoots, this.#backend, state.defaultCountry)
		}

		// Postcode-consistency (#370 "Lever A"): default-ON (promoted 2026-07-04 — the corrected gate:
		// FI 231/0, SI 37/6, CZ 47/2, US byte-flat; see the ResolveOpts docstring). After the admin walk
		// (needs both the locality and the postcode resolved) and before the street tiers (which key off
		// the postcode/street, not the locality coordinate this adjusts). `false` opts out, byte-stable.
		if (opts.postcodeConsistency !== false) {
			applyPostcodeConsistency(newRoots, opts.postcodeConsistencyGateKm ?? 50)
		}

		// Address-point tier (#476): opt-in street-level exact match. After the admin walk so the
		// tier can never disturb admin attribution — it only ADDS the precise coordinate. Byte-stable
		// when opts.addressPoints is absent.
		if (opts.addressPoints) {
			applyAddressPoint(newRoots, opts.addressPoints, opts.addressPointBboxFallback)
		}

		// Interpolation tier (#483): strictly AFTER the exact-point block so an estimate can never
		// override a real situs point (applyInterpolation also gates on resolution_tier). Opt-in;
		// byte-stable when opts.interpolation is absent.
		if (opts.interpolation) {
			applyInterpolation(newRoots, opts.interpolation, opts.interpolationRadiusCalibration)
		}

		// Span-rescore tier (#370): default-ON (promoted 2026-06-25 — same-harness EU+AU +1pp @25km,
		// zero regressions: CZ 90→95, AT 70→73, PL 88→90, IT/PT/FR/AU flat, no-result 4→3%; fires last
		// so it only runs when every other tier left the tree unresolved, hence inert on the well-resolved
		// US path). Explicit opt-OUT via `spanRescore: false`; byte-stable then.
		if (opts.spanRescore !== false) {
			await applySpanRescore(newRoots, tree.raw, this.#backend, opts)
		}

		// A failed admin walk can leave the exact-point tier without a locality even though span-rescore
		// recovers one immediately afterward (for example, a locality the model tagged as `region`). Give
		// the exact register one bounded retry with that newly established scope. An existing situs hit is
		// returned early by applyAddressPoint, so the normal path performs no duplicate lookup; interpolation
		// remains subordinate because an exact point is allowed to replace its estimate.
		if (opts.addressPoints) {
			applyAddressPoint(newRoots, opts.addressPoints, opts.addressPointBboxFallback)
		}

		// Street-centroid tier (#1042): LAST, after span-rescore, so it can (a) union the span-rescore-recovered
		// country into its FR/national country hints (a placer-misrouted street — "Rue Sainte-Catherine" → IT — leaves
		// admin unresolved, and only span-rescore recovers the FR country signal) and (b) override a coarse recovered
		// locality with the exact street centroid. Self-gates on no house number + no existing street-level tier, so a
		// rooftop query is untouched; byte-stable when opts.streetCentroids absent.
		if (opts.streetCentroids) {
			applyStreetCentroid(newRoots, tree.raw, opts.streetCentroids, opts.streetCountryHints ?? [])
		}

		return { raw: tree.raw, roots: newRoots }
	}

	/**
	 * Record a dropped dual-role locality as a `locality` INTERPRETATION on the resolved region node (#415, generalizes
	 * #405's synthesized node). Consults `coincidentLocalitiesFor(regionID)` (O(1) map lookup — no distance math, no
	 * backend query), picks the principal city ({@link pickCompletion}: population-primary, distance tiebreak, abstain on
	 * a genuine tie), and appends an interpretation to `regionNode.interpretations`. No-op when the backend has no
	 * relation, the region isn't a dual-role place, or it abstains. The region node's primary role stays `region`; the
	 * locality rides alongside.
	 */
	#completeRegionRole(region: CoordinateOptionalPlace, regionNode: AddressNode): void {
		if (typeof region.id !== "number" || !this.#backend.coincidentLocalitiesFor) return
		const loc = pickCompletion(this.#backend.coincidentLocalitiesFor(region.id))

		if (!loc) return

		const interpretation: Interpretation = {
			tag: "locality",
			placeID: `wof:${loc.id}`,
			sourceID: `${loc.placetype}:${loc.id}`,
			lat: loc.lat,
			lon: loc.lon,
			confidence: 0,
			metadata: { relationship_type: loc.relationshipType, resolver_completed: true, resolver_name: loc.name },
		}

		regionNode.interpretations = [...(regionNode.interpretations ?? []), interpretation]
	}

	async #walk(
		node: AddressNode,
		parentResolved: CoordinateOptionalPlace | null,
		state: ResolutionState
	): Promise<AddressNode> {
		// Always clone — never mutate input nodes.
		const decorated: AddressNode = { ...node, children: [] }

		const placetype = state.placetypeMap[node.tag as ComponentTag]

		// Track locality presence for hierarchy completion (#405): completion must NOT fire if the parser
		// already emitted a locality node (even one that failed to resolve) — it only fills a genuine
		// gap. Cheap and always-on; only consulted when hierarchyCompletion is set.
		if (placetype === "locality") {
			state.localityNodePresent = true
		}

		let resolved: CoordinateOptionalPlace | null = null

		// Shape-excluded postcode spans (letter-bearing ones keep their tag; #31 Mechanism 1) are
		// stripped of their resolve contribution — the walk does not look them up. Digit-only excluded
		// spans were retagged to `house_number` and flow through their correct sibling placetype.
		if (placetype && state.lookupsRemaining > 0 && node.value.trim().length && !isShapeExcludedPostcode(node)) {
			const picked = await this.#lookupAndPick(node, placetype, parentResolved, state)

			if (picked) {
				resolved = picked.top
				decorateNode(decorated, picked.top, picked.alternatives)

				if (picked.metadata) {
					decorated.metadata = { ...decorated.metadata, ...picked.metadata }
				}

				// #1678 thread 2 — the parse half, resolved from the atlas rather than trained in.
				//
				// The bare-toponym race exists because the model reads a lone country or region name as a
				// `locality`; the race finds the right PLACE and the node keeps the wrong TAG. So
				// `mw geocode 格鲁吉亚` lands on Georgia the country and reports `{"locality": "格鲁吉亚"}`,
				// which is a correct coordinate under a label that will mislead the moment the same toponym
				// appears inside a longer address.
				//
				// The repick metadata already marks exactly these nodes, so the correction is free: retrieval
				// established the placetype, and the tag follows it. Only the race's own picks are retagged —
				// an ordinary locality that resolved to a locality is untouched.
				if (decorated.metadata?.["bare_country_repick"]) {
					decorated.tag = "country"
				} else if (decorated.metadata?.["bare_region_repick"]) {
					decorated.tag = "region"
				}

				// Lineage attachment (#404): stamp the resolved place's ancestor chain onto metadata. Opt-in
				// + only when the backend supplies it, so the default stays byte-identical (no extra query).
				if (state.includeAncestors && this.#backend.ancestors) {
					decorated.metadata = { ...decorated.metadata, ancestors: this.#backend.ancestors(picked.top.id) }
				}

				// Capture the first resolved region (place + node) for hierarchy completion — the locality
				// interpretation is pushed onto this node in the post-walk pass.
				if (placetype === "region" && state.resolvedRegion === null) {
					state.resolvedRegion = picked.top
					state.resolvedRegionNode = decorated
				}
			}
		}

		const carryParent = resolved ?? parentResolved

		for (const child of node.children) {
			decorated.children.push(await this.#walk(child, carryParent, state))
		}

		return decorated
	}

	async #lookupAndPick(
		node: AddressNode,
		placetype: string,
		parentResolved: CoordinateOptionalPlace | null,
		state: ResolutionState
	): Promise<{
		top: CoordinateOptionalPlace
		alternatives: ResolvedPlace[]
		metadata?: Record<string, unknown>
	} | null> {
		state.lookupsRemaining--

		const query: Parameters<ResolverBackend["findPlace"]>[0] = {
			text: node.value,
			placetype,
			limit: state.candidatesPerLookup,
		}

		// Proximity bias (viewport center, user location, …) — a SOFT re-rank the backend folds into
		// its exact-tier prominence; never a filter, so recall is untouched. This is how an ambiguous
		// bare postcode ("48026") follows the map view instead of a global population coin-flip.
		if (state.bias && state.bias.length) {
			query.bias = state.bias
		}

		// Pass the inherited parent constraint to the backend when available — `parentID` scopes to
		// the resolved parent's descendants. For `country`: a resolved parent's country wins, else
		// fall back to the caller's `defaultCountry`. Without this top-level hint a bare "IL" over a
		// multi-country gazetteer fuzzy-matches a foreign place (e.g. a French region) — see the
		// Direction-C resolver eval.
		if (parentResolved && typeof parentResolved.id === "number") {
			query.parentID = parentResolved.id
		}

		// #194: a resolved parent's country wins, then the caller's `defaultCountry`, then the confident
		// placer `hardCountry`. All three are a HARD candidate filter. The placer's `hardCountry` is gated
		// upstream on high confidence (so it only fires when the model is sure), and on a miss the node is
		// left UNRESOLVED rather than re-resolved globally: the off-continent rows are precisely the ones
		// whose locality isn't in the country's gazetteer slice, so a global retry would just re-admit the
		// wrong-continent guess the hard filter exists to drop ("in-region or unresolved"). Measured: a
		// global fallback collapses back to the soft-prior baseline (FI p90 3050, PL p90 1078); pure-hard
		// collapses the tail (FI 18 km, PL p99 8172→494) at a coverage-bounded recall cost.
		// #833 forward linkage: a node's own `country_hint` (an address-system recognizer's derived country —
		// today `recognizeUSRegions` stamping "US" on a recognized closed-set US state) constrains THIS node's
		// lookup when the caller supplied no locale/default country. A caller scope outranks this derived hint:
		// `WA` is both Washington and Western Australia, so en-AU must reach the AU candidate instead of being
		// overwritten by the US-only recognizer. A genuine foreign subdivision under the wrong locale is recovered
		// later by region-country coherence after the scoped lookup abstains.
		const countryHint = node.metadata?.["country_hint"]

		// A locale-INFERRED default country never filters a `country`-placetype lookup: the span names a
		// country outright, and the filter can only admit the scope country itself (bare "Germany" under
		// the en-US default filtered out the DE row; the unresolved span then fell to a US locality whose
		// historical alias is "Germany, Ohio"). An EXPLICIT caller scope stays supreme, matching the #912
		// posture; parent evidence and the confident placer are untouched.
		const defaultCountryForLookup =
			placetype === "country" && state.defaultCountryIsInferred ? undefined : state.defaultCountry

		const country =
			parentResolved?.country ??
			defaultCountryForLookup ??
			(typeof countryHint === "string" ? countryHint : undefined) ??
			state.hardCountry

		if (country) {
			query.country = country
		}

		// #1585: the locale hint's country rides on every primary lookup as the TYPO-FUZZY tier's scope.
		// Deliberately set even when `query.country` is (the backend ignores it there — the hard filter
		// is already narrower): the field's contract lives in one place, the backend.
		if (state.fuzzyCountryScope) {
			query.fuzzyCountry = state.fuzzyCountryScope
		}

		// Admin-containment re-rank (#1717 stage 2): thread the tree's region qualifier onto locality
		// lookups so a capable backend can vouch for (and surface) the candidates that sit UNDER it.
		// Stands down under an EXPLICIT caller country scope (the #912 posture — only a locale-INFERRED
		// scope is bypassable by the address's own evidence); the resolved-parent and placer scopes are
		// left alone, since a resolved parent usually IS the qualifier and the injection dedupes.
		const containmentEligible =
			state.adminContainmentRerank &&
			placetype === "locality" &&
			state.regionQualifier !== undefined &&
			(!state.defaultCountry || state.defaultCountryIsInferred)

		if (containmentEligible) {
			query.regionQualifier = state.regionQualifier
		}

		// Coordinate-first: hand the sibling postcode to locality lookups so the backend can inject
		// postcode-proximal candidates the name-match would miss. Only for locality (the placetype both
		// `locality` and `dependent_locality` map to); other placetypes ignore it. The containment flag
		// (#31, Mechanism 2) asks a coordinate-first backend to re-rank the candidates by proximity to
		// the postcode's own centroid — opt-in, OFF by default.
		if (placetype === "locality" && state.postcode) {
			query.postcode = state.postcode

			if (state.postcodeContainmentCoherence) {
				query.postcodeContainmentCoherence = true
			}
		}

		let candidates: ResolvedPlace[]

		// #1589: a `postalcode` whose FORMAT implies specific countries, with no surviving country
		// constraint, probes exactly the implied set — most populous hit wins, and an all-miss
		// leaves the candidate set EMPTY rather than falling through to the unconstrained fold:
		// `100 00` space-strips to `10000`, which answers Troyes FR while the CZ rows sit in the
		// artifact under both keyings; a scoped empty must stay empty (the same contract as the
		// fuzzy tier's, #1585). The postcode-prefix prior below still gets its turn on the empty
		// set — its index is country-scoped by construction, so it is not the fold this branch
		// exists to avoid (the B3 tests hold that path).
		if (placetype === "postalcode" && !query.country && state.postcodeFormatCountries?.length) {
			let best: ResolvedPlace | undefined

			for (const impliedCountry of state.postcodeFormatCountries) {
				try {
					const hits = await this.#backend.findPlace({ ...query, country: impliedCountry })
					const top = hits[0]

					// `score` is the backend's own population-first ranking metric, so comparing the
					// per-country winners by it keeps the cross-country pick population-first too.
					if (top && (!best || top.score > best.score)) {
						best = top
					}
				} catch {
					// A per-country probe failure reads as a miss for that country, never an abort.
				}
			}

			if (best) return { top: best, alternatives: [] }

			candidates = []
		} else {
			try {
				candidates = await this.#backend.findPlace(query)

				// Parent soft-gating: `parentID` is a HARD descendant filter in the backend, which wrongly
				// zeroes the result when the parent resolved wrong OR the gazetteer hierarchy is incomplete
				// (a real locality whose `ancestors` chain is missing its region). Rather than turn a
				// resolvable node into an unresolved one, retry once WITHOUT the parent constraint — we
				// prefer a parent-scoped hit but never sacrifice recall. The country constraint is kept, so
				// this still can't wander to a foreign place. Same logical resolution → no extra budget.
				if (!candidates.length && state.parentFallback && query.parentID !== undefined) {
					delete query.parentID
					candidates = await this.#backend.findPlace(query)
				}
			} catch {
				// Defensive: a backend failure should not abort the whole tree walk. Leave the node with
				// its classifier attribution intact.
				return null
			}
		}

		// Postcode-prefix prior (#31, Mechanism 3): when a `postalcode` node misses the gazetteer, derive
		// the code's prefix and probe the injected PFX1 index (structural — never a model input). A hit
		// resolves the node to a synthetic place (id 0), carrying a coordinate ONLY when the index node
		// does — the ancestry-only tier stays coordinate-free (B3-3's 0% half, meaning-of-zero). The
		// prior's payload is returned as node metadata for #walk to stamp. Opt-in via `postcodePrefixPrior`
		// + `postcodePrefixIndex`; OFF by default (D-rule: the PCN1 posture).
		if (!candidates.length && placetype === "postalcode" && state.postcodePrefixPrior && state.postcodePrefixIndex) {
			const probe = probePostcodePrefix(node.value, state.postcodePrefixIndex, query.country)

			if (probe) {
				const metadata: Record<string, unknown> = {
					postcode_prefix: probe.prefix,
					postcode_prefix_ancestors: probe.node.ancestors,
					...(probe.node.radiusP95Km !== undefined ? { postcode_prefix_radius_p95_km: probe.node.radiusP95Km } : {}),
					...(probe.node.lat !== undefined && probe.node.lon !== undefined
						? { coordinate_source: "postcode_prefix" }
						: {}),
				}

				return {
					top: postcodePrefixResolvedPlace(probe.prefix, probe.node, state.postcodePrefixIndex),
					alternatives: [],
					metadata,
				}
			}
		}

		// The bare-toponym country race (fix B of the bare-country class): a lone locality-tagged span
		// also races the `country` placetype, because the parser tags bare country names `locality`
		// about half the time ("Japan", "China") and the locality filter makes the country row
		// unreachable at any rank. Runs ONLY for the tree's single value-bearing node, so every
		// address-shaped input is byte-stable. The locality winner's prominence arbitrates below;
		// with no locality candidates at all, a country hit resolves the span outright.
		const isBareRace = placetype === "locality" && node === state.bareLocalityNode
		const bareCountry = isBareRace ? await bareCountryCandidate(this.#backend, node.value, query.country) : null
		const bareRegion = isBareRace ? await bareRegionCandidate(this.#backend, node.value, query.country) : null

		if (!candidates.length) {
			// With no locality candidates at all, the admin namesake with the larger population answers
			// outright (the same precedence the dominance rule below applies).
			const admin = pickLargerAdmin(bareCountry, bareRegion)

			if (admin) {
				return {
					top: admin,
					alternatives: [],
					metadata: admin === bareRegion ? { bare_region_repick: true } : { bare_country_repick: true },
				}
			}

			return null
		}

		// Postcode-anchor re-rank (#369): when a country posterior is supplied (from the address's
		// postcode), boost candidates by `anchorWeight * posterior[candidate.country]` and re-sort, so a
		// postcode that pins the country pulls the right-country place over a higher-BM25 foreign namesake
		// (the "Berlin DE vs Berlin US" class the #59 harness measured). No-op when `anchorPosterior` is
		// undefined (the default) → byte-identical resolution.
		//
		// Applied to BOTH region and locality — the two placetypes that suffer cross-country namesake/
		// abbreviation collisions a country posterior can break. The region case is the one #447's window
		// fix couldn't reach: a bare 2-letter abbreviation is shared across countries ("VT" is
		// both Vermont and Viterbo; "ME" both Maine and Messina), so with no country signal the score
		// picks the wrong one — and because resolveTree resolves region FIRST and inherits its country
		// down, a wrong region poisons the locality too. The postcode posterior breaks the tie at the
		// region, and the right country then flows to the locality. (Country/macroregion/county are
		// excluded: they don't exhibit this collision class and carry country via `parentID` when nested.)
		//
		// Tier-SAFE ordering: the candidate's exact-match flag is the PRIMARY key, so the country pin
		// never crosses the exact/partial boundary. WITHIN a tier, `score + anchorWeight * posterior`
		// applies the (soft) country boost. So a confident US postcode keeps the US EXACT region
		// ("ME" → Maine) ahead of a more-populous US PARTIAL match (Missouri) AND, within the exact
		// tier, ahead of a foreign exact match (Messina IT); a soft posterior still blends with score.
		// (A plain additive re-rank loses the tier — it isn't encoded in `score` — and flips
		// "ME" → Missouri / "PA" → Alabama. Backends that don't set `exactMatch` degrade to additive.)
		const anchorEligible = placetype === "region" || placetype === "locality"
		let ranked = candidates

		if (state.anchorPosterior && anchorEligible && candidates.length > 1) {
			const post = state.anchorPosterior
			const w = state.anchorWeight

			// #928 root cause: this sort's within-tier key was `score + w·posterior` — RAW SCORE order,
			// the exact metric #910 deprecated inside the exact tier as bm25-length-poisoned (a famous
			// place's alias-heavy doc reads ~15 pts WORSE than a tiny namesake's clean one; #905
			// measured it). Before #910 the anchor-off path also sorted by score, so the two paths
			// agreed; after, anchor-ON silently reverted to the poisoned metric — a CORRECT GB@1.00
			// pin flipped "London SE15 1DD" to a US namesake because +w·1.0 can't bridge the bm25 gap.
			// The within-tier key is now the backend's PROMINENCE (population + proximity, #938 units)
			// with the posterior as the additive country pin; score stays the final tiebreak. Backends
			// that don't populate `prominence` degrade to the additive score behavior.
			// oxlint-disable-next-line unicorn/no-array-sort -- sorts a freshly-built array; toSorted would double-allocate on a hot path
			ranked = [...candidates].sort((a, b) => {
				const tier = Number(b.exactMatch ?? false) - Number(a.exactMatch ?? false)

				if (tier !== 0) return tier
				const aKey = (a.prominence ?? a.score) + w * (post[a.country] ?? 0)
				const bKey = (b.prominence ?? b.score) + w * (post[b.country] ?? 0)

				return bKey - aKey || b.score - a.score
			})
		}

		// Locale-country soft prior (#27) — the #912 lever's other half, at the tier that decides a bare
		// toponym the model tagged `locality`. `--locale en-GB "Whitby"` answers Whitby, Ontario while
		// `--default-country GB "Whitby"` answers the gold, because the CLI DROPS the locale-inferred
		// country for this shape rather than choosing between "hard filter" and "nothing". This is the
		// third option: an additive bonus inside the exact tier, never a filter.
		//
		// Three stand-downs, in the order they matter. A `defaultCountry` makes the prior a no-op by
		// construction (every candidate is already in it), so we skip the work rather than pretend. An
		// `anchorPosterior` is derived from the address's OWN postcode — evidence, which outranks a guess
		// about where the user is sitting. And an absent prior is the SHIPPED default: `ResolveOpts`
		// documents why (the weight that flips the four bare GB rows and the weight that holds the en-US
		// board are disjoint intervals), so this is inert unless a caller opts in.
		//
		// Runs BEFORE the importance key deliberately, matching span-rescore: fame is the stronger signal
		// wherever it has been measured, and it leaves an unscored candidate exactly where the prior put it.
		if (state.localeCountryPrior && !state.defaultCountry && !state.anchorPosterior && anchorEligible) {
			ranked = rankByCountryPrior(ranked, state.localeCountryPrior, state.localeCountryPriorWeight)
		}

		// Importance-first (#17/#28). Before this key a bare famous name was decided on POPULATION
		// alone, which is measurably the wrong prior for the class: `Whitby` answered Whitby, Ontario
		// (128,377) over Whitby, North Yorkshire (13,130), 5,508 km from where the person meant. Fame is
		// what a bare toponym is asking about, and the candidate build's blended `importance` column
		// measures it. Tier-safe and positive-evidence-only (an UNSCORED candidate keeps the rank
		// population gave it; only the scored ones permute), so it abstains byte-stably on an artifact
		// that predates the column.
		//
		// Skipped outright when an anchor posterior is in force. Fame is the prior of LAST resort: it answers
		// "which one did you probably mean" only when nothing in the query answered it, and a #369 posterior is
		// derived from the address's OWN postcode. Evidence outranks a prior. See `toponym-prior.ts`.
		if (!state.anchorPosterior) {
			ranked = rankByImportance(ranked)
		}

		// Admin-containment partition (#1717 stage 2): the LAST soft re-rank, after the anchor/fame keys
		// above, because the qualifier is the address's OWN text — evidence, which outranks a prior. The
		// backend already put contained rows first; this second partition is load-bearing, not belt-and-
		// braces: `rankByImportance` just re-ordered the exact tier by fame, and Richmond, Virginia
		// outscores Richmond, North Yorkshire on importance — without this the lever loses exactly where
		// fame disagrees with the qualifier (the shared-function partition, tier-safe + stable, so it can
		// never promote a contained partial match over an exact one). No stamps → identity → byte-stable
		// on any backend that ignored `regionQualifier`.
		if (containmentEligible) {
			ranked = partitionByContainment(
				ranked,
				(c) => c.containedByQualifier === true,
				(c) => c.exactMatch === true
			)
		}

		// Exact-type preference (#718): when the placetype-equivalence group let a broader admin tier
		// (`macroregion`/`macrocounty`) into the candidate pool, prefer a candidate of the EXACT
		// requested type over the macro fallback — a real `region` (US state, DE Bundesland, ES
		// provincia) must win over a same-name macroregion namesake, so no real region silently
		// downgrades to a macro. STABLE partition: exact-type candidates keep their (already-ranked)
		// relative order ahead of fallbacks, so the score / anchor re-rank survives WITHIN each tier.
		// No-op for placetypes without a macro fallback (the byte-stable default) and when every
		// candidate is the same tier.
		const hasFallbackCandidate = ranked.some((c) => isPlacetypeFallback(placetype, c.placetype))

		if (hasFallbackCandidate && ranked.length > 1) {
			ranked = [
				...ranked.filter((c) => !isPlacetypeFallback(placetype, c.placetype)),
				...ranked.filter((c) => isPlacetypeFallback(placetype, c.placetype)),
			]
		}

		const top = ranked[0]!

		if (top.score < state.minWinningScore) return null

		// The admin side of the bare-toponym race. The COUNTRY row wins on prominence alone —
		// Japan-the-country (pop 126M) over Japan, Pennsylvania (pop 0) — while the REGION row must
		// DOMINATE the locality winner by {@link BARE_REGION_DOMINANCE_LOG10} in log-population:
		// prominence saturates at the backend's populationBoost cap, so the margin is measured on the
		// raw populations, and the margin is what keeps bare "New York" on the city (state 19.6M vs
		// city 8.8M = 0.35, under the cut) while bare "Georgia" promotes to the 11M state over the
		// Vermont hamlet (margin 3.4). A bare name with no admin namesake never reaches these lines,
		// and the displaced locality stays first among the alternatives either way.
		if (bareCountry && (bareCountry.prominence ?? bareCountry.score) > (top.prominence ?? top.score)) {
			return { top: bareCountry, alternatives: ranked, metadata: { bare_country_repick: true } }
		}

		if (bareRegion && logPopulation(bareRegion) >= logPopulation(top) + BARE_REGION_DOMINANCE_LOG10) {
			return { top: bareRegion, alternatives: ranked, metadata: { bare_region_repick: true } }
		}

		// Fallback-observability (#718): if the winner is a macro-type AND no exact-type candidate
		// existed for this span, annotate that a broader tier stood in for the true one. Additive —
		// identity/coordinate are unchanged; only `metadata.resolution_quality` is stamped downstream.
		if (isPlacetypeFallback(placetype, top.placetype)) {
			top.resolutionQuality = "fallback"
		}

		// The lever's trace stamp (#1717 stage 2 / #1719's rule): an opted-in mechanism that cannot fire
		// — a pre-sidecar artifact, an incapable backend — must say so in the result, not degrade
		// silently. The parse-side census cannot see resolver levers, so this stamp is its census
		// surface. Only under the lever: the stamp asserts a question was asked.
		return {
			top,
			alternatives: ranked.slice(1),
			...(containmentEligible ? { metadata: { admin_containment: adminContainmentVerdict(ranked) } } : {}),
		}
	}
}
