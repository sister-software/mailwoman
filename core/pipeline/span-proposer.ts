/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Stage 2.7 span proposer — mechanisms M2 + M3 from the punctuation survey
 *   (`docs/articles/reviews/2026-06-11-punctuation-survey.md`), the structural half of the
 *   sub-premise direction note (`docs/articles/plan/2026-06-11-subpremise-proposer-direction.md`).
 *
 *   A pure function over the raw input emitting TYPED span proposals from three cue families:
 *
 *   1. **Paired delimiters (M2)** — balanced `()`, `[]`, `""`, `«»`, `„“` groups propose
 *        `ANNOTATION_SPAN` / `QUOTED_SPAN`. Unbalanced delimiters of a class produce NO proposal
 *        for that class — the proposer never guesses a missing pair (graceful degradation to
 *        today's behavior, per the survey's unbalanced-class read).
 *   2. **Designator + identifier** — the sub-premise grammar (`Apt 4B`, `Suite 500`, `PO Box 19`): a
 *        closed-vocabulary leader from the injected codex-backed lexicon followed by a short
 *        identifier proposes `UNIT_PHRASE` / `LEVEL_PHRASE` / `PO_BOX_PHRASE`.
 *   3. **Dual-path numeric punctuation (M3, the Pelias PR #56 mechanism)** — `2/14`, `14-16`, `123 1/2`
 *        adjacent to a number context emit BOTH readings as alternatives sharing an
 *        `alternativeGroup`: the fused single-value reading (`FUSED_NUMBER`) AND the
 *        designator-split reading (`SPLIT_UNIT` + `SPLIT_HOUSE_NUMBER`), locale-conditioned by
 *        which codex systems the lexicon was built from (the AU/NZ `Flat 2/14` split exists only
 *        when those tables are loaded). The proposer never decides between readings — downstream
 *        consumers weigh them.
 *
 *   The proposals are INFORMATION, not decisions (the #464 lesson): consumers treat them as phrase
 *   priors the classifier conditions on and as structural boundaries the decode-side span bridge
 *   must not merge across. The classifier can always disagree.
 *
 *   Like the phrase grouper's rules, the cues here are structural + provenance-tracked vocabulary
 *   (codex tables injected by the caller) — no place names, no guessed designators. Core stays
 *   codex-free: `@mailwoman/neural` builds the {@link SpanProposerLexicon} from `@mailwoman/codex`
 *   (see `neural/span-proposer-lexicon.ts`).
 */

/** Typed kinds a span proposal may carry. See the module doc for the three cue families. */
export type ProposedSpanKind =
	/** A balanced `()`/`[]` group whose content reads as an aside about the address. */
	| "ANNOTATION_SPAN"
	/** A balanced quote group — the content is likely a NAME (venue/unit); typing is the classifier's
job. */
	| "QUOTED_SPAN"
	/** Delivery-service designator + identifier ("PO Box 19", "GPO Box 2890", "Private Bag 7"). */
	| "PO_BOX_PHRASE"
	/** Secondary-unit designator + identifier ("Apt 4B", "Suite 500"). */
	| "UNIT_PHRASE"
	/** Level-class designator + identifier ("Floor 3", "FL 12"). */
	| "LEVEL_PHRASE"
	/** Dual-path FUSED reading: the punctuated numeric is ONE value ("123 1/2", "69-10", "14/2"). */
	| "FUSED_NUMBER"
	/** Dual-path SPLIT reading, left side: the sub-premise ("Flat 2" of "Flat 2/14", "3" of "3/45"). */
	| "SPLIT_UNIT"
	/** Dual-path SPLIT reading, right side: the house number ("14" of "Flat 2/14"). */
	| "SPLIT_HOUSE_NUMBER"

/** One typed span proposal. Char offsets into the raw input; `end` exclusive. */
export interface ProposedSpan {
	start: number
	end: number
	kind: ProposedSpanKind
	/** 0..1. Confidence is shape-derived; consumers weight or floor it (it is never a verdict). */
	confidence: number
	/**
	 * Alternative readings of ONE surface share a group id (M3 dual-path: the fused and split
	 * readings of `2/14` carry the same group). Absent for single-reading proposals.
	 */
	alternativeGroup?: number
	/** Provenance: which cue family + rule emitted this ("paired:()", "designator:unit",
"slash:au-split"). */
	source: string
}

/**
 * Vocabulary the proposer conditions on — built from `@mailwoman/codex` tables by the caller
 * (`buildCodexSpanLexicon` in `@mailwoman/neural`). All token sets are lowercase. An empty lexicon
 * (the default) limits the proposer to the paired-delimiter cue family.
 */
export interface SpanProposerLexicon {
	/** Codex system codes the lexicon was built from ("us", "au", "nz", …) — drives M3 locale
conditioning. */
	systems: ReadonlySet<string>
	/** Leading secondary-unit designator tokens (USPS Pub-28 C2 variants: "apt", "ste", "unit", …). */
	unitDesignators: ReadonlySet<string>
	/** Level-class designator tokens ("floor", "fl", "bsmt", "ph", …) — typed LEVEL_PHRASE. */
	levelDesignators: ReadonlySet<string>
	/**
	 * Descriptive designators ("building", "rear", "side", …) that, inside a bracketed group, read as
	 * annotation content rather than a unit ("[Building A]" describes; "[Suite 9]" addresses).
	 */
	weakDesignators: ReadonlySet<string>
	/**
	 * Global scan regex for delivery-service designator+identifier phrases, built from the codex
	 * po_box / delivery-service tables. Must carry the `g` flag.
	 */
	deliveryService?: RegExp
}

/** Empty lexicon — paired-delimiter proposals only. */
export const EMPTY_SPAN_PROPOSER_LEXICON: SpanProposerLexicon = {
	systems: new Set(),
	unitDesignators: new Set(),
	levelDesignators: new Set(),
	weakDesignators: new Set(),
}

// ---------------------------------------------------------------------------
// Tokenization (offset-preserving, punctuation-stripped match bodies)
// ---------------------------------------------------------------------------

interface RawToken {
	/** Whitespace-delimited body as written. */
	body: string
	start: number
	end: number
	/** Body with leading/trailing punctuation stripped (for matching); offsets of the stripped core. */
	stripped: string
	strippedStart: number
	strippedEnd: number
}

const EDGE_PUNCT = /[\s,;:.()[\]"'«»„“”]/

function tokenize(text: string): RawToken[] {
	const out: RawToken[] = []
	let i = 0
	while (i < text.length) {
		while (i < text.length && /\s/.test(text[i]!)) i++
		if (i >= text.length) break
		const start = i
		while (i < text.length && !/\s/.test(text[i]!)) i++
		const body = text.slice(start, i)
		let s = 0
		let e = body.length
		while (s < e && EDGE_PUNCT.test(body[s]!)) s++
		while (e > s && EDGE_PUNCT.test(body[e - 1]!)) e--
		out.push({
			body,
			start,
			end: i,
			stripped: body.slice(s, e),
			strippedStart: start + s,
			strippedEnd: start + e,
		})
	}
	return out
}

// ---------------------------------------------------------------------------
// Cue family 1 — paired delimiters (M2)
// ---------------------------------------------------------------------------

/**
 * Find balanced pairs for one open/close class. Returns null when ANY delimiter of the class is
 * unbalanced (stray opener or closer) — the caller emits nothing for the class.
 */
function findBalancedPairs(text: string, open: string, close: string): Array<{ open: number; close: number }> | null {
	const stack: number[] = []
	const out: Array<{ open: number; close: number }> = []
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!
		if (ch === open) stack.push(i)
		else if (ch === close) {
			const o = stack.pop()
			if (o === undefined) return null
			out.push({ open: o, close: i })
		}
	}
	return stack.length > 0 ? null : out
}

/** Same-character quote pairing ("…"): consecutive occurrences pair up; an odd count is unbalanced. */
function findSameCharPairs(text: string, ch: string): Array<{ open: number; close: number }> | null {
	const positions: number[] = []
	for (let i = 0; i < text.length; i++) if (text[i] === ch) positions.push(i)
	if (positions.length % 2 !== 0) return null
	const out: Array<{ open: number; close: number }> = []
	for (let i = 0; i < positions.length; i += 2) out.push({ open: positions[i]!, close: positions[i + 1]! })
	return out
}

/**
 * Shape-derived annotation confidence (M2: "confidence from balance + content shape"):
 *
 * - Content that is EXACTLY a strong designator + identifier ("Suite 9") is probably a real component
 *   written in brackets (gold convention 2) → very low annotation confidence, letting the
 *   designator cue own the span.
 * - Lowercase- or digit-leading content ("rear entrance", "2nd floor", "code 2580") is the
 *   instruction/aside shape → high.
 * - A short capitalized group at the very END of the input ("(Australia)", "[New Zealand]") is the
 *   trailing-component shape (often a country) → low, below typical consumer floors.
 * - Everything else (capitalized mid-string: "[Building A]", "(The White House)") → moderate.
 */
function annotationConfidence(content: string, atEndOfInput: boolean, lexicon: SpanProposerLexicon): number {
	const tokens = content.split(/\s+/).filter(Boolean)
	if (tokens.length === 0) return 0
	if (tokens.length === 2) {
		const lead = tokens[0]!.toLowerCase().replace(/\.$/, "")
		const strong =
			(lexicon.unitDesignators.has(lead) || lexicon.levelDesignators.has(lead)) && !lexicon.weakDesignators.has(lead)
		if (strong && isShortIdentifier(tokens[1]!)) return 0.25
	}
	if (/^[\p{Ll}0-9]/u.test(content)) return 0.9
	if (atEndOfInput && tokens.length <= 3) return 0.45
	return 0.75
}

function proposePairedDelimiters(text: string, lexicon: SpanProposerLexicon): ProposedSpan[] {
	const out: ProposedSpan[] = []
	const lastNonSpace = text.trimEnd().length

	const bracketClasses: Array<[string, string]> = [
		["(", ")"],
		["[", "]"],
	]
	for (const [open, close] of bracketClasses) {
		const pairs = findBalancedPairs(text, open, close)
		if (!pairs) continue // unbalanced — never guess the missing pair
		for (const p of pairs) {
			const content = text.slice(p.open + 1, p.close).trim()
			if (!content) continue
			const atEnd = p.close >= lastNonSpace - 1
			out.push({
				start: p.open,
				end: p.close + 1,
				kind: "ANNOTATION_SPAN",
				confidence: annotationConfidence(content, atEnd, lexicon),
				source: `paired:${open}${close}`,
			})
		}
	}

	const quotePairFinders: Array<() => Array<{ open: number; close: number }> | null> = [
		() => findSameCharPairs(text, '"'),
		() => findBalancedPairs(text, "“", "”"), // “ ”
		() => findBalancedPairs(text, "«", "»"), // « »
		// „…“ (low-9 opener, German/Czech): closes with “ — only scanned when a „ is present, so the
		// “ ” class above (which would see a stray “) is skipped for such inputs.
	]
	const hasLow9 = text.includes("„")
	for (const [idx, find] of quotePairFinders.entries()) {
		if (hasLow9 && idx === 1) continue
		const pairs = find()
		if (!pairs) continue
		for (const p of pairs) {
			const content = text.slice(p.open + 1, p.close).trim()
			if (!content) continue
			out.push({ start: p.open, end: p.close + 1, kind: "QUOTED_SPAN", confidence: 0.8, source: "paired:quote" })
		}
	}
	if (hasLow9) {
		const pairs = findBalancedPairs(text, "„", "“")
		if (pairs) {
			for (const p of pairs) {
				const content = text.slice(p.open + 1, p.close).trim()
				if (!content) continue
				out.push({ start: p.open, end: p.close + 1, kind: "QUOTED_SPAN", confidence: 0.8, source: "paired:quote" })
			}
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// Cue family 2 — designator + identifier (the sub-premise grammar)
// ---------------------------------------------------------------------------

/** Short identifier shapes per the designator grammar: "4B", "500", "#104", "B", "B99". */
function isShortIdentifier(body: string): boolean {
	return /^#?\d{1,6}[A-Za-z]{0,2}$/.test(body) || /^[A-Za-z]$/.test(body) || /^[A-Za-z]\d{1,4}$/.test(body)
}

function proposeDesignatorPhrases(
	text: string,
	tokens: readonly RawToken[],
	lexicon: SpanProposerLexicon
): ProposedSpan[] {
	const out: ProposedSpan[] = []

	for (let i = 0; i < tokens.length - 1; i++) {
		const lead = tokens[i]!.stripped.toLowerCase()
		const isUnit = lexicon.unitDesignators.has(lead)
		const isLevel = lexicon.levelDesignators.has(lead)
		if (!isUnit && !isLevel) continue
		const next = tokens[i + 1]!
		if (next.stripped.includes("/") || next.stripped.includes("-")) continue // cue family 3 owns punctuated ids
		if (!isShortIdentifier(next.stripped)) continue
		const weak = lexicon.weakDesignators.has(lead)
		out.push({
			start: tokens[i]!.strippedStart,
			end: next.strippedEnd,
			kind: isLevel ? "LEVEL_PHRASE" : "UNIT_PHRASE",
			confidence: weak ? 0.5 : 0.85,
			source: `designator:${isLevel ? "level" : "unit"}`,
		})
	}

	if (lexicon.deliveryService) {
		// Fresh lastIndex per call — the lexicon regex is shared.
		const re = new RegExp(lexicon.deliveryService.source, lexicon.deliveryService.flags)
		for (const m of text.matchAll(re)) {
			out.push({
				start: m.index,
				end: m.index + m[0].length,
				kind: "PO_BOX_PHRASE",
				confidence: 0.9,
				source: "designator:delivery-service",
			})
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// Cue family 3 — dual-path numeric punctuation (M3)
// ---------------------------------------------------------------------------

const SLASH_COMPOUND = /^(\d{1,4}[A-Za-z]?)\/(\d{1,5}[A-Za-z]?)$/
const HYPHEN_COMPOUND = /^(\d{1,4})-(\d{1,5})$/
const FRACTION = /^\d\/\d$/

/**
 * Words that lead NUMBERED ROADS ("Hwy 50/89", "Route 1/9", "I-95") — a bounded structural category
 * (road-type leaders), mirroring the phrase grouper's street-type sets. The
 * leading-designator-shape fallback must not read them as sub-premise designators: a slash after a
 * road leader is a route concurrency, not an AU unit/house split.
 */
const ROAD_LEADERS: ReadonlySet<string> = new Set(["hwy", "highway", "route", "rte", "sr", "cr", "interstate", "loop"])

function proposeNumericReadings(
	tokens: readonly RawToken[],
	lexicon: SpanProposerLexicon,
	nextGroup: () => number
): ProposedSpan[] {
	const out: ProposedSpan[] = []
	const hasAuNz = lexicon.systems.has("au") || lexicon.systems.has("nz")

	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i]!
		const prev = i > 0 ? tokens[i - 1] : undefined
		const prevLead = prev?.stripped.toLowerCase() ?? ""
		const prevIsDesignator = lexicon.unitDesignators.has(prevLead) || lexicon.levelDesignators.has(prevLead)

		// USPS half address: "123 1/2" — the fraction belongs to house_number (one fused value).
		if (lexicon.systems.has("us") && FRACTION.test(t.stripped) && prev && /^\d{1,5}$/.test(prev.stripped)) {
			out.push({
				start: prev.strippedStart,
				end: t.strippedEnd,
				kind: "FUSED_NUMBER",
				confidence: 0.85,
				source: "fraction:usps-half-address",
			})
			continue
		}

		const slash = SLASH_COMPOUND.exec(t.stripped)
		if (slash) {
			const leftEnd = t.strippedStart + slash[1]!.length
			const rightStart = leftEnd + 1
			// Reading A context: a unit/level designator leads ("Unit 4/22", "Flat 2/14" via the
			// leading-shape fallback below). Reading B context: the compound itself leads the address
			// ("3/45 Wattle St" — the AU/NZ bare sub-premise shape, only proposed when those codex
			// systems are loaded).
			const leadingShape =
				!prevIsDesignator &&
				prev !== undefined &&
				i === 1 &&
				/^\p{Lu}[\p{L}]{1,7}$/u.test(prev.stripped) &&
				!ROAD_LEADERS.has(prevLead) &&
				hasAuNz
			if (prevIsDesignator || leadingShape) {
				const group = nextGroup()
				const conf = prevIsDesignator ? (hasAuNz ? 0.85 : 0.6) : 0.7
				out.push({
					start: prev!.strippedStart,
					end: leftEnd,
					kind: "SPLIT_UNIT",
					confidence: conf,
					alternativeGroup: group,
					source: prevIsDesignator ? "slash:designator-split" : "slash:leading-designator-shape",
				})
				out.push({
					start: rightStart,
					end: t.strippedEnd,
					kind: "SPLIT_HOUSE_NUMBER",
					confidence: conf,
					alternativeGroup: group,
					source: "slash:designator-split",
				})
				out.push({
					start: t.strippedStart,
					end: t.strippedEnd,
					kind: "FUSED_NUMBER",
					confidence: 0.3,
					alternativeGroup: group,
					source: "slash:fused-alternative",
				})
			} else if (i === 0 && hasAuNz && tokens.length > 1) {
				const group = nextGroup()
				out.push({
					start: t.strippedStart,
					end: leftEnd,
					kind: "SPLIT_UNIT",
					confidence: 0.75,
					alternativeGroup: group,
					source: "slash:bare-leading-split",
				})
				out.push({
					start: rightStart,
					end: t.strippedEnd,
					kind: "SPLIT_HOUSE_NUMBER",
					confidence: 0.75,
					alternativeGroup: group,
					source: "slash:bare-leading-split",
				})
				out.push({
					start: t.strippedStart,
					end: t.strippedEnd,
					kind: "FUSED_NUMBER",
					confidence: 0.45,
					alternativeGroup: group,
					source: "slash:fused-alternative",
				})
			} else if (prev && /^\p{Lu}[\p{L}]{3,}$/u.test(prev.stripped)) {
				// Trailing European form ("Hauptstraße 14/2") — one fused value after the street name.
				// The ≥4-char guard keeps short street-type leaders ("Hwy 50/89") out of this reading.
				out.push({
					start: t.strippedStart,
					end: t.strippedEnd,
					kind: "FUSED_NUMBER",
					confidence: 0.55,
					source: "slash:trailing-fused",
				})
			}
			continue
		}

		const hyphen = HYPHEN_COMPOUND.exec(t.stripped)
		if (hyphen) {
			// ZIP+4 shape is a postcode, not a house number — never propose a reading for it.
			if (hyphen[1]!.length === 5) continue
			const next = i + 1 < tokens.length ? tokens[i + 1] : undefined
			const leftEnd = t.strippedStart + hyphen[1]!.length
			if (prevIsDesignator) {
				const group = nextGroup()
				out.push({
					start: prev!.strippedStart,
					end: leftEnd,
					kind: "SPLIT_UNIT",
					confidence: 0.45,
					alternativeGroup: group,
					source: "hyphen:designator-split",
				})
				out.push({
					start: leftEnd + 1,
					end: t.strippedEnd,
					kind: "SPLIT_HOUSE_NUMBER",
					confidence: 0.45,
					alternativeGroup: group,
					source: "hyphen:designator-split",
				})
				out.push({
					start: t.strippedStart,
					end: t.strippedEnd,
					kind: "FUSED_NUMBER",
					confidence: 0.6,
					alternativeGroup: group,
					source: "hyphen:fused-alternative",
				})
			} else if (next && (/^\p{Lu}/u.test(next.stripped) || /^\d{1,4}(?:st|nd|rd|th)$/i.test(next.stripped))) {
				// House-number position (a street follows — capitalized or ordinal): "69-10 47th Ave",
				// "14-16 Smith St".
				// Fused only — whether it is a Queens label or a range is not the parser's call (OSM
				// models the difference with a separate tag, not syntax).
				out.push({
					start: t.strippedStart,
					end: t.strippedEnd,
					kind: "FUSED_NUMBER",
					confidence: 0.55,
					source: "hyphen:house-number-position",
				})
			}
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Propose typed spans over `text`. Pure and synchronous; safe to run on every parse. Proposals may
 * overlap freely ("possibilities not constraints"); alternatives of one surface share an
 * `alternativeGroup`. Sorted by `start`, then descending confidence.
 *
 * Designator and numeric proposals fully inside a confident (≥ 0.6) `ANNOTATION_SPAN` are
 * suppressed — bracketed asides describe the address ("(Apt 4 around back)"), and the annotation
 * proposal already carries the span. Content inside QUOTED_SPANs is NOT suppressed (quotes wrap
 * names, not asides).
 */
export function proposeSpans(text: string, lexicon: SpanProposerLexicon = EMPTY_SPAN_PROPOSER_LEXICON): ProposedSpan[] {
	if (text.length === 0) return []
	let groupCounter = 0
	const nextGroup = (): number => groupCounter++

	const paired = proposePairedDelimiters(text, lexicon)
	const tokens = tokenize(text)
	const inner = [
		...proposeDesignatorPhrases(text, tokens, lexicon),
		...proposeNumericReadings(tokens, lexicon, nextGroup),
	]

	const confidentAnnotations = paired.filter((p) => p.kind === "ANNOTATION_SPAN" && p.confidence >= 0.6)
	const survivors = inner.filter((p) => !confidentAnnotations.some((a) => p.start >= a.start && p.end <= a.end))

	const out = [...paired, ...survivors]
	out.sort((a, b) => (a.start !== b.start ? a.start - b.start : b.confidence - a.confidence))
	return out
}
