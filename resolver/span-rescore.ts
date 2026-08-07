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
 *   "Tomaszów" of "Tomaszów Mazowiecki", 135 km off), and a postcode- consistency gate that rejects
 *   a match far from where the postcode resolves (kills coverage-gap false-positives where the
 *   backend has postcode coverage).
 */

import type { AddressNode } from "@mailwoman/core/decoder"
import type { ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"
import { haversineKm } from "@mailwoman/spatial"

export interface SpanRescoreOptions {
	/**
	 * ISO-3166 alpha-2 country to constrain the gazetteer match (the parse's detected/ default country).
	 */
	country?: string
	/**
	 * Sibling postcode — used both as the backend disambiguation hint AND the consistency-gate anchor.
	 */
	postcode?: string
	/**
	 * Reject a candidate whose coordinate is farther than this (km) from the postcode anchor. The gate only fires when
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
	 * Whether the postcode-consistency gate FIRED for this recovery — i.e. the postcode resolved to a point and the match
	 * was validated within `gateKm` of it. `true` = high-precision (postcode- consistent); `false` = ungated (no
	 * postcode→point coverage for this country, so the match wasn't geo-validated — the ~83%-precision case). The caller
	 * surfaces this as `metadata.rescore_gated` so a consumer can threshold on it WITHOUT a hidden per-country coverage
	 * map. Deliberately NOT folded into the calibrated `confidence` — that would break the isotonic guarantee (a true
	 * calibrated 0.83 must not be confused with a rescore plug-in estimate).
	 */
	gated: boolean
	/**
	 * The SAME-SPAN namesake runner-ups — the other exact-name matches this recovery's own lookup already returned, in
	 * the backend's rank order, minus the winner and minus anything the postcode gate rejected. Empty when the span named
	 * exactly one place.
	 *
	 * #1537: these were being discarded. A name the model reads as a `street` ("Springfield", "Berlin", "Manchester",
	 * "Moscow", "Fulda") never reaches the admin walk, so the whole tree comes back unresolved and THIS tier is what
	 * recovers it — and it decorated the injected node with no alternatives at all. The result was that the geocode
	 * path's `candidates` array held one entry, and the top-1-vs-top-2 dominance margin that `declared_ambiguity` reads
	 * was uncomputable, for exactly the famous-homonym class that marker exists for. Measured on the shipped candidate
	 * backend, 2026-08-07: those five queries returned 1 candidate each while `Cambridge`/`Athens`/`Paris` — the same
	 * class, but parsed as `locality` — returned 4-5.
	 *
	 * The winner is unchanged by their presence: the pick is still the first gate-passing exact match, and these are the
	 * ones that came after it. This costs no extra query — they were in the same `findPlace` response.
	 */
	alternatives: ResolvedPlace[]
}

/**
 * Normalize for exact comparison: lowercase, strip diacritics + punctuation, collapse whitespace.
 */
const norm = (s: string): string =>
	s
		.toLowerCase()
		.normalize("NFD")
		.replaceAll(/[^a-z0-9 ]/g, " ")
		.replaceAll(/\s+/g, " ")
		.trim()

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
 * postcode gate rejects every match). Callers gate on `hasResolvedPlace` first.
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
	// no postcode coverage — findPlace returns nothing → no anchor → gate can't fire → match accepted.)
	let anchor: { lat: number; lon: number } | null = null

	if (postcode && gateKm > 0) {
		// #961: both anchor probes are postalcode-TYPED. Untyped, a truncated code fragment (v5.3.0
		// emits "250 Zabiče" → subset "250") name-matches arbitrary places ("Chak No 250", PK) and the
		// false anchor then GATES OUT the true village. A typed miss leaves anchor=null → the match is
		// accepted ungated, which is the correct degradation for an unverifiable code.
		const pcHits = await backend.findPlace({ text: postcode, country, placetype: "postalcode", limit: 2 })
		const a = pcHits.find((h) => h.lat !== 0 || h.lon !== 0)

		if (a) {
			anchor = { lat: a.lat, lon: a.lon }
		}

		// #942: the globbed compound ("1382 Kožljek") matches no bare-code row — retry the anchor with
		// the code-shaped token subset so the consistency gate can validate the recovered city.
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
			spans.push({ text: raw.slice(start, end), start, end, len })
		}
	}

	spans.sort((a, b) => b.len - a.len)

	for (const sp of spans) {
		const key = norm(sp.text)

		if (key.length < 2 || /^\d+$/.test(key)) continue // skip bare numbers / empties
		const hits = await backend.findPlace({ text: sp.text, country, postcode, placetype: "locality", limit: 5 })
		// #1546: NO primary-name re-check here — the backend's `exactMatch` IS the name-OR-alias surface
		// equality (the names table / alt_names bag), so a query matches a place when ANY stored name
		// equals it. Re-comparing only the PRIMARY name folded to [a-z0-9 ] excluded exactly the
		// non-Latin-primary class: Москва folds to "" and could never equal "moscow", so Moscow RU never
		// entered the list and Moscow, Idaho won by default among the Latin-named bearers — population-
		// first ranking starved, not violated. The alias surface is the recall; ranking then does its job.
		// The postcode gate below still applies to every admitted candidate, Moscow RU included.
		const exact = hits.filter((h) => h.exactMatch && (h.lat !== 0 || h.lon !== 0))

		const withinGate = (p: ResolvedPlace): boolean =>
			!anchor || gateKm <= 0 || haversineKm(anchor.lat, anchor.lon, p.lat, p.lon) <= gateKm

		for (const h of exact) {
			if (!withinGate(h)) continue

			// gated = the postcode anchor existed AND validated this match (within gateKm). When no anchor
			// (no postcode→point coverage), the match is ungated — returned, but flagged lower-precision.
			//
			// #1537: carry the rest of the SAME lookup's exact matches as the namesake runner-ups. Gate-filtered on the
			// same rule as the winner — a candidate the postcode gate rejected is not a namesake worth offering, it is a
			// place the evidence already excluded. Rank order is the backend's, preserved by `filter`.
			return {
				text: sp.text,
				start: sp.start,
				end: sp.end,
				place: h,
				gated: anchor !== null,
				alternatives: exact.filter((a) => a !== h && withinGate(a)),
			}
		}
	}

	// #961 joint country recovery: the caller's `country` is a LOCALE DEFAULT, not knowledge — the
	// CLI's en-US default scoped both the anchor and the village probe to US, so the SI floor never
	// fired through geocode-core while the same rows resolved 25/25 on the resolver harness. When the
	// scoped pass finds nothing and a postcode is present, re-probe the spans UNSCOPED (the admin
	// gazetteer is one shard, all countries), then verify each exact candidate against the postcode's
	// code subset resolved in the CANDIDATE's own country (postcode shards route by country). A
	// cross-country promotion is accepted ONLY postcode-verified within the gate — never ungated —
	// so a US-shaped query can't wander abroad on a name coincidence (the 48026 guard: resolved
	// trees never reach this code, and unresolved ones must pass the joint postcode check).
	if (opts.postalCompoundRecovery && postcode && gateKm > 0) {
		const code = postcodeCodeSubset(postcode) || postcode.trim()

		for (const sp of spans) {
			const key = norm(sp.text)

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
					return { text: sp.text, start: sp.start, end: sp.end, place: h, gated: true, alternatives: [] }
				}
			}
		}
	}

	return null
}
