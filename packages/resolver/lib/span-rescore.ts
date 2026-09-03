/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #370 span-rescore — recover a dropped/fragmented locality from the RAW text when a parse fails to
 *   resolve. The model sometimes fragments an accented or non-ASCII locality token ("Grudziądz"
 *   splits into "Grudzi" + "dz" on the ą combining mark, #555), so neither fragment resolves and
 *   the address comes back with no coordinate. But the whole word sits intact in the raw input — a
 *   whitespace tokenizer sees it where the model's subword tokenizer didn't.
 *
 *   This module is the PURE, backend-agnostic core: enumerate contiguous raw-token spans, exact-match
 *   them against the same-country gazetteer, and return the best locality candidate. The resolver
 *   (`resolve.ts` → `applySpanRescore`) owns the integration: it runs this ONLY on an unresolved
 *   tree (the #685 brake — never second-guess a working coordinate) and injects the recovered
 *   locality as a resolved node. Default-ON (#370, promoted 2026-06-25 — same-harness EU+AU +1pp
 * @25km, zero regressions); explicit opt-out via `ResolveOpts.spanRescore: false`, byte-stable then.
 *
 *   The design + thresholds are validated on a 7-locale coordinate panel
 *   (`scripts/eval/span-rescore-validate.ts`, eval
 *   `docs/articles/evals/experiments/2026-06-23-370-span-rescore.mdx`): longest-exact-match-wins (the gold
 *   locality is usually the LONGER, more-specific name — shortest- wins grabs the ambiguous prefix
 *   "Tomaszów" of "Tomaszów Mazowiecki", 135 km off), and a postcode- consistency check that rejects
 *   a match far from where the postcode resolves (kills coverage-gap false-positives where the
 *   backend has postcode coverage).
 */

import type { AddressNode } from "@mailwoman/core/decoder"
import type { ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"
import { haversineKm } from "@mailwoman/spatial"

import { foldName } from "#fold-name"
import { DEFAULT_COUNTRY_PRIOR_WEIGHT, rankByCountryPrior, rankByImportance } from "#toponym-prior"

export interface SpanRescoreOptions {
	/**
	 * ISO-3166 alpha-2 country to constrain the gazetteer match (the parse's detected/ default country).
	 */
	country?: string
	/**
	 * Sibling postcode — used both as the backend disambiguation hint AND the consistency-check anchor.
	 */
	postcode?: string
	/**
	 * Reject a candidate whose coordinate is farther than this (km) from the postcode anchor. The check only fires when
	 * the postcode resolves to a point in the backend; otherwise it can't and the match is accepted (so it never
	 * penalizes a backend without postcode coverage). 0 disables. Default 50.
	 */
	gateKm?: number
	/**
	 * Max contiguous raw tokens to treat as one locality span. Default 4.
	 */
	maxSpanTokens?: number
	/**
	 * Min confidence for a street/house_number/postcode node to count as a span-blocking constituent. Default 0.7.
	 */
	confidentThreshold?: number
	/**
	 * #942 postal-compound recovery. A globbed postcode span ("1382 Kožljek") normally (a) fails to anchor (the compound
	 * matches no bare-code gazetteer row) and (b) blocks its own trailing city tokens from recovery. When on: the anchor
	 * retries with the postcode's code-shaped (digit-bearing) token subset, and an UNRESOLVED postcode node blocks only
	 * those code tokens — the residual name tokens become span material. Street/affix blocking is untouched (the "Ave,
	 * France" guard). Default false.
	 */
	postalCompoundRecovery?: boolean
	/**
	 * #17 bare-toponym soft country. When the span covers the WHOLE unqualified input, treat {@link country} as an
	 * additive prior instead of a hard gazetteer filter (see the block comment on {@link findRescoreCandidate}'s bare
	 * branch). Default true; `false` restores the hard filter byte-for-byte.
	 */
	bareToponymSoftCountry?: boolean
	/**
	 * Weight of that prior, in log10-population units. Default {@link DEFAULT_COUNTRY_PRIOR_WEIGHT} (2). A large value
	 * makes the country effectively hard again without changing the code path; 0 removes the locale's say entirely.
	 */
	bareToponymCountryWeight?: number
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
	 * Whether the postcode-consistency check FIRED for this recovery — i.e. the postcode resolved to a point and the
	 * match was validated within `gateKm` of it. `true` = high-precision (postcode- consistent); `false` = unrestricted
	 * (no postcode→point coverage for this country, so the match wasn't geo-validated — the ~83%-precision case). The
	 * caller surfaces this as `metadata.rescore_postcode_verified` so a consumer can threshold on it WITHOUT a hidden
	 * per-country coverage map. Deliberately NOT folded into the calibrated `confidence` — that would break the isotonic
	 * guarantee (a true calibrated 0.83 must not be confused with a rescore plug-in estimate).
	 */
	postcodeVerified: boolean
	/**
	 * The SAME-SPAN namesake runner-ups — the other exact-name matches this recovery's own lookup already returned, in
	 * the backend's rank order, minus the winner and minus anything the postcode check rejected. Empty when the span
	 * named exactly one place.
	 *
	 * #1537: these were being discarded. A name the model reads as a `street` ("Springfield", "Berlin", "Manchester",
	 * "Moscow", "Fulda") never reaches the admin walk, so the whole tree comes back unresolved and THIS tier is what
	 * recovers it — and it decorated the injected node with no alternatives at all. The result was that the geocode
	 * path's `candidates` array held one entry, and the top-1-vs-top-2 dominance margin that `declared_ambiguity` reads
	 * was uncomputable, for exactly the famous-homonym class that marker exists for. Measured on the shipped candidate
	 * backend, 2026-08-07: those five queries returned 1 candidate each while `Cambridge`/`Athens`/`Paris` — the same
	 * class, but parsed as `locality` — returned 4-5.
	 *
	 * The winner is unchanged by their presence: the pick is still the first check-passing exact match, and these are the
	 * ones that came after it. This costs no extra query — they were in the same `findPlace` response.
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
 * The code-shaped (digit-bearing) token subset of a postcode string — "1382 Kožljek" → "1382", "SW1A 1AA London" →
 * "SW1A 1AA". The #942 recovery resolves THIS against the gazetteer's bare-code rows when the globbed compound fails.
 * Empty string when no token carries a digit.
 */
export function postcodeCodeSubset(postcode: string): string {
	return postcode
		.split(/[\s,;/]+/)
		.filter((t) => /\d/.test(t))
		.join(" ")
		.trim()
}

/**
 * Over-fetch for the #17 bare-toponym probe. Without a country filter the top 5 worldwide bearers of a common name are
 * often all in one country, and the candidate the soft prior exists to promote sits below the fold — "Warwick" puts
 * five US rows ahead of Warwick, Warwickshire. The backend orders by the same population key either way, so a wider
 * window only admits more of the same list.
 */
const BARE_TOPONYM_FETCH = 20

/**
 * True when the tree names its OWN admin context — a region, subregion, country, postcode or house number the parser
 * read out of the input. Such a query is not relying on a locale guess, so the #17 soft-country prior stands down and
 * the hard filter keeps its say: this is what holds 'Berlin, Wisconsin' on Berlin, Wisconsin.
 */
function hasAdminQualifier(roots: readonly AddressNode[]): boolean {
	const stack: AddressNode[] = [...roots]

	while (stack.length) {
		const n = stack.pop()!

		if (
			(n.tag === "region" ||
				n.tag === "subregion" ||
				n.tag === "country" ||
				n.tag === "postcode" ||
				n.tag === "house_number") &&
			n.value.trim().length
		) {
			return true
		}

		if (n.children?.length) {
			stack.push(...n.children)
		}
	}

	return false
}

/**
 * True if any node in the tree already carries a resolved place id — the #685 brake.
 */
export function hasResolvedPlace(roots: readonly AddressNode[]): boolean {
	const stack: AddressNode[] = [...roots]

	while (stack.length) {
		const n = stack.pop()!

		if (n.placeID) return true

		if (n.children?.length) {
			stack.push(...n.children)
		}
	}

	return false
}

/**
 * Char ranges of confident street / house_number / postcode constituents, including the street affixes (`street_prefix`
 * / `street_suffix`) — a locality span must not overlap them. The affixes matter: a confident "Ave" in "350 5th Ave,
 * NY" is a street suffix, not a locality, and without this guard the recovery exact-matches it against a same-named
 * place ("Ave", France) and injects a bogus locality.
 */
/**
 * Ranges of MULTI-TOKEN `country` / `region` spans, used to block their INTERIOR tokens from being re-read as
 * standalone places. The whole span itself stays probeable — only proper sub-spans are refused.
 *
 * The parse grouping is the claim: when the model binds `Papua`, `New` and `Guinea` into one country span, `New` is a
 * modifier inside a name, not a name. Probing it anyway matches a real US place (`New`, wof:1276997945) and pins the
 * address to Kentucky — an answer strictly worse than none, because it is confident and wrong.
 *
 * Deliberately NOT confidence-conditioned, unlike {@link confidentRanges}. The country node in that case carries 0.68,
 * under the 0.7 bar, and a low-confidence GROUPING is still a grouping: the tokens were read as one name either way,
 * and the interior of a name the parse doubts is not thereby a better standalone candidate. Single-token spans are
 * excluded — there is no interior to protect.
 */
function multiTokenNameInteriors(roots: readonly AddressNode[], raw: string): Array<[number, number]> {
	const out: Array<[number, number]> = []
	const stack: AddressNode[] = [...roots]

	while (stack.length) {
		const n = stack.pop()!

		if (
			(n.tag === "country" || n.tag === "region") &&
			Number.isFinite(n.start) &&
			Number.isFinite(n.end) &&
			tokenizeRaw(raw.slice(n.start, n.end)).length > 1
		) {
			out.push([n.start, n.end])
		}

		stack.push(...n.children)
	}

	return out
}

function confidentRanges(
	roots: readonly AddressNode[],
	threshold: number,
	raw: string,
	postalCompoundRecovery: boolean
): Array<[number, number]> {
	const out: Array<[number, number]> = []
	const stack: AddressNode[] = [...roots]

	while (stack.length) {
		const n = stack.pop()!

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
			// #942: an UNRESOLVED postcode span blocks only its code-shaped tokens — the globbed trailing
			// city name ("1382 Kožljek") is exactly the recoverable material. Resolved postcodes and the
			// street family keep the full-range block (the "Ave, France" guard).
			if (postalCompoundRecovery && n.tag === "postcode" && !n.placeID) {
				for (const t of tokenizeRaw(raw.slice(n.start, n.end))) {
					if (/\d/.test(t.text)) {
						out.push([n.start + t.start, n.start + t.end])
					}
				}
			} else {
				out.push([n.start, n.end])
			}
		}

		if (n.children?.length) {
			stack.push(...n.children)
		}
	}

	return out
}

/**
 * Find the best locality the raw text exact-matches in the gazetteer. Returns null when nothing matches (or the
 * postcode check rejects every match). Callers test `hasResolvedPlace` first.
 */
export async function findRescoreCandidate(
	raw: string,
	roots: readonly AddressNode[],
	backend: ResolverBackend,
	opts: SpanRescoreOptions = {}
): Promise<RescoreCandidate | null> {
	const gateKm = opts.gateKm ?? 50
	const maxSpan = opts.maxSpanTokens ?? 4
	const threshold = opts.confidentThreshold ?? 0.7
	const country = opts.country
	const postcode = opts.postcode?.trim() || undefined

	// Postcode-consistency anchor: where does the postcode itself resolve? (No-op when the backend has
	// no postcode coverage — findPlace returns nothing → no anchor → check can't fire → match accepted.)
	let anchor: { lat: number; lon: number } | null = null

	if (postcode && gateKm > 0) {
		// #961: both anchor probes are postalcode-TYPED. Untyped, a truncated code fragment (v5.3.0
		// emits "250 Zabiče" → subset "250") name-matches arbitrary places ("Chak No 250", PK) and the
		// false anchor then EXCLUDES the true village. A typed miss leaves anchor=null → the match is
		// accepted unrestricted, which is the correct degradation for an unverifiable code.
		const pcHits = await backend.findPlace({ text: postcode, country, placetype: "postalcode", limit: 2 })
		const a = pcHits.find((h) => h.lat !== 0 || h.lon !== 0)

		if (a) {
			anchor = { lat: a.lat, lon: a.lon }
		}

		// #942: the globbed compound ("1382 Kožljek") matches no bare-code row — retry the anchor with
		// the code-shaped token subset so the consistency check can validate the recovered city.
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
	const overlapsAvoid = (s: number, e: number) => avoid.some(([as, ae]) => s < ae && as < e)
	// Proper sub-spans of a multi-token country/region name are refused; the whole span is not.
	const nameInteriors = multiTokenNameInteriors(roots, raw)

	const isNameInterior = (s: number, e: number) =>
		nameInteriors.some(([ns, ne]) => s >= ns && e <= ne && !(s === ns && e === ne))

	// Enumerate contiguous spans, LONGEST first — the gold locality is usually the more-specific
	// (longer) name; longest-wins lets it beat its own ambiguous prefix.
	interface Span {
		text: string
		start: number
		end: number
		len: number
	}

	const spans: Span[] = []

	for (let len = Math.min(maxSpan, toks.length); len >= 1; len--) {
		for (let i = 0; i + len <= toks.length; i++) {
			const start = toks[i]!.start
			const end = toks[i + len - 1]!.end

			if (overlapsAvoid(start, end)) continue

			if (isNameInterior(start, end)) continue
			spans.push({ text: raw.slice(start, end), start, end, len })
		}
	}

	spans.sort((a, b) => b.len - a.len)

	// #17 bare-toponym soft country. The caller's `country` is a LOCALE DEFAULT, not knowledge — the #961
	// block below already says so, and for a bare city name it is the ONLY country signal there is, which
	// makes hard-filtering on it the worst possible use of it. Measured through the compiled CLI on
	// 2026-08-10: `--locale en-US 'Zürich'` returned Zurich, Kansas (population 81) 8,043 km off, and
	// `--locale en-GB 'Zürich'` returned nothing at all, because GB holds no Zurich to filter down to.
	//
	// So for this ONE query shape the filter is demoted to an additive prior: probe the gazetteer
	// unscoped, then rank with `rankByCountryPrior` so an in-country place may be up to 100x smaller and
	// still win. This is the #912 change ("Paris under en-US must not be hard-scoped to Paris, Texas")
	// applied at the tier that actually decides the class — #912 lives upstream in the CLI and keys on a
	// `locality`-tagged tree, but the model reads a bare famous name as a `street`, so the shape that
	// needs it most is exactly the shape that guard cannot see.
	//
	// The shape check is deliberately narrow. `qualified` below is the D-rule guard: a postcode, a region,
	// a country or a house number in the tree means the address named its own context and a locale guess
	// is no longer the only evidence — 'Berlin, Wisconsin' keeps resolving to Berlin, Wisconsin. And the
	// span must cover the WHOLE input: a sub-span of a longer query is not a bare toponym, so
	// "Weimar Thüringen" falls back to the country-scoped probe that lands the gold.
	const softCountry = opts.bareToponymSoftCountry !== false
	const countryWeight = opts.bareToponymCountryWeight ?? DEFAULT_COUNTRY_PRIOR_WEIGHT
	const qualified = !!postcode || hasAdminQualifier(roots)
	const wholeInput = toks.length ? { start: toks[0]!.start, end: toks.at(-1)!.end } : null
	// Everything the prior needs EXCEPT the span itself — hoisted so the per-span test is one comparison.
	const softCountryEligible = softCountry && !!country && !qualified && !!wholeInput

	for (const sp of spans) {
		const key = foldName(sp.text)

		if (key.length < 2 || /^\d+$/.test(key)) continue // skip bare numbers / empties
		// Whole-input coverage and the soft-country prior are SEPARATE checks. `bare` (the prior) also
		// needs an unqualified tree + a caller country; `wholeSpan` alone decides the alias tier below —
		// a scope-less bare "Riyadh"/"Frankfurt" is still a NAMING (their Latin surfaces live in alias
		// rows: الرياض / Frankfurt am Main), and conflating the two checks cost exactly those rows on the
		// 2026-08-15 board before this line split them.
		const wholeSpan = !!wholeInput && sp.start === wholeInput.start && sp.end === wholeInput.end
		const bare = softCountryEligible && wholeSpan

		const hits = bare
			? rankByCountryPrior(
					await backend.findPlace({ text: sp.text, postcode, placetype: "locality", limit: BARE_TOPONYM_FETCH }),
					country,
					countryWeight
				)
			: // A SUB-span probe is a RE-READING of a token the parse classified into a longer span — it
				// never NAMED an alias, so alias-keyed rows are off for it (`primaryOnly`, the #1632
				// Savile→Rhu door). A whole-input span keeps the alias tier regardless of scope (the
				// Москва/Riyadh-class exonym recall, #1546).
				await backend.findPlace({
					text: sp.text,
					country,
					postcode,
					placetype: "locality",
					limit: 5,
					...(wholeSpan ? {} : { primaryOnly: true }),
				})

		// #1546: NO primary-name re-check here — the backend's `exactMatch` IS the name-OR-alias surface
		// equality (the names table / alt_names bag), so a query matches a place when ANY stored name
		// equals it. Re-comparing only the PRIMARY name folded to [a-z0-9 ] excluded exactly the
		// non-Latin-primary class: Москва folds to "" and could never equal "moscow", so Moscow RU never
		// entered the list and Moscow, Idaho won by default among the Latin-named bearers — population-
		// first ranking starved, not violated. The alias surface is the recall; ranking then does its job.
		// The postcode check below still applies to every admitted candidate, Moscow RU included.
		//
		// #17: importance-first WITHIN the admitted set. The key is the #28 blended fame prior
		// (`PlaceCandidate.importance`, produced by the candidate build) — the only key that separates
		// the bare GB panel rows; on an artifact predating the column it abstains and changes no pick.
		// See `toponym-prior.ts`. It runs after the country prior deliberately: fame is the stronger
		// signal when it has been measured, and leaves an unscored candidate exactly where population
		// put it.
		const exact = rankByImportance(hits.filter((h) => h.exactMatch && (h.lat !== 0 || h.lon !== 0)))

		const withinGate = (p: ResolvedPlace): boolean =>
			!anchor || gateKm <= 0 || haversineKm(anchor.lat, anchor.lon, p.lat, p.lon) <= gateKm

		for (const h of exact) {
			if (!withinGate(h)) continue

			// conditional = the postcode anchor existed AND validated this match (within gateKm). When no anchor
			// (no postcode→point coverage), the match is unrestricted — returned, but flagged lower-precision.
			//
			// #1537: carry the rest of the SAME lookup's exact matches as the namesake runner-ups. Check-filtered on the
			// same rule as the winner — a candidate the postcode check rejected is not a namesake worth offering, it is a
			// place the evidence already excluded. Rank order is the backend's, preserved by `filter`.
			return {
				text: sp.text,
				start: sp.start,
				end: sp.end,
				place: h,
				postcodeVerified: anchor !== null,
				alternatives: exact.filter((a) => a !== h && withinGate(a)),
			}
		}
	}

	// #961 joint country recovery: the caller's `country` is a LOCALE DEFAULT, not knowledge — the
	// CLI's en-US default scoped both the anchor and the village probe to US, so the SI floor never
	// fired through geocode-core while the same rows resolved 25/25 on the resolver harness. When the
	// scoped pass finds nothing and a postcode is present, re-probe the spans UNSCOPED (the admin
	// gazetteer is one extract, all countries), then verify each exact candidate against the postcode's
	// code subset resolved in the CANDIDATE's own country (postcode extracts route by country). A
	// cross-country promotion is accepted ONLY postcode-verified within the radius — never unverified —
	// so a US-shaped query can't wander abroad on a name coincidence (the 48026 guard: resolved
	// trees never reach this code, and unresolved ones must pass the joint postcode check).
	if (opts.postalCompoundRecovery && postcode && gateKm > 0) {
		const code = postcodeCodeSubset(postcode) || postcode.trim()

		for (const sp of spans) {
			const key = foldName(sp.text)

			if (key.length < 2 || /^\d+$/.test(key)) continue
			const hits = await backend.findPlace({ text: sp.text, placetype: "locality", limit: 5 })
			// #1546: same alias-surface admission as the scoped pass — `exactMatch` is name-OR-alias, so a
			// non-Latin primary (Москва) admitted via its Latin alias stays eligible here too. The
			// per-candidate postcode verification below remains the sole admission bar.
			const exact = hits.filter((h) => h.exactMatch && (h.lat !== 0 || h.lon !== 0))

			for (const h of exact) {
				if (!h.country || h.country === country) continue

				// the scoped pass already covered `country`
				const pcHits = await backend.findPlace({
					text: code,
					country: h.country,
					placetype: "postalcode",
					limit: 2,
				})

				const verified = pcHits.find((p) => p.lat !== 0 || p.lon !== 0)

				if (verified && haversineKm(verified.lat, verified.lon, h.lat, h.lon) <= gateKm) {
					// No alternatives from this pass, deliberately. Admission here is per-candidate postcode
					// verification — one `findPlace` per runner-up — and the class it serves is the opposite of the
					// namesake one: a postcode is present and has already picked the country, so there is nothing
					// ambiguous left to declare. The bare-toponym queries #1537 is about never reach this branch (it
					// requires a postcode).
					return { text: sp.text, start: sp.start, end: sp.end, place: h, postcodeVerified: true, alternatives: [] }
				}
			}
		}
	}

	return null
}
