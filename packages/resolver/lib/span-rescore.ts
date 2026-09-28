/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Recover a dropped or fragmented locality from the raw text when a parse fails to resolve, by
 *   matching contiguous raw-token spans against the same-country gazetteer. Default-on with an
 *   explicit `ResolveOpts.spanRescore: false` opt-out.
 */

import { firstNodeWhere, walkNodes, type AddressNode } from "@mailwoman/core/decoder"
import type { ResolvedPlace, ResolverBackend, WeakResolutionReading } from "@mailwoman/core/resolver"
import { isRegionAbbreviationToken } from "@mailwoman/query-shape/region-abbreviations"
import { haversineKm } from "@mailwoman/spatial"

import { partitionByContainment } from "#admin/containment"
import { foldName } from "#fold-name"
import { DEFAULT_COUNTRY_PRIOR_WEIGHT, rankByCountryPrior, rankByImportance } from "#toponym-prior"

export interface SpanRescoreOptions {
	/**
	 * ISO-3166 alpha-2 country to constrain the gazetteer match (the parse's detected/ default country).
	 */
	country?: string
	/**
	 * Sibling postcode — used both as the backend disambiguation hint and the consistency-check anchor.
	 */
	postcode?: string
	/**
	 * Reject a candidate whose coordinate is farther than this (km) from the postcode
	 * anchor. the check fires only when the postcode resolves to a point, so a backend
	 * without postcode coverage is never penalized, and 0 disables.
	 * Default 50.
	 */
	thresholdKm?: number
	/**
	 * Max contiguous raw tokens to treat as one locality span.
	 *
	 * Default 4.
	 */
	maxSpanTokens?: number
	/**
	 * Min confidence for a street/house_number/postcode node to count as a span-blocking constituent.
	 *
	 * Default 0.7.
	 */
	confidentThreshold?: number
	/**
	 * When on, the anchor retries with the postcode's code-shaped token subset and an unresolved
	 * postcode node blocks only those code tokens, leaving the residual name tokens as span material.
	 *
	 * Street/affix blocking is untouched.
	 * Default false.
	 */
	postalCompoundRecovery?: boolean
	/**
	 * When the span covers the whole unqualified input, treat {@link country} as an additive prior
	 * instead of a hard gazetteer filter; `false` restores the hard filter byte-for-byte.
	 * Default true.
	 */
	bareToponymSoftCountry?: boolean
	/**
	 * Weight of that prior, in log10-population units.
	 *
	 * Default {@link DEFAULT_COUNTRY_PRIOR_WEIGHT} (2), and 0 removes the locale's say entirely.
	 */
	bareToponymCountryWeight?: number
	/**
	 * Admit a proper sub-span only when every token it leaves behind is a subdivision code or a number.
	 *
	 * See `remainderIsContext` for the rule.
	 * Default false.
	 */
	spanRescoreRequireContextRemainder?: boolean
}

/**
 * The recovered locality: the raw span and the gazetteer place it resolved to.
 */
export interface RescoreCandidate {
	/**
	 * The raw text of the winning span.
	 */
	text: string
	/**
	 * Char offsets of the span in the raw input.
	 */
	start: number
	end: number
	/**
	 * The resolved gazetteer place (decorate a node with this).
	 */
	place: ResolvedPlace
	/**
	 * Whether the postcode-consistency check fired — the postcode resolved to a point
	 * and the match was validated within `thresholdKm` — deliberately kept out of the
	 * calibrated `confidence` so the isotonic fit stays monotone.
	 */
	postcodeVerified: boolean
	/**
	 * The same-span namesake runner-ups this recovery's own lookup already returned,
	 * in backend rank order, minus the winner and anything the postcode check rejected,
	 * so the top-1-vs-top-2 dominance margin stays computable.
	 */
	alternatives: ResolvedPlace[]
}

interface RawTok {
	text: string
	start: number
	end: number
}

/**
 * Whitespace/punctuation tokenization of the raw input, char offsets preserved, diacritics intact.
 */
function tokenizeRaw(raw: string): RawTok[] {
	const toks: RawTok[] = []
	const re = /[^\s,;/]+/g
	let m: RegExpExecArray | null

	while ((m = re.exec(raw)) !== null) {
		toks.push({ text: m[0], start: m.index, end: m.index + m[0].length })
	}

	return toks
}

/**
 * The code-shaped (digit-containing) token subset of a postcode string — "1382 Kožljek"
 * → "1382" — and an empty string when no token carries a digit.
 */
export function postcodeCodeSubset(postcode: string): string {
	return postcode
		.split(/[\s,;/]+/)
		.filter((t) => /\d/.test(t))
		.join(" ")
		.trim()
}

/**
 * Over-fetch for the bare-toponym probe: without a country filter the top 5 worldwide bearers of a
 * common name are often all in one country, with the candidate the soft prior promotes below the fold.
 */
const BARE_TOPONYM_FETCH = 20

/**
 * True when the tree names its own admin context — a region, subregion, country,
 * postcode or house number the parser read out of the input — so the soft-country
 * prior stands down and the hard filter keeps its say.
 */
function hasAdminQualifier(roots: readonly AddressNode[]): boolean {
	return (
		firstNodeWhere(
			roots,
			(n) =>
				(n.tag === "region" ||
					n.tag === "subregion" ||
					n.tag === "country" ||
					n.tag === "postcode" ||
					n.tag === "house_number") &&
				n.value.trim().length > 0
		) !== undefined
	)
}

/**
 * Whether one node's resolution rests on evidence thin enough to re-open, under `reading`.
 */
function resolvedWeakly(node: AddressNode, reading: WeakResolutionReading): boolean {
	const metadata = node.metadata ?? {}
	const weakScore = metadata["resolver_score"] === 0
	const weakContainment = metadata["admin_containment"] === "no_contained_candidate"

	if (reading === "score") return weakScore

	if (reading === "containment") return weakContainment

	return weakScore || weakContainment
}

/**
 * True if any node in the tree already carries a resolved place id — the brake on span rescore.
 * with `weakReading`, a node whose resolution is weak under that reading does not hold it.
 */
export function hasResolvedPlace(
	roots: readonly AddressNode[],
	weakReading: WeakResolutionReading | false = false
): boolean {
	return (
		firstNodeWhere(roots, (n) => Boolean(n.placeID) && !(weakReading && resolvedWeakly(n, weakReading))) !== undefined
	)
}

/**
 * Ranges of multi-token `country` / `region` spans, used to block their interior
 * tokens from being re-read as standalone places.
 *
 * The whole span stays probeable, single-token spans are excluded, and the guard
 * is deliberately not confidence-conditioned.
 */
function multiTokenNameInteriors(roots: readonly AddressNode[], raw: string): Array<[number, number]> {
	const out: Array<[number, number]> = []

	for (const n of walkNodes(roots)) {
		if (
			(n.tag === "country" || n.tag === "region") &&
			Number.isFinite(n.start) &&
			Number.isFinite(n.end) &&
			tokenizeRaw(raw.slice(n.start, n.end)).length > 1
		) {
			out.push([n.start, n.end])
		}
	}

	return out
}

/**
 * The confident ranges split by what a span containing one means: `hard`
 * (house number, postcode, street body) refuses any overlap, while `affix` refuses
 * a span only when it does not strictly contain the affix.
 */
interface ConfidentRanges {
	hard: Array<[number, number]>
	affix: Array<[number, number]>
}

/**
 * The character ranges the parse read as street material, context only
 * when the range does not overlap the span under test.
 */
function streetRanges(roots: readonly AddressNode[]): Array<[number, number]> {
	const out: Array<[number, number]> = []

	for (const n of walkNodes(roots)) {
		if (
			(n.tag === "street" || n.tag === "street_prefix" || n.tag === "street_suffix") &&
			Number.isFinite(n.start) &&
			Number.isFinite(n.end)
		) {
			out.push([n.start, n.end])
		}
	}

	return out
}

function confidentRanges(
	roots: readonly AddressNode[],
	threshold: number,
	raw: string,
	postalCompoundRecovery: boolean
): ConfidentRanges {
	const out: Array<[number, number]> = []
	const affix: Array<[number, number]> = []

	for (const n of walkNodes(roots)) {
		if (
			(n.tag === "postcode" ||
				n.tag === "house_number" ||
				n.tag === "street" ||
				n.tag === "street_prefix" ||
				n.tag === "street_suffix") &&
			(n.confidence ?? 0) >= threshold &&
			Number.isFinite(n.start) &&
			Number.isFinite(n.end)
		) {
			// An unresolved postcode span blocks only its code-shaped tokens.
			// Resolved postcodes and the street family keep the full-range block.
			if (postalCompoundRecovery && n.tag === "postcode" && !n.placeID) {
				for (const t of tokenizeRaw(raw.slice(n.start, n.end))) {
					if (/\d/.test(t.text)) {
						out.push([n.start + t.start, n.start + t.end])
					}
				}
			} else if (n.tag === "street_prefix" || n.tag === "street_suffix") {
				affix.push([n.start, n.end])
			} else {
				out.push([n.start, n.end])
			}
		}
	}

	return { hard: out, affix }
}

/**
 * Find the best locality the raw text exact-matches in the gazetteer; `null` when no entry matches
 * or the postcode check rejects every match, and callers test `hasResolvedPlace` first.
 */
export async function findRescoreCandidate(
	raw: string,
	roots: readonly AddressNode[],
	backend: ResolverBackend,
	opts: SpanRescoreOptions = {}
): Promise<RescoreCandidate | null> {
	const thresholdKm = opts.thresholdKm ?? 50
	const maxSpan = opts.maxSpanTokens ?? 4
	const threshold = opts.confidentThreshold ?? 0.7
	const country = opts.country
	const postcode = opts.postcode?.trim() || undefined

	// The postcode-consistency anchor.
	// No candidate leaves it null, so the check cannot fire and the match is accepted.
	let anchor: { lat: number; lon: number } | null = null

	if (postcode && thresholdKm > 0) {
		// Both anchor probes are `postalcode`-typed: an untyped truncated code fragment
		// name-matches arbitrary places and the false anchor then excludes the true village.
		const pcHits = await backend.findPlace({ text: postcode, country, placetype: "postalcode", limit: 2 })
		const a = pcHits.find((h) => h.lat !== 0 || h.lon !== 0)

		if (a) {
			anchor = { lat: a.lat, lon: a.lon }
		}

		// The globbed compound matches no bare-code row, so retry the anchor with the code-shaped token subset.
		if (!anchor && opts.postalCompoundRecovery) {
			const code = postcodeCodeSubset(postcode)

			if (code && code !== postcode) {
				const codeHits = await backend.findPlace({ text: code, country, placetype: "postalcode", limit: 2 })
				const c = codeHits.find((h) => h.lat !== 0 || h.lon !== 0)

				if (c) {
					anchor = { lat: c.lat, lon: c.lon }
				}
			}
		}
	}

	const toks = tokenizeRaw(raw)
	const avoid = confidentRanges(roots, threshold, raw, opts.postalCompoundRecovery ?? false)
	const streets = streetRanges(roots)

	const overlapsAvoid = (s: number, e: number) =>
		avoid.hard.some(([as, ae]) => s < ae && as < e) ||
		avoid.affix.some(([as, ae]) => {
			if (e <= as || ae <= s) return false // disjoint — the affix has no say
			const strictlyContains = s <= as && ae <= e && e - s > ae - as

			return !strictlyContains
		})

	const nameInteriors = multiTokenNameInteriors(roots, raw)

	const isNameInterior = (s: number, e: number) =>
		nameInteriors.some(([ns, ne]) => s >= ns && e <= ne && !(s === ns && e === ne))

	// Enumerate contiguous token windows up to `maxSpan` and probe them longest first by
	// character extent, so a region code and a locality of equal token count order by extent.
	interface Span {
		text: string
		start: number
		end: number
	}

	const spans: Span[] = []

	for (let len = Math.min(maxSpan, toks.length); len >= 1; len--) {
		for (let i = 0; i + len <= toks.length; i++) {
			const start = toks[i]!.start
			const end = toks[i + len - 1]!.end

			if (overlapsAvoid(start, end)) continue

			if (isNameInterior(start, end)) continue
			spans.push({ text: raw.slice(start, end), start, end })
		}
	}

	spans.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start)

	// For a bare toponym the caller's `country` is a locale default rather than knowledge, so the hard
	// filter is demoted to an additive prior and the span must cover the whole unqualified input.
	/**
	 * The token a sub-span probe leaves behind when it reads as an administrative qualifier: one token
	 * of 2 or 3 uppercase ASCII letters, shaped as a subdivision code rather than looked up in a table.
	 */
	const qualifierRemainder = (span: { start: number; end: number }): string | undefined => {
		const outside = toks.filter((t) => t.end <= span.start || t.start >= span.end)

		if (outside.length !== 1) return undefined

		const token = outside[0]!.text

		return isRegionAbbreviationToken(token, { maxLetters: 3 }) ? token : undefined
	}

	/**
	 * Whether every token a sub-span leaves behind is context rather than identity,
	 * testing the remainder's shape rather than the span being proper.
	 */
	const remainderIsContext = (span: { start: number; end: number }): boolean => {
		const outside = toks.filter((t) => t.end <= span.start || t.start >= span.end)

		if (!outside.length) return true

		const streetContext = streets.filter(([start, end]) => end <= span.start || start >= span.end)

		return outside.every(
			(t) =>
				isRegionAbbreviationToken(t.text, { maxLetters: 3 }) ||
				/^\d+[\d-]*$/.test(t.text) ||
				streetContext.some(([start, end]) => t.start >= start && t.end <= end)
		)
	}

	const softCountry = opts.bareToponymSoftCountry !== false
	const countryWeight = opts.bareToponymCountryWeight ?? DEFAULT_COUNTRY_PRIOR_WEIGHT
	const qualified = !!postcode || hasAdminQualifier(roots)
	const wholeInput = toks.length ? { start: toks[0]!.start, end: toks.at(-1)!.end } : null
	const softCountryEligible = softCountry && !!country && !qualified && !!wholeInput

	for (const sp of spans) {
		const key = foldName(sp.text)

		if (key.length < 2 || /^\d+$/.test(key)) continue // skip bare numbers / empties
		// `wholeSpan` alone decides the alias tier, while the soft-country prior also
		// needs an unqualified tree and a caller country.
		const wholeSpan = !!wholeInput && sp.start === wholeInput.start && sp.end === wholeInput.end

		// A sub-span that drops a word of the name is a corruption rather than a
		// recovery. see `remainderIsContext`.
		if (opts.spanRescoreRequireContextRemainder && !wholeSpan && !remainderIsContext(sp)) continue

		const bare = softCountryEligible && wholeSpan
		const qualifier = wholeSpan ? undefined : qualifierRemainder(sp)

		const hits = bare
			? rankByCountryPrior(
					await backend.findPlace({ text: sp.text, postcode, placetype: "locality", limit: BARE_TOPONYM_FETCH }),
					country,
					countryWeight
				)
			: // A SUB-span probe is a RE-READING of a token the parse classified into a longer span — it
				// never named an alias, so alias-keyed rows are off for it (`primaryOnly`); a whole-input
				// span keeps the alias tier regardless of scope.
				await backend.findPlace({
					text: sp.text,
					country,
					postcode,
					placetype: "locality",
					limit: 5,
					...(wholeSpan ? {} : { primaryOnly: true }),
					// The qualifier the sub-span left behind.
					// A backend without the ancestors sidecar ignores it, which is the same answer as not asking.
					...(qualifier === undefined ? {} : { regionQualifier: qualifier }),
				})

		// No primary-name re-check: `exactMatch` is name-or-alias, so re-comparing only
		// the primary name would exclude the non-Latin-primary class.
		//
		// Importance-first within the admitted set.
		// It abstains on an artifact predating the column and so changes no pick.
		const ranked = rankByImportance(hits.filter((h) => h.exactMatch && (h.lat !== 0 || h.lon !== 0)))

		// The same partition the walk applies: tier-safe, stable and positive-evidence-only,
		// so a backend that ignored `regionQualifier` is byte-stable.
		const exact =
			qualifier === undefined
				? ranked
				: partitionByContainment(
						ranked,
						(c) => c.containedByQualifier === true,
						(c) => c.exactMatch === true
					)

		const withinThreshold = (p: ResolvedPlace): boolean =>
			!anchor || thresholdKm <= 0 || haversineKm(anchor.lat, anchor.lon, p.lat, p.lon) <= thresholdKm

		for (const h of exact) {
			if (!withinThreshold(h)) continue

			// `postcodeVerified` is true only when an anchor existed and validated this match within
			// `thresholdKm`; otherwise the match is returned unrestricted but flagged lower-precision.
			return {
				text: sp.text,
				start: sp.start,
				end: sp.end,
				place: h,
				postcodeVerified: anchor !== null,
				alternatives: exact.filter((a) => a !== h && withinThreshold(a)),
			}
		}
	}

	// Joint country recovery: when the scoped pass finds no match and a postcode
	// is present, re-probe unscoped and accept a cross-country promotion only
	// when its code subset resolves postcode-verified within the radius.
	if (opts.postalCompoundRecovery && postcode && thresholdKm > 0) {
		const code = postcodeCodeSubset(postcode) || postcode.trim()

		for (const sp of spans) {
			const key = foldName(sp.text)

			if (key.length < 2 || /^\d+$/.test(key)) continue
			const hits = await backend.findPlace({ text: sp.text, placetype: "locality", limit: 5 })
			// Same alias-surface admission as the scoped pass.
			// The per-candidate postcode verification below is the sole admission bar.
			const exact = hits.filter((h) => h.exactMatch && (h.lat !== 0 || h.lon !== 0))

			for (const h of exact) {
				if (!h.country || h.country === country) continue

				const pcHits = await backend.findPlace({
					text: code,
					country: h.country,
					placetype: "postalcode",
					limit: 2,
				})

				const verified = pcHits.find((p) => p.lat !== 0 || p.lon !== 0)

				if (verified && haversineKm(verified.lat, verified.lon, h.lat, h.lon) <= thresholdKm) {
					// No alternatives from this pass: admission is per-candidate postcode verification,
					// and the postcode has already picked the country so no ambiguity is left to declare.
					return { text: sp.text, start: sp.start, end: sp.end, place: h, postcodeVerified: true, alternatives: [] }
				}
			}
		}
	}

	return null
}
