/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Propose spans for balanced punctuation, known designator phrases, and ambiguous numeric forms.
 *   Proposals provide evidence and alternatives; downstream stages decide which reading to use.
 *   Designators come from a caller-supplied codex lexicon, keeping core independent of codex data.
 */

/**
 * Maximum token count for short-input tail handling.
 */
const SHORT_INPUT_MAX_TOKENS = 3

/**
 * Confidence assigned to a short-input tail span.
 */
const SHORT_TAIL_CONFIDENCE = 0.45

/**
 * Digits in the ZIP portion of a ZIP+4.
 */
const ZIP5_LENGTH = 5

/**
 * Minimum annotation confidence for suppressing contained proposals.
 */
const CONFIDENT_ANNOTATION_MIN = 0.6

/**
 * Structural kinds emitted by the span proposer.
 */
export type ProposedSpanKind =
	/** Balanced parenthetical or bracketed aside. */
	| "ANNOTATION_SPAN"
	/** Balanced quoted content; the classifier determines its tag. */
	| "QUOTED_SPAN"
	/** Delivery-service phrase and identifier. */
	| "PO_BOX_PHRASE"
	/** Secondary-unit phrase and identifier. */
	| "UNIT_PHRASE"
	/** Level phrase and identifier. */
	| "LEVEL_PHRASE"
	/** Punctuated number interpreted as one value. */
	| "FUSED_NUMBER"
	/** Left side of a split sub-premise and house number. */
	| "SPLIT_UNIT"
	/** Right side of a split house number. */
	| "SPLIT_HOUSE_NUMBER"

/**
 * Proposed span with character offsets into the input; `end` is exclusive.
 */
export interface ProposedSpan {
	start: number
	end: number
	kind: ProposedSpanKind
	/**
	 * Shape-derived confidence in `[0, 1]`.
	 */
	confidence: number
	/**
	 * Shared ID for alternative readings of the same surface.
	 */
	alternativeGroup?: number
	/**
	 * Cue family and rule that emitted the proposal.
	 */
	source: string
}

/**
 * Lowercase vocabulary supplied by the caller.
 * An empty lexicon enables only delimiter proposals.
 */
export interface SpanProposerLexicon {
	/**
	 * Address-system codes used to condition numeric proposals.
	 */
	systems: ReadonlySet<string>
	/**
	 * Secondary-unit designator tokens.
	 */
	unitDesignators: ReadonlySet<string>
	/**
	 * Level designator tokens.
	 */
	levelDesignators: ReadonlySet<string>
	/**
	 * Designators treated as descriptive annotation text rather than unit labels.
	 */
	weakDesignators: ReadonlySet<string>
	/**
	 * Venue-interior designators, kept separate from postal unit designators
	 * so consumers can weight them differently.
	 */
	venueStructureDesignators: ReadonlySet<string>
	/**
	 * Modifiers that may precede a venue-structure designator.
	 */
	venueStructureModifiers: ReadonlySet<string>
	/**
	 * Venue designators allowed after a modifier.
	 * Excludes forms that commonly occur in street names.
	 */
	modifierEligibleStructureDesignators: ReadonlySet<string>
	/**
	 * Global regex for delivery-service phrases.
	 * Must use the `g` flag.
	 */
	deliveryService?: RegExp
}

/**
 * Empty vocabulary for delimiter-only proposals.
 */
export const EMPTY_SPAN_PROPOSER_LEXICON: SpanProposerLexicon = {
	systems: new Set(),
	unitDesignators: new Set(),
	levelDesignators: new Set(),
	weakDesignators: new Set(),
	venueStructureDesignators: new Set(),
	venueStructureModifiers: new Set(),
	modifierEligibleStructureDesignators: new Set(),
}

//#region Tokenization

interface RawToken {
	/**
	 * Original whitespace-delimited token.
	 */
	body: string
	start: number
	end: number
	/**
	 * Token with edge punctuation removed, plus its offsets.
	 */
	stripped: string
	strippedStart: number
	strippedEnd: number
}

const EDGE_PUNCT = /[\s,;:.()[\]"'«»„“”]/

function tokenize(text: string): RawToken[] {
	const out: RawToken[] = []
	let i = 0

	while (i < text.length) {
		while (i < text.length && /\s/.test(text[i]!)) {
			i++
		}

		if (i >= text.length) break
		const start = i

		while (i < text.length && !/\s/.test(text[i]!)) {
			i++
		}

		const body = text.slice(start, i)
		let s = 0
		let e = body.length

		while (s < e && EDGE_PUNCT.test(body[s]!)) {
			s++
		}

		while (e > s && EDGE_PUNCT.test(body[e - 1]!)) {
			e--
		}

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

//#endregion

//#region Cue family 1 — paired delimiters (M2)

/**
 * Find balanced delimiter pairs, or return `null` if any delimiter is unmatched.
 */
function findBalancedPairs(text: string, open: string, close: string): Array<{ open: number; close: number }> | null {
	const stack: number[] = []
	const out: Array<{ open: number; close: number }> = []

	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!

		if (ch === open) {
			stack.push(i)
		} else if (ch === close) {
			const o = stack.pop()

			if (o === undefined) return null
			out.push({ open: o, close: i })
		}
	}

	return stack.length ? null : out
}

/**
 * Pair same-character quotes in order; odd counts are unbalanced.
 */
function findSameCharPairs(text: string, ch: string): Array<{ open: number; close: number }> | null {
	const positions: number[] = []

	for (let i = 0; i < text.length; i++)
		if (text[i] === ch) {
			positions.push(i)
		}

	if (positions.length % 2 !== 0) return null
	const out: Array<{ open: number; close: number }> = []

	for (let i = 0; i < positions.length; i += 2) {
		out.push({ open: positions[i]!, close: positions[i + 1]! })
	}

	return out
}

/**
 * Estimate annotation confidence from the content's shape and position.
 */
function annotationConfidence(content: string, atEndOfInput: boolean, lexicon: SpanProposerLexicon): number {
	const tokens = content.split(/\s+/).filter((value) => value.length)

	if (!tokens.length) return 0

	if (tokens.length === 2) {
		const lead = tokens[0]!.toLowerCase().replace(/\.$/, "")

		const strong =
			(lexicon.unitDesignators.has(lead) || lexicon.levelDesignators.has(lead)) && !lexicon.weakDesignators.has(lead)

		if (strong && isShortIdentifier(tokens[1]!)) return 0.25
	}

	if (/^[\p{Ll}0-9]/u.test(content)) return 0.9

	if (atEndOfInput && tokens.length <= SHORT_INPUT_MAX_TOKENS) return SHORT_TAIL_CONFIDENCE

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

		if (!pairs) continue

		// Ignore unmatched delimiter classes.
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
		() => findBalancedPairs(text, "“", "”"),
		() => findBalancedPairs(text, "«", "»"),
		// German/Czech low-9 quotes use “ as their closer.
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

//#endregion

//#region Cue family 2 — designator + identifier

/**
 * Short identifier shapes per the designator grammar: "4B", "500", "#104", "B", "B99".
 */
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

		if (next.stripped.includes("/") || next.stripped.includes("-")) continue

		// Numeric cue logic handles punctuated identifiers.
		if (!isShortIdentifier(next.stripped)) continue
		const weak = lexicon.weakDesignators.has(lead)
		// Preserve venue-structure provenance for downstream weighting.
		const venueStructure = !isLevel && lexicon.venueStructureDesignators.has(lead)

		out.push({
			start: tokens[i]!.strippedStart,
			end: next.strippedEnd,
			kind: isLevel ? "LEVEL_PHRASE" : "UNIT_PHRASE",
			confidence: weak ? 0.5 : 0.85,
			source: venueStructure ? "designator:venue-structure" : `designator:${isLevel ? "level" : "unit"}`,
		})
	}

	// Also recognize modifier-first venue phrases, at lower confidence because street names can share this shape.
	for (let i = 1; i < tokens.length; i++) {
		const designator = tokens[i]!.stripped.toLowerCase()

		if (!lexicon.modifierEligibleStructureDesignators.has(designator)) continue

		const modifier = tokens[i - 1]!.stripped.toLowerCase()

		if (!lexicon.venueStructureModifiers.has(modifier)) continue

		const beforeModifier = tokens[i - 2]

		// A leading house number indicates a street address, not a venue substructure.
		if (beforeModifier && /^\d{1,6}[A-Za-z]?$/.test(beforeModifier.stripped)) continue

		// Avoid extracting a phrase embedded in a longer proper name.
		if (beforeModifier && /^\p{Lu}/u.test(beforeModifier.stripped)) continue

		out.push({
			start: tokens[i - 1]!.strippedStart,
			end: tokens[i]!.strippedEnd,
			kind: "UNIT_PHRASE",
			confidence: 0.6,
			source: "designator:venue-structure-modifier",
		})
	}

	if (lexicon.deliveryService) {
		// Clone the shared global regex to reset its match state.
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

//#endregion

//#region Cue family 3 — dual-path numeric punctuation (M3)

const SLASH_COMPOUND = /^(\d{1,4}[A-Za-z]?)\/(\d{1,5}[A-Za-z]?)$/
const HYPHEN_COMPOUND = /^(\d{1,4})-(\d{1,5})$/
const FRACTION = /^\d\/\d$/

/**
 * Confidence for numeric readings that have a plausible alternative.
 */
const AMBIGUOUS_PROPOSAL_CONFIDENCE = 0.55

/**
 * Road-type leaders that prevent route numbers from being parsed as unit splits.
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

		// US house-number fractions are one fused value.
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

			// Accept a split when a unit designator or AU/NZ leading-number pattern provides context.
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
				// Treat trailing European compounds as fused numbers; require a long preceding street name.
				out.push({
					start: t.strippedStart,
					end: t.strippedEnd,
					kind: "FUSED_NUMBER",
					confidence: AMBIGUOUS_PROPOSAL_CONFIDENCE,
					source: "slash:trailing-fused",
				})
			}

			continue
		}

		const hyphen = HYPHEN_COMPOUND.exec(t.stripped)

		if (hyphen) {
			// ZIP+4 is a postcode, not a house-number compound.
			if (hyphen[1]!.length === ZIP5_LENGTH) continue
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
				// A following street name or ordinal indicates a fused house number.
				out.push({
					start: t.strippedStart,
					end: t.strippedEnd,
					kind: "FUSED_NUMBER",
					confidence: AMBIGUOUS_PROPOSAL_CONFIDENCE,
					source: "hyphen:house-number-position",
				})
			}
		}
	}

	return out
}

//#endregion

//#region Entry point

/**
 * Propose typed spans synchronously.
 *
 * Results may overlap and are sorted by start, then confidence.
 */
export function proposeSpans(text: string, lexicon: SpanProposerLexicon = EMPTY_SPAN_PROPOSER_LEXICON): ProposedSpan[] {
	if (!text.length) return []
	let groupCounter = 0
	const nextGroup = (): number => groupCounter++

	const paired = proposePairedDelimiters(text, lexicon)
	const tokens = tokenize(text)

	const inner = [
		...proposeDesignatorPhrases(text, tokens, lexicon),
		...proposeNumericReadings(tokens, lexicon, nextGroup),
	]

	const confidentAnnotations = paired.filter(
		(p) => p.kind === "ANNOTATION_SPAN" && p.confidence >= CONFIDENT_ANNOTATION_MIN
	)

	const survivors = inner.filter((p) => !confidentAnnotations.some((a) => p.start >= a.start && p.end <= a.end))

	const out = [...paired, ...survivors]
	out.sort((a, b) => (a.start !== b.start ? a.start - b.start : b.confidence - a.confidence))

	return out
}

//#endregion
