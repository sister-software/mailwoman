/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Cross-language guard for the inference-side anchor features (#239/#240). The feature layout MUST
 *   match the Python training pipeline (`mailwoman_train/tokenizer.py::anchor_feature_vector`), or
 *   the model is fed garbage at inference. These vectors are pinned to values emitted by the Python
 *   function — if the TS drifts (locale order, centroid scale, renormalization), this fails.
 */
import { describe, expect, it } from "vitest"

import {
	ANCHOR_FEATURE_DIM,
	LOCALE_ORDER,
	anchorFeatureVector,
	buildAnchorFeatures,
	countShapedOnlyKeys,
	shapedKeyerObligationViolation,
	type AnchorEntry,
	type AnchorLookup,
} from "./anchor-inference.ts"
import type { TokenizedPiece } from "./tokenizer.ts"

describe("anchorFeatureVector — pinned to Python anchor_feature_vector", () => {
	it("locale order matches Python LOCALE_COUNTRIES", () => {
		expect([...LOCALE_ORDER]).toEqual(["US", "FR", "DE", "CA", "GB", "JP", "ES", "IT", "NL"])
		expect(ANCHOR_FEATURE_DIM).toBe(11)
	})

	it("a DE+US collision (10115) byte-matches Python", () => {
		// python: anchor_feature_vector({"DE":0.5,"US":0.5}, 52.5323, 13.3846)
		const v = anchorFeatureVector({ DE: 0.5, US: 0.5 }, 52.5323, 13.3846)
		const expected = [0.5, 0, 0.5, 0, 0, 0, 0, 0, 0, 0.583692, 0.074359]
		expected.forEach((e, i) => expect(v[i]!).toBeCloseTo(e, 5))
	})

	it("a DE-only code byte-matches Python", () => {
		const v = anchorFeatureVector({ DE: 1 }, 49.4848, 8.4668)
		const expected = [0, 0, 1, 0, 0, 0, 0, 0, 0, 0.549831, 0.047038]
		expected.forEach((e, i) => expect(v[i]!).toBeCloseTo(e, 5))
	})

	it("renormalizes over the in-set mass (ignores out-of-set countries)", () => {
		const v = anchorFeatureVector({ DE: 0.5, ZZ: 0.5 }, 0, 0) // ZZ not in the locale set
		expect(v[LOCALE_ORDER.indexOf("DE")]!).toBeCloseTo(1, 6) // DE renormalized to full mass
	})
})

describe("buildAnchorFeatures — alignment onto SP pieces", () => {
	// "Strasse 12 10115 Berlin" — the postcode "10115" is chars [11, 16).
	const TEXT = "Strasse 12 10115 Berlin"

	const piece = (p: string, start: number, end: number): TokenizedPiece =>
		({ piece: p, id: 0, start, end }) as unknown as TokenizedPiece

	// pieces, with the postcode split across two (101 | 15)
	const PIECES = [
		piece("▁Strasse", 0, 7),
		piece("▁12", 8, 10),
		piece("▁101", 11, 14),
		piece("15", 14, 16),
		piece("▁Berlin", 17, 23),
	]

	const LOOKUP: AnchorLookup = new Map([["10115", { posterior: { DE: 0.5, US: 0.5 }, lat: 52.5323, lon: 13.3846 }]])

	it("lands confidence + features on exactly the postcode pieces", () => {
		const { features, confidence } = buildAnchorFeatures(TEXT, PIECES, LOOKUP)
		expect(confidence).toEqual([0, 0, 1, 1, 0])
		const de = anchorFeatureVector({ DE: 0.5, US: 0.5 }, 52.5323, 13.3846)
		expect(features[2]).toEqual(de)
		expect(features[3]).toEqual(de)
		expect(features[0]).toEqual(new Array(ANCHOR_FEATURE_DIM).fill(0))
		expect(features[4]).toEqual(new Array(ANCHOR_FEATURE_DIM).fill(0))
	})

	it("yields no anchor when the postcode isn't in the lookup", () => {
		const { confidence } = buildAnchorFeatures("Nowhere 99999 City", PIECES, LOOKUP)
		expect(confidence.every((c) => c === 0)).toBe(true)
	})
})

/**
 * The 2026-08-05 train-parity fix (`docs/records/evals/2026-08-05-en-gb-anchor-off.md`). Two obligations:
 *
 * 1. The DEFAULT stays byte-identical to the pre-fix scan — graded against a verbatim copy of it, not against a hash, so
 *    the oracle is readable;
 * 2. `spanMode: "shaped"` keys a span exactly the way `mailwoman_train/tokenizer.py::_paint_anchor_chars` does
 *    (`raw[begin:end].replace(" ", "").upper()`) and paints the span's FULL extent.
 */
describe("buildAnchorFeatures — span modes", () => {
	/**
	 * `buildAnchorFeatures`'s span collection as it stood before the fix, verbatim. The oracle for obligation 1.
	 */
	function legacyBuildAnchorFeatures(
		text: string,
		pieces: ReadonlyArray<TokenizedPiece>,
		lookup: AnchorLookup
	): { features: number[][]; confidence: number[] } {
		const features: number[][] = pieces.map(() => new Array<number>(ANCHOR_FEATURE_DIM).fill(0))
		const confidence: number[] = pieces.map(() => 0)
		const tokenRe = /[A-Za-z0-9]+/g
		let m: RegExpExecArray | null

		while ((m = tokenRe.exec(text)) !== null) {
			const entry = lookup.get(m[0].toUpperCase())

			if (!entry) continue
			const spanBegin = m.index
			const spanEnd = m.index + m[0].length
			const vec = anchorFeatureVector(entry.posterior, entry.lat, entry.lon)

			for (let i = 0; i < pieces.length; i++) {
				const p = pieces[i]!

				for (let c = p.start; c < p.end; c++) {
					if (c < text.length && !/\s/.test(text[c]!)) {
						if (c >= spanBegin && c < spanEnd) {
							features[i] = vec
							confidence[i] = 1
						}

						break
					}
				}
			}
		}

		return { features, confidence }
	}

	/**
	 * Split `text` into non-whitespace runs, each halved, so every anchor span is covered by more than one piece — the
	 * geometry that makes a wrong paint extent visible.
	 */
	function piecesFor(text: string): TokenizedPiece[] {
		const out: TokenizedPiece[] = []

		for (const m of text.matchAll(/\S+/g)) {
			const start = m.index
			const end = start + m[0].length
			const mid = start + Math.max(1, Math.floor(m[0].length / 2))

			out.push({ piece: text.slice(start, mid), id: 0, start, end: mid } as unknown as TokenizedPiece)

			if (mid < end) {
				out.push({ piece: text.slice(mid, end), id: 0, start: mid, end } as unknown as TokenizedPiece)
			}
		}

		return out
	}

	/**
	 * A v2-shaped lookup: the five-digit pilot keys PLUS the letter-bearing ones only a widened build produces.
	 */
	const V2: AnchorLookup = new Map<string, AnchorEntry>([
		["10115", { posterior: { DE: 0.5, US: 0.5 }, lat: 52.5323, lon: 13.3846 }],
		["SW1A2AA", { posterior: { GB: 1 }, lat: 51.50354, lon: -0.1277 }],
		["SW1A", { posterior: { GB: 1 }, lat: 51.50452, lon: -0.13216 }],
		["1012LG", { posterior: { NL: 1 }, lat: 52.37689, lon: 4.89772 }],
	])

	const CORPUS = [
		"Strasse 12 10115 Berlin",
		"Buckingham Palace, London SW1A 2AA",
		"10 Downing Street, London, SW1A 2AA, United Kingdom",
		"Prins Hendrikkade 1, 1012 LG Amsterdam",
		"Prins Hendrikkade 1, 1012LG Amsterdam",
		"Nowhere 99999 City",
		"SW1A on its own",
		"221B Baker Street, London NW1 6XE",
	]

	it("(a) the default is byte-identical to the pre-fix scan on every register", () => {
		for (const text of CORPUS) {
			for (const register of [text, text.toLowerCase(), text.toUpperCase()]) {
				const pieces = piecesFor(register)

				expect(buildAnchorFeatures(register, pieces, V2)).toEqual(legacyBuildAnchorFeatures(register, pieces, V2))

				// and passing the mode explicitly is the same thing
				expect(buildAnchorFeatures(register, pieces, V2, { spanMode: "alnum-run" })).toEqual(
					legacyBuildAnchorFeatures(register, pieces, V2)
				)
			}
		}
	})

	it("(a2) the default CANNOT key a space-containing postcode — the defect, pinned", () => {
		const text = "Buckingham Palace, London SW1A 2AA"
		const pieces = piecesFor(text)
		const unitOnly: AnchorLookup = new Map([["SW1A2AA", { posterior: { GB: 1 }, lat: 51.50354, lon: -0.1277 }]])

		expect(buildAnchorFeatures(text, pieces, unitOnly).confidence.every((c) => c === 0)).toBe(true)

		expect(buildAnchorFeatures(text, pieces, unitOnly, { spanMode: "shaped" }).confidence.some((c) => c === 1)).toBe(
			true
		)
	})

	it("(b) shaped paints `SW1A 2AA` as ONE full-span key matching the train painter", () => {
		const text = "Buckingham Palace, London SW1A 2AA"
		const spanStart = text.indexOf("SW1A 2AA")
		const spanEnd = spanStart + "SW1A 2AA".length
		const pieces = piecesFor(text)
		const { features, confidence } = buildAnchorFeatures(text, pieces, V2, { spanMode: "shaped" })
		const gb = anchorFeatureVector({ GB: 1 }, 51.50354, -0.1277)

		// The unit key won, not the outward key — the outward centroid differs, so this distinguishes them.
		pieces.forEach((p, i) => {
			const inside = p.start >= spanStart && p.end <= spanEnd

			expect(confidence[i]).toBe(inside ? 1 : 0)
			expect(features[i]).toEqual(inside ? gb : new Array(ANCHOR_FEATURE_DIM).fill(0))
		})

		// Both halves of the unit are painted — the outward-only paint the default produces is 2 pieces, not 4.
		expect(confidence.filter((c) => c === 1)).toHaveLength(4)
	})

	it("(b2) shaped keys an NL postcode the same whether it is written glued or spaced", () => {
		const nl = anchorFeatureVector({ NL: 1 }, 52.37689, 4.89772)

		for (const text of ["Prins Hendrikkade 1, 1012 LG Amsterdam", "Prins Hendrikkade 1, 1012LG Amsterdam"]) {
			const pieces = piecesFor(text)
			const { features, confidence } = buildAnchorFeatures(text, pieces, V2, { spanMode: "shaped" })

			expect(confidence.some((c) => c === 1)).toBe(true)
			expect(features[confidence.indexOf(1)]).toEqual(nl)
		}
	})

	it("(c) an unknown GB unit falls back to its outward district, painting the WHOLE unit span", () => {
		// SW1A 1AA is not in V2; its outward SW1A is. NI codes behave the same way — Code-Point Open has none.
		const text = "London SW1A 1AA"
		const spanStart = text.indexOf("SW1A 1AA")
		const pieces = piecesFor(text)
		const { features, confidence } = buildAnchorFeatures(text, pieces, V2, { spanMode: "shaped" })
		const outward = anchorFeatureVector({ GB: 1 }, 51.50452, -0.13216)

		pieces.forEach((p, i) => {
			const inside = p.start >= spanStart

			expect(confidence[i]).toBe(inside ? 1 : 0)

			if (inside) {
				expect(features[i]).toEqual(outward)
			}
		})
	})

	it("(d) a shaped span that misses the lookup paints nothing — exactly like the train painter", () => {
		const text = "221B Baker Street, London NW1 6XE"
		const pieces = piecesFor(text)

		expect(buildAnchorFeatures(text, pieces, V2, { spanMode: "shaped" }).confidence.every((c) => c === 0)).toBe(true)
	})
})

/**
 * #1512 — the shaped keyer and the lowercase register.
 *
 * `POSTCODE_PATTERNS`' alphanumeric shapes require `[A-Z]`, so `collectMatches` finds nothing in raw lowercase and the
 * shaped keyer fired 0/120 on the gb-golden board when case normalization was off. The default parse path never saw it
 * because `normalizeInputCase` restores GB postcode casing first (every GB letter run is ≤2 characters, which
 * `restoreLowerInput` uppercases) — but lowercase is the user register, and a `normalizeCase: false` parse lost the
 * entire GB/NL anchor channel in silence.
 */
describe("buildAnchorFeatures — shaped mode case-folds before shape detection (#1512)", () => {
	const V2: AnchorLookup = new Map<string, AnchorEntry>([
		["SW1A2AA", { posterior: { GB: 1 }, lat: 51.50354, lon: -0.1277 }],
		["1012LG", { posterior: { NL: 1 }, lat: 52.37689, lon: 4.89772 }],
	])

	/**
	 * One piece per whitespace-delimited word, split in half — enough structure for the char→piece projection.
	 */
	function piecesFor(text: string): TokenizedPiece[] {
		const out: TokenizedPiece[] = []

		for (const m of text.matchAll(/\S+/g)) {
			const start = m.index!
			const end = start + m[0].length
			const mid = start + Math.max(1, Math.floor(m[0].length / 2))

			out.push({ piece: text.slice(start, mid), id: 0, start, end: mid } as unknown as TokenizedPiece)

			if (mid < end) {
				out.push({ piece: text.slice(mid, end), id: 0, start: mid, end } as unknown as TokenizedPiece)
			}
		}

		return out
	}

	it("paints the SAME pieces in every register, with no case normalization upstream", () => {
		const asWritten = "Buckingham Palace, London SW1A 2AA"

		const reference = buildAnchorFeatures(asWritten, piecesFor(asWritten), V2, { spanMode: "shaped" })
		expect(reference.confidence.filter((c) => c === 1)).toHaveLength(4)

		for (const text of [asWritten.toLowerCase(), asWritten.toUpperCase()]) {
			const { features, confidence } = buildAnchorFeatures(text, piecesFor(text), V2, { spanMode: "shaped" })

			// Byte-identical to the as-written leg: same pieces painted, same vector.
			expect(confidence).toEqual(reference.confidence)
			expect(features).toEqual(reference.features)
		}
	})

	it("the fold is LENGTH-PRESERVING, so a `ß` upstream cannot shift the painted span", () => {
		// `"ß".toUpperCase()` is "SS" — a naive uppercase here would slide every later offset by one and
		// paint the wrong pieces. ASCII-only folding cannot.
		const text = "straße 1, amsterdam 1012 lg"
		const pieces = piecesFor(text)
		const { confidence } = buildAnchorFeatures(text, pieces, V2, { spanMode: "shaped" })
		const painted = pieces.filter((_, i) => confidence[i] === 1)

		expect(painted.length).toBeGreaterThan(0)

		for (const piece of painted) {
			expect(text.slice(piece.start, piece.end)).toMatch(/^[\d a-z]+$/)
		}

		// The pieces are word-split, so the span's interior space belongs to no piece.
		expect(painted.map((p) => text.slice(p.start, p.end)).join("")).toBe("1012lg")
	})

	it("the DEFAULT alnum-run mode is untouched — the fold lives only in the shaped branch", () => {
		const text = "buckingham palace, london sw1a 2aa"
		const pieces = piecesFor(text)

		expect(buildAnchorFeatures(text, pieces, V2).confidence.every((c) => c === 0)).toBe(true)
	})
})

/**
 * A2 of ROAD_TO_V9 §1 — the SHIP OBLIGATION check. A lookup carrying keys only the shaped keyer can reach, next to a
 * card that does not declare `span_mode: "shaped"`, is a channel that loads clean and feeds zeros on every row it
 * exists for.
 */
describe("shapedKeyerObligationViolation", () => {
	const withUnits: AnchorLookup = new Map<string, AnchorEntry>([
		["10115", { posterior: { DE: 1 }, lat: 52.5323, lon: 13.3846 }],
		["SW1A2AA", { posterior: { GB: 1 }, lat: 51.50354, lon: -0.1277 }],
	])

	const withoutUnits: AnchorLookup = new Map<string, AnchorEntry>([
		["10115", { posterior: { DE: 1 }, lat: 52.5323, lon: 13.3846 }],
		["SW1A", { posterior: { GB: 1 }, lat: 51.50452, lon: -0.13216 }],
		["1012LG", { posterior: { NL: 1 }, lat: 52.37689, lon: 4.89772 }],
	])

	it("counts GB unit keys, and nothing else", () => {
		expect(countShapedOnlyKeys(withUnits)).toBe(1)
		// Outward districts, NL PC6 and every numeric system are reachable by the alnum-run scan.
		expect(countShapedOnlyKeys(withoutUnits)).toBe(0)
	})

	it("flags an undeclared card against a unit-key lookup, naming the remedy", () => {
		const violation = shapedKeyerObligationViolation(withUnits, undefined, "postcode-gb.bin")

		expect(violation).toContain("span_mode")
		expect(violation).toContain("shaped")
		expect(violation).toContain("postcode-gb.bin")
	})

	it("flags an explicit `alnum-run` declaration too — omission and denial are the same defect", () => {
		expect(shapedKeyerObligationViolation(withUnits, "alnum-run", "postcode-gb.bin")).not.toBeNull()
	})

	it("passes a coherent pairing, and any pairing without unit keys", () => {
		expect(shapedKeyerObligationViolation(withUnits, "shaped", "postcode-gb.bin")).toBeNull()
		expect(shapedKeyerObligationViolation(withoutUnits, undefined, "postcode-gb.bin")).toBeNull()
		expect(shapedKeyerObligationViolation(undefined, undefined, undefined)).toBeNull()
	})
})
