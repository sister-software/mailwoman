/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Soft-prior emission biases derived from `QueryShape`.
 *
 *   When the QueryShape sub-system has identified a known-format span (US ZIP, UK postcode, PO box,
 *   etc.), this module produces an additive bias matrix that nudges the encoder's per-token
 *   emissions toward the matching BIO label. The biases compose with the structural BIO mask in the
 *   Viterbi decoder — confident encoder predictions still win, but uncertain ones get pulled toward
 *   the format-implied label.
 *
 *   Bitter-lesson-safe boundary: we don't override the encoder, just bias it. The encoder remains the
 *   authority on context-dependent calls (the "Buffalo Wild Wings, Buffalo, NY" disambiguation);
 *   the QueryShape prior helps on the easy cases (a 5-digit token is _probably_ a postcode).
 *
 *   RETIRED 2026-07-17 — the LOCALITY bias (regionAbbreviations → boost B/I-locality on preceding
 *   tokens). The M1 stack ablation (docs/articles/evals/2026-07-17-m1-stack-ablation.md) measured the
 *   full prior at −2.3 micro / −7.8 locality on golden-us, and the three-arm sub-ablation attributed
 *   100% of the damage to the locality half: stripping it recovered locality exact-match 0.7822 →
 *   0.8546 (= the no-prior arm), while the known-format half was exactly neutral. The failure mode was
 *   venue/org absorption on registry-style rows ("DANVILLE HEALTH CENTER, 26 Cedar Lane, Danville VT"
 *   → locality "danville health center"): the backward walk from a detected region abbreviation
 *   crossed comma gaps and dragged venue text into locality. The WOF bare-name over-emission it was
 *   built to counter no longer reproduces — the model outgrew it (same lifecycle as the #956-era
 *   near-postcode suppression, also measured negative in M1). The known-format boosts below remain.
 *
 *   Uses structural typing for the QueryShape input so this module has zero dependencies on
 *   `@mailwoman/query-shape` — consumers compute the shape with that package, pass it in here.
 */

/**
 * Minimal subset of `QueryShape` this module consumes. Compatible with `@mailwoman/query-shape`'s exported `QueryShape`
 * type by shape — no import required.
 */
export interface QueryShapeLike {
	knownFormats: ReadonlyArray<KnownFormatHitLike>
	regionAbbreviations?: ReadonlyArray<RegionAbbreviationHitLike>
}

export interface RegionAbbreviationHitLike {
	start: number
	span: string
}

export interface KnownFormatHitLike {
	format: string
	span: { start: number; end: number }
	/** 0..1; ambiguous patterns (e.g. 5-digit US/FR/DE overlap) score lower. */
	confidence: number
}

/** Minimal subset of `TokenizedPiece` this module consumes. */
export interface TokenLike {
	start: number
	end: number
}

/**
 * Mapping from `KnownFormat` strings to the BIO label that should be boosted. Multiple formats may map to the same
 * label (all postcode flavors → `B-postcode`).
 */
const FORMAT_TO_LABEL: ReadonlyMap<string, string> = new Map([
	["us_zip", "B-postcode"],
	["us_zip4", "B-postcode"],
	["fr_postcode", "B-postcode"],
	["de_postcode", "B-postcode"],
	["uk_postcode", "B-postcode"],
	["ca_postcode", "B-postcode"],
	["jp_postcode", "B-postcode"],
	["nl_postcode", "B-postcode"],
	["po_box", "B-po_box"],
])

export interface BuildPriorsOpts {
	/**
	 * Maximum bias magnitude (in log-odds units). Default 1.0 — adds up to ~e^1 ≈ 2.7× odds to the favored label.
	 * Confidence-scaled, so a 0.6-confidence format hit gets +0.6 max bias.
	 */
	biasScale?: number
	/**
	 * Raw input text — enables the SCOPED locality bias (bare admin doubletons only; see `applyScopedLocalityBias`).
	 * Without it the digit guard cannot run, so the locality bias never fires.
	 */
	inputText?: string
}

/**
 * Build a `[seqLen][numLabels]` matrix of additive log-bias to be added to encoder emissions before Viterbi decoding.
 *
 * For each (token, format-hit) pair where the token's character span overlaps the hit's span, the matrix entry for the
 * format's mapped label receives `hit.confidence × biasScale`. Tokens that don't overlap any hit, or for which no label
 * mapping exists, get 0.
 *
 * Returns the all-zeros matrix if `shape.knownFormats` is empty — composes harmlessly.
 */
export function buildEmissionPriors(
	shape: QueryShapeLike,
	tokens: ReadonlyArray<TokenLike>,
	labels: ReadonlyArray<string>,
	opts: BuildPriorsOpts = {}
): number[][] {
	const T = tokens.length
	const L = labels.length
	const biasScale = opts.biasScale ?? 1.0
	const matrix: number[][] = []

	for (let t = 0; t < T; t++) {
		matrix.push(new Array<number>(L).fill(0))
	}

	// Index label → column for fast lookup.
	const labelToCol = new Map<string, number>()

	for (let k = 0; k < labels.length; k++) {
		labelToCol.set(labels[k]!, k)
	}

	if (shape.knownFormats.length === 0 && !shape.regionAbbreviations?.length) {
		return matrix
	}

	for (const hit of shape.knownFormats) {
		const targetLabel = FORMAT_TO_LABEL.get(hit.format)

		if (!targetLabel) continue
		const col = labelToCol.get(targetLabel)

		if (col === undefined) continue
		const bias = hit.confidence * biasScale

		for (let t = 0; t < T; t++) {
			const tok = tokens[t]!

			if (overlaps(tok, hit.span)) {
				matrix[t]![col] = Math.max(matrix[t]![col]!, bias)
			}
		}
	}

	applyScopedLocalityBias(matrix, shape, tokens, labelToCol, opts.inputText)

	return matrix
}

/**
 * The SCOPED locality bias — the 2026-07-17 rebuild of the retired backward-walk version (see the header). It fires
 * ONLY on the bare admin doubleton the original was built for ("New York, NY", "Washington, DC" — a region-ambiguous
 * city name before its state abbreviation, the gauntlet `us-new-york-nyc` regression case) and structurally cannot
 * reach the venue/street inputs the old walk broke on. Guards, in order:
 *
 * 1. NO DIGITS anywhere in the input — any house number / postcode means this is not an admin-only query, and the M1
 *    failure class ("… 26 Cedar Lane, Danville VT") always carries digits.
 * 2. The abbreviation is the FINAL token — the doubleton shape, not a mid-sentence state mention.
 * 3. At most 4 tokens precede it ("Salt Lake City, UT" fits; "Community Health Service Inc - Grafton ND" does not).
 *
 * The retired version also carried a "name IS the region" guard ("Washington, WA" stays region). It was DEAD in
 * production — the classifier passes tokenizer PIECES whose spans include the trailing comma, so the string comparison
 * never matched (and "New York, NY", the gauntlet regression case, needs the bias despite naming its own state).
 * Deliberately dropped; the bias is soft, so a confident region emission on a true state restatement still wins.
 */
function applyScopedLocalityBias(
	matrix: number[][],
	shape: QueryShapeLike,
	tokens: ReadonlyArray<TokenLike>,
	labelToCol: Map<string, number>,
	inputText?: string
): void {
	const abbrevs = shape.regionAbbreviations

	if (!abbrevs?.length || !inputText || /\d/.test(inputText)) return

	const bLocCol = labelToCol.get("B-locality")
	const iLocCol = labelToCol.get("I-locality")

	if (bLocCol === undefined) return

	for (const abbrev of abbrevs) {
		// Guard 2: nothing may follow the abbreviation token.
		if (tokens.some((tok) => tok.start > abbrev.start + abbrev.span.length)) continue

		const candidates = tokens.map((tok, t) => ({ tok, t })).filter(({ tok }) => tok.end <= abbrev.start)

		// Guard 3: the doubleton shape — a short leading name, not a sentence.
		if (candidates.length === 0 || candidates.length > 4) continue

		for (let i = 0; i < candidates.length; i++) {
			const col = i === 0 ? bLocCol : iLocCol

			if (col === undefined) continue
			matrix[candidates[i]!.t]![col] = Math.max(matrix[candidates[i]!.t]![col]!, SCOPED_LOCALITY_BIAS)
		}
	}
}

/** Log-odds bias for the scoped doubleton case — the retired version's strength, now reachable only by the doubleton. */
const SCOPED_LOCALITY_BIAS = 2.0

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
	return a.start < b.end && b.start < a.end
}

/** Element-wise add two matrices of equal shape. Returns a new matrix. */
export function addEmissionMatrix(emissions: number[][], priors: number[][]): number[][] {
	if (priors.length === 0) return emissions.map((row) => row.slice())
	const out: number[][] = []

	for (let t = 0; t < emissions.length; t++) {
		const e = emissions[t]!
		const p = priors[t] ?? new Array<number>(e.length).fill(0)
		const row = new Array<number>(e.length)

		for (let k = 0; k < e.length; k++) {
			row[k] = e[k]! + (p[k] ?? 0)
		}
		out.push(row)
	}

	return out
}
