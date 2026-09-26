/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * @file Head-noun derivation for the sub-venue lexicon — proposing the addressed form of a designator
 * from the encyclopaedic label a vocabulary source carries.
 *
 * Everything derived lands `curated: false`, because a derivation is a hypothesis a locale's own data confirms or kills.
 */

import { isPresent } from "@mailwoman/core/objects"

import type { SubVenueSurface } from "#tools/sub/venue/table"

/**
 * Diacritic-flattened ascii fold, for comparing a Slavic or Turkish inflection against its Latin root.
 *
 * Deliberately `\p{Diacritic}` rather than `@mailwoman/normalize/fold`'s
 * `stripCombiningMarks` (`\p{M}`), because the two diverge outside plain diacritics
 * and {@link HEAD_NOUN_PREFIX_FLOOR} was calibrated against this fold.
 */
function asciiFold(text: string): string {
	return text
		.normalize("NFD")
		.replaceAll(/\p{Diacritic}/gu, "")
		.toLowerCase()
}

/**
 * How many leading characters two ascii-folded forms must share for one to count as the other's inflection.
 *
 * Five, or the id's own length when shorter; at six the Spanish `satélite` is lost,
 * and at four Italian `campo` is admitted and means field.
 */
const HEAD_NOUN_PREFIX_FLOOR = 5

/**
 * The shortest substring a non-Latin head-noun candidate may be.
 *
 * Two, because `楼` alone is "building" and would fire on every Chinese building name.
 */
const NON_LATIN_HEAD_MIN_LENGTH = 2

/**
 * How many head-noun candidates one non-Latin record+language group may contribute.
 *
 * Six, capped because the substring lattice of a nine-character label is large
 * and no entry past the sixth attests more than two surfaces.
 */
const NON_LATIN_HEAD_CANDIDATE_CAP = 6

/**
 * The scripts an ascii-folded prefix comparison against a Latin designator id can work on.
 */
const LATIN_PHRASE = /^[\p{Script=Latin}\d\s\p{P}]+$/u

/**
 * The scripts the shared-substring derivation may run on: Han, Hiragana, Katakana, Hangul.
 *
 * Narrower than "not Latin" because a wider run produced unusable Cyrillic, Greek, Arabic,
 * Thai, Burmese and Tamil fragments, and no extract in reach attests those surfaces.
 */
const SHARED_SUBSTRING_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/**
 * Derive the head noun of every multi-part surface, so `terminal aeroportuaria`
 * contributes the form anyone actually writes on an envelope.
 *
 * Latin script uses a cognate test against the designator's own canonical id; Han
 * and Kana use a shared substring, because a token split finds no boundary there.
 * Everything derived lands `curated: false`.
 */
export function deriveHeadNounSurfaces(surfaces: readonly SubVenueSurface[]): SubVenueSurface[] {
	const derived = new Map<string, SubVenueSurface>()
	const seen = new Set(surfaces.map((s) => `${s.phrase}\0${s.recordID}\0${s.lang}`))

	const emit = (phrase: string, from: SubVenueSurface): void => {
		if (phrase === from.phrase) return

		const key = `${phrase}\0${from.recordID}\0${from.lang}`

		if (seen.has(key) || derived.has(key)) return

		derived.set(key, {
			phrase,
			recordID: from.recordID,
			recordKind: from.recordKind,
			lang: from.lang,
			region: "",
			source: "derived:head-noun",
			curated: false,
			observations: 0,
			context: {},
		})
	}

	for (const surface of surfaces) {
		if (!LATIN_PHRASE.test(surface.phrase)) continue

		const parts = surface.phrase.split(/[^\p{L}\p{N}]+/u).filter(isPresent)

		if (parts.length < 2) continue

		const root = asciiFold(surface.recordID)
		const floor = Math.min(HEAD_NOUN_PREFIX_FLOOR, root.length)

		for (const part of parts) {
			const folded = asciiFold(part)

			if (folded.length >= floor && commonPrefixLength(folded, root) >= floor) {
				emit(part, surface)
			}
		}
	}

	const groups = new Map<string, Set<string>>()

	for (const surface of surfaces) {
		if (!SHARED_SUBSTRING_SCRIPT.test(surface.phrase)) continue

		// Group `zh`, `zh-cn` and `zh-hant` together: they are writing systems for one vocabulary,
		// and the simplified/traditional pair is the evidence a shared substring needs.
		const key = `${surface.recordID} ${surface.lang.split(/[-_]/u)[0]!}`
		const pool = groups.get(key) ?? new Set<string>()
		pool.add(surface.phrase)
		groups.set(key, pool)
	}

	const candidatesByGroup = new Map<string, string[]>()

	for (const [key, pool] of groups) {
		if (pool.size < 2) continue
		candidatesByGroup.set(key, sharedSubstringCandidates(pool))
	}

	for (const surface of surfaces) {
		if (!SHARED_SUBSTRING_SCRIPT.test(surface.phrase)) continue

		const key = `${surface.recordID} ${surface.lang.split(/[-_]/u)[0]!}`

		for (const candidate of candidatesByGroup.get(key) ?? []) {
			if (surface.phrase.includes(candidate)) {
				emit(candidate, surface)
			}
		}
	}

	return [...derived.values()]
}

function commonPrefixLength(a: string, b: string): number {
	const limit = Math.min(a.length, b.length)
	let i = 0

	while (i < limit && a[i] === b[i]) {
		i++
	}

	return i
}

/**
 * Substrings occurring in at least two distinct members of `pool`, ranked by that count
 * then length, capped at {@link NON_LATIN_HEAD_CANDIDATE_CAP}.
 *
 * A candidate never spans whitespace and must be a whole token of some member where the pool has
 * whitespace, which keeps Korean `공항 터미널` from contributing a fragment straddling the space.
 * Maximal candidates only: one contained in a longer candidate carried by the same
 * number of surfaces is dropped, since counting can never separate the two.
 */
function sharedSubstringCandidates(pool: ReadonlySet<string>): string[] {
	const phrases = [...pool]
	const spaced = phrases.some((phrase) => /\s/u.test(phrase))
	const tokens = spaced ? new Set(phrases.flatMap((phrase) => phrase.split(/\s+/u).filter(isPresent))) : null
	const counts = new Map<string, number>()

	for (const phrase of phrases) {
		const local = new Set<string>()

		for (let length = NON_LATIN_HEAD_MIN_LENGTH; length <= phrase.length; length++) {
			for (let start = 0; start + length <= phrase.length; start++) {
				const candidate = phrase.slice(start, start + length)

				if (/\s/u.test(candidate)) continue
				local.add(candidate)
			}
		}

		for (const candidate of local) {
			counts.set(candidate, (counts.get(candidate) ?? 0) + 1)
		}
	}

	const kept = [...counts].filter(([candidate, count]) => count >= 2 && (!tokens || tokens.has(candidate)))

	return kept
		.filter(([candidate, count]) =>
			kept.every(([other, otherCount]) => other === candidate || otherCount !== count || !other.includes(candidate))
		)
		.toSorted((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))
		.slice(0, NON_LATIN_HEAD_CANDIDATE_CAP)
		.map(([candidate]) => candidate)
}
