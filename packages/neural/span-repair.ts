/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared implementation for the decoder-side regex repair passes (`postcode-repair.ts`,
 *   `unit-repair.ts`).
 *
 *   Both passes have the same skeleton: run a priority-ordered list of shape regexes over the raw
 *   input text, resolve the resulting overlapping candidates down to a non-overlapping set, map each
 *   surviving char range onto the token indices it covers, then relabel that run. `unit-repair.ts`
 *   was written as a deliberate mirror of `postcode-repair.ts` (its docstring says so), so the
 *   skeleton was duplicated line-for-line — including two byte-identical sort comparators. This
 *   module is that skeleton, extracted once so the two passes cannot drift on it.
 *
 *   What stays in each pass is what actually differs: the patterns, the ADD/SNAP eligibility rules,
 *   the `ADD_OVER_TAGS` set, and the smear-cleanup policy (postcode-repair hands a trailing smear
 *   BACK to a following locality; unit-repair always clips to `O`). Those are the levers — do not
 *   pull them up here.
 */

import type { DecoderToken } from "@mailwoman/core/decoder"

/**
 * A regex hit over the raw input text: a half-open char range plus the index of the pattern that produced it. Lower
 * `priority` means a more specific pattern, which wins a same-length tie.
 */
export interface SpanMatch {
	start: number
	end: number
	/**
	 * Pattern priority (lower = more specific, wins overlap resolution).
	 */
	priority: number
}

/**
 * Greedy longest-match-wins selection: accept candidates by (length desc, then priority asc), and reject anything
 * overlapping an already-accepted match.
 *
 * Longest-first is what lets a US ZIP+4 ("94610-2737") claim its whole span before the shorter NL-shaped false positive
 * in its tail ("2737 CA") can. The input array is not mutated (`toSorted`), and the sort is stable, so candidates of
 * equal length AND equal priority keep the order the caller pushed them in (pattern order, then match order within a
 * pattern).
 */
export function selectNonOverlappingMatches<T extends SpanMatch>(candidates: readonly T[]): T[] {
	const ordered = candidates.toSorted((a, b) => b.end - b.start - (a.end - a.start) || a.priority - b.priority)
	const accepted: T[] = []

	for (const c of ordered) {
		if (accepted.some((a) => spansOverlap(c, a))) continue

		accepted.push(c)
	}

	return accepted
}

/**
 * Whether two half-open char ranges intersect. Touching ranges do not overlap.
 */
export function spansOverlap(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
	return a.start < b.end && b.start < a.end
}

/**
 * A shape pattern a repair pass scans the raw text with. Passes carry extra fields on their entries (postcode-repair's
 * `kind`); {@link collectMatchesFor} hands the matched pattern back so those fields survive onto the match.
 */
export interface SpanPattern {
	re: RegExp
}

/**
 * Run a priority-ordered pattern list over the raw text and resolve the hits to a non-overlapping set ({@link
 * selectNonOverlappingMatches}). Pattern order IS the priority (lower = more specific).
 */
export function collectMatchesFor<P extends SpanPattern>(
	patterns: readonly P[],
	text: string
): Array<SpanMatch & { pattern: P }> {
	const candidates: Array<SpanMatch & { pattern: P }> = []

	patterns.forEach((pattern, priority) => {
		pattern.re.lastIndex = 0

		for (let m = pattern.re.exec(text); m; m = pattern.re.exec(text)) {
			candidates.push({ start: m.index, end: m.index + m[0].length, priority, pattern })
		}
	})

	return selectNonOverlappingMatches(candidates)
}

/**
 * Whether `label` is the B- or I- form of `tag`.
 */
export function isTagLabel(label: string, tag: string): boolean {
	return label === `B-${tag}` || label === `I-${tag}`
}

/**
 * The mutate-and-count label writer both passes thread through their repair loop: a no-op write (same label) does not
 * count as a change.
 */
export function createLabelSetter(tokens: DecoderToken[]): {
	setLabel: (i: number, label: DecoderToken["label"]) => void
	changeCount: () => number
} {
	let changed = 0

	return {
		setLabel: (i, label) => {
			if (tokens[i]!.label !== label) {
				tokens[i]!.label = label

				changed++
			}
		},
		changeCount: () => changed,
	}
}

/**
 * The ADD-path safety check: a span may be created only over `O` tokens and the tags in `addOverTags` — never over a
 * confident structural label. Each pass declares its own `addOverTags` set; that set is a lever and stays with the
 * pass.
 */
export function isAddSafe(
	tokens: readonly DecoderToken[],
	overlap: readonly number[],
	addOverTags: ReadonlySet<string>
): boolean {
	return overlap.every((i) => {
		const tag = tagOf(tokens[i]!.label)

		return tag === null || addOverTags.has(tag)
	})
}

/**
 * Indices of the tokens whose char span intersects the half-open range `[start, end)`, in token order. Returns an empty
 * array when the range falls between tokens.
 */
export function tokenIndicesOverlapping(tokens: readonly DecoderToken[], start: number, end: number): number[] {
	const overlap: number[] = []

	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i]!

		if (t.start < end && start < t.end) {
			overlap.push(i)
		}
	}

	return overlap
}

/**
 * Extract the bare tag from a BIO label ("B-locality" → "locality", "O" → null).
 */
export function tagOf(label: string): string | null {
	return label === "O" ? null : label.slice(2)
}

/**
 * The result shape every repair pass returns: a NEW token array (inputs are never mutated) plus the number of labels
 * the pass changed.
 */
export interface RepairResult {
	tokens: DecoderToken[]
	/**
	 * Number of token labels changed — for telemetry / logging.
	 */
	changed: number
}
