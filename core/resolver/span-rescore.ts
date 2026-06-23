/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #370 span-rescore — recover a dropped/fragmented locality from the RAW text when a parse fails to
 *   resolve. The model sometimes fragments an accented or non-ASCII locality token ("Grudziądz" splits
 *   into "Grudzi" + "dz" on the ą combining mark, #555), so neither fragment resolves and the address
 *   comes back with no coordinate. But the whole word sits intact in the raw input — a whitespace
 *   tokenizer sees it where the model's subword tokenizer didn't.
 *
 *   This module is the PURE, backend-agnostic core: enumerate contiguous raw-token spans, exact-match
 *   them against the same-country gazetteer, and return the best locality candidate. The resolver
 *   (`resolve.ts` → `applySpanRescore`) owns the integration: it runs this ONLY on an unresolved tree
 *   (the #685 brake — never second-guess a working coordinate) and injects the recovered locality as a
 *   resolved node. Opt-in via `ResolveOpts.spanRescore`; default-off + byte-stable when unset.
 *
 *   The design + thresholds are validated on a 7-locale coordinate panel
 *   (`scripts/eval/span-rescore-validate.ts`, eval `docs/articles/evals/2026-06-23-370-span-rescore.mdx`):
 *   longest-exact-match-wins (the gold locality is usually the LONGER, more-specific name — shortest-
 *   wins grabs the ambiguous prefix "Tomaszów" of "Tomaszów Mazowiecki", 135 km off), and a postcode-
 *   consistency gate that rejects a match far from where the postcode resolves (kills coverage-gap
 *   false-positives where the backend has postcode coverage).
 */

import type { AddressNode } from "../decoder/types.js"
import { haversineKm } from "../spatial.js"
import type { ResolvedPlace, ResolverBackend } from "./types.js"

export interface SpanRescoreOptions {
	/** ISO-3166 alpha-2 country to constrain the gazetteer match (the parse's detected/ default country). */
	country?: string
	/** Sibling postcode — used both as the backend disambiguation hint AND the consistency-gate anchor. */
	postcode?: string
	/**
	 * Reject a candidate whose coordinate is farther than this (km) from the postcode anchor. The gate
	 * only fires when the postcode resolves to a point in the backend; otherwise it can't and the match
	 * is accepted (so it never penalizes a backend without postcode coverage). 0 disables. Default 50.
	 */
	gateKm?: number
	/** Max contiguous raw tokens to treat as one locality span. Default 4. */
	maxSpanTokens?: number
	/** Min confidence for a street/house_number/postcode node to count as a span-blocking constituent. Default 0.7. */
	confidentThreshold?: number
}

/** The recovered locality: the raw span and the gazetteer place it resolved to. */
export interface RescoreCandidate {
	/** The raw text of the winning span. */
	text: string
	/** Char offsets of the span in the raw input. */
	start: number
	end: number
	/** The resolved gazetteer place (decorate a node with this). */
	place: ResolvedPlace
	/**
	 * Whether the postcode-consistency gate FIRED for this recovery — i.e. the postcode resolved to a
	 * point and the match was validated within `gateKm` of it. `true` = high-precision (postcode-
	 * consistent); `false` = ungated (no postcode→point coverage for this country, so the match wasn't
	 * geo-validated — the ~83%-precision case). The caller surfaces this as `metadata.rescore_gated` so
	 * a consumer can threshold on it WITHOUT a hidden per-country coverage map. Deliberately NOT folded
	 * into the calibrated `confidence` — that would break the isotonic guarantee (a true calibrated 0.83
	 * must not be confused with a rescore plug-in estimate).
	 */
	gated: boolean
}

/** Normalize for exact comparison: lowercase, strip diacritics + punctuation, collapse whitespace. */
const norm = (s: string): string =>
	s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[^a-z0-9 ]/g, " ")
		.replace(/\s+/g, " ")
		.trim()

interface RawTok {
	text: string
	start: number
	end: number
}
/** Whitespace/punctuation tokenization of the raw input, char offsets preserved, diacritics intact. */
function tokenizeRaw(raw: string): RawTok[] {
	const toks: RawTok[] = []
	const re = /[^\s,;/]+/g
	let m: RegExpExecArray | null
	while ((m = re.exec(raw)) !== null) toks.push({ text: m[0], start: m.index, end: m.index + m[0].length })
	return toks
}

/** True if any node in the tree already carries a resolved place id — the #685 brake. */
export function hasResolvedPlace(roots: readonly AddressNode[]): boolean {
	const stack: AddressNode[] = [...roots]
	while (stack.length) {
		const n = stack.pop()!
		if (n.placeId) return true
		if (n.children?.length) stack.push(...n.children)
	}
	return false
}

/** Char ranges of confident street/house_number/postcode constituents — a locality span must not overlap them. */
function confidentRanges(roots: readonly AddressNode[], threshold: number): Array<[number, number]> {
	const out: Array<[number, number]> = []
	const stack: AddressNode[] = [...roots]
	while (stack.length) {
		const n = stack.pop()!
		if (
			(n.tag === "postcode" || n.tag === "house_number" || n.tag === "street") &&
			(n.confidence ?? 0) >= threshold &&
			Number.isFinite(n.start) &&
			Number.isFinite(n.end)
		) {
			out.push([n.start, n.end])
		}
		if (n.children?.length) stack.push(...n.children)
	}
	return out
}

/**
 * Find the best locality the raw text exact-matches in the gazetteer. Returns null when nothing
 * matches (or the postcode gate rejects every match). Callers gate on `hasResolvedPlace` first.
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
		const pcHits = await backend.findPlace({ text: postcode, country, limit: 2 })
		const a = pcHits.find((h) => h.lat !== 0 || h.lon !== 0)
		if (a) anchor = { lat: a.lat, lon: a.lon }
	}

	const toks = tokenizeRaw(raw)
	const avoid = confidentRanges(roots, threshold)
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
		const exact = hits.filter(
			(h) => h.exactMatch && norm(h.name) === key && (h.lat !== 0 || h.lon !== 0)
		)
		for (const h of exact) {
			if (anchor && gateKm > 0 && haversineKm(anchor.lat, anchor.lon, h.lat, h.lon) > gateKm) continue
			// gated = the postcode anchor existed AND validated this match (within gateKm). When no anchor
			// (no postcode→point coverage), the match is ungated — returned, but flagged lower-precision.
			return { text: sp.text, start: sp.start, end: sp.end, place: h, gated: anchor !== null }
		}
	}
	return null
}
