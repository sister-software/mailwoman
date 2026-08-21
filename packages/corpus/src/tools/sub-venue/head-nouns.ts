/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   @file Head-noun derivation for the sub-venue lexicon — proposing the ADDRESSED form of a designator
 *   from the encyclopaedic label a vocabulary source carries.
 *
 *   Wikidata's label for a concept is the encyclopaedic name (`terminal aeroportuaria`, `letištní
 *   terminál`, `havalimanı terminali`), while the addressed form is the bare head (`Terminal`,
 *   `Terminál`, `Terminali`). Nothing can promote the encyclopaedic form, so the head has to be
 *   extracted before the curation pass has anything to decide about — that gap is why the first wave of
 *   this table shipped 1,014 uncurated surfaces.
 *
 *   Everything derived lands `curated: false`. A derivation is a HYPOTHESIS about what the addressed
 *   form is; a locale's own data is what confirms or kills it.
 */

import { isPresent } from "@mailwoman/core/objects"

import type { SubVenueSurface } from "./table.ts"

/**
 * Diacritic-flattened ASCII fold, for comparing a Slavic or Turkish inflection against its Latin root.
 */
function asciiFold(text: string): string {
	return text
		.normalize("NFD")
		.replaceAll(/\p{Diacritic}/gu, "")
		.toLowerCase()
}

/**
 * How many leading characters two ASCII-folded forms must share for one to count as the other's inflection.
 *
 * Five, or the id's own length when that is shorter (`hall`, `gate`, `wing`, `pier` are four). Measured against the
 * committed Wikidata pull: at five, `terminal`/`terminál`/`terminale`/`terminali`/`terminála`/`terminalo` are all
 * accepted for `terminal` while `campo` and `campws` are both rejected for `campus` (they share four). At six the
 * Spanish `satélite` is lost; at four, Italian `campo` is admitted and it means FIELD.
 */
const HEAD_NOUN_PREFIX_FLOOR = 5

/**
 * The shortest substring a non-Latin head-noun candidate may be. Two: `航站` and `터미널` are both real, `楼` alone is
 * "building" and would fire on every Chinese building name.
 */
const NON_LATIN_HEAD_MIN_LENGTH = 2

/**
 * How many head-noun candidates one non-Latin record+language group may contribute. Six — enough to carry `ターミナル`,
 * `ターミナルビル` and `旅客ターミナル` together, capped because the substring lattice of a nine-character label is large and, ranked
 * by attesting-surface count, nothing past the sixth has more than the minimum two.
 */
const NON_LATIN_HEAD_CANDIDATE_CAP = 6

/**
 * Latin-script test — the scripts an ASCII-folded prefix comparison against a Latin designator id can work on.
 */
const LATIN_PHRASE = /^[\p{Script=Latin}\d\s\p{P}]+$/u

/**
 * The scripts the shared-substring derivation is allowed to run on: Han, Hiragana, Katakana, Hangul.
 *
 * NARROWER than "not Latin", and the narrowing was earned. Run over every non-Latin phrase in the table, the derivation
 * produced 90 fragments of Cyrillic, Greek, Arabic, Thai, Burmese and Tamil words — `сгра`, `град`, `κτίρ`,
 * `ิ่งก่อสร้า` — because those languages have exactly one surface per concept and the only substrings shared inside a
 * group are pieces of one word. Every one of them was unusable, and none could ever be counted: `poi.db` is four
 * countries and this wave's extracts are GB, DE, FR, ES and JP, so nothing in reach attests a Thai or Burmese surface.
 * Deriving a candidate no available source can confirm is not a hypothesis, it is table weight.
 */
const SHARED_SUBSTRING_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/**
 * Derive the HEAD NOUN of every multi-part surface, so `terminal aeroportuaria` contributes the form anyone actually
 * writes on an envelope.
 *
 * The problem this solves is the whole reason wave 1 shipped 1,014 uncurated surfaces: Wikidata's label for a concept
 * is the ENCYCLOPAEDIC name (`terminal aeroportuaria`, `letištní terminál`, `havalimanı terminali`), while the
 * addressed form is the bare head (`Terminal`, `Terminál`, `Terminali`). Nothing can promote the encyclopaedic form, so
 * the head has to be extracted before the curation pass has anything to decide about.
 *
 * Two derivations, because the table holds two kinds of writing:
 *
 * - **Latin script — the COGNATE test.** A token is the head when its ASCII fold shares {@link HEAD_NOUN_PREFIX_FLOOR}
 *   leading characters with the designator's own canonical id. Nothing subtler survived contact with the data: an
 *   earlier version matched a token against any SINGLE-TOKEN surface of the record, and because Dutch `universiteit` is
 *   a one-token surface of `campus`, it derived `universitario`, `universitaire`, `üniversite` and twenty more as head
 *   nouns of `campus`. Those are the MODIFIER half of the label, and admitting them would have taught the harvest to
 *   read "Ciudad Universitaria" as sub-venue structure.
 * - **Non-Latin script — the SHARED-SUBSTRING test.** The cognate test cannot reach a script the id is not written in,
 *   and for Han and Kana a token split finds nothing at all. So every substring of length ≥
 *   {@link NON_LATIN_HEAD_MIN_LENGTH} occurring in at least two DISTINCT surfaces of the same record and primary
 *   language becomes a candidate, ranked by how many surfaces carry it. Japanese yields `ターミナル` (in all five `ja`
 *   terminal labels) ahead of `ターミナルビル` (three); Chinese yields `航站`, `航站楼`, `航站樓`. Where the script DOES space its
 *   words (Korean, Greek, Cyrillic) a candidate must be a whole token, so `공항 터미널` ∩ `공항터미널` gives `터미널` and never a
 *   fragment.
 *
 * The non-Latin branch deliberately emits SEVERAL candidates instead of picking one. Choosing between `航站` and `航站楼`
 * from Wikidata alone is guesswork; the Japan extract answers it by counting, and the promotion ledger records which
 * count won. Everything derived lands `curated: false` — the derivation is a hypothesis about what the addressed form
 * is, and a locale's own data is what confirms or kills it.
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

	// ── Spacing scripts: prefix-match a token against a single-token surface of the same record ──────
	// Latin script: a token that is a cognate of the designator's own canonical id.
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

	// Non-Latin script: substrings shared by two or more surfaces of the same record + language.
	const groups = new Map<string, Set<string>>()

	for (const surface of surfaces) {
		if (!SHARED_SUBSTRING_SCRIPT.test(surface.phrase)) continue

		// Group `zh`, `zh-cn`, `zh-hant` together: they are writing systems for one vocabulary, and the
		// simplified/traditional pair is exactly the evidence a shared substring needs.
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

/**
 * Length of the shared leading run of two strings.
 */
function commonPrefixLength(a: string, b: string): number {
	const limit = Math.min(a.length, b.length)
	let i = 0

	while (i < limit && a[i] === b[i]) {
		i++
	}

	return i
}

/**
 * Substrings occurring in at least two DISTINCT members of `pool`, ranked by that count and then by length, capped at
 * {@link NON_LATIN_HEAD_CANDIDATE_CAP}.
 *
 * A candidate never spans whitespace, and in a pool whose members contain whitespace a candidate must be a whole token
 * of some member. That is what keeps Korean `공항 터미널` from contributing a fragment straddling the space.
 *
 * MAXIMAL candidates only: one contained in a longer candidate carried by the SAME number of surfaces is dropped, since
 * counting can never separate the two. Every one of `ターミナル`'s five ja labels also contains `ターミ`, `ターミナ` and `ミナル`, so
 * without this the group contributes four indistinguishable candidates and the Japan harvest returns four identical
 * counts. `航站` survives next to `航站楼` because six surfaces carry it against that one's two.
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
