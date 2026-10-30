/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Kana readings for Japanese municipalities, read from the WOF admin database's `names` table.
 *
 *   The `kana_municipality` register renders a municipality as its hiragana stem plus the kanji generic (あつぎ市
 *   for 厚木市), the shape of the few municipalities whose official names are hiragana, such as かすみがうら市. For a
 *   JP place, `names` holds the official kanji as a `jpn` name and the hiragana readings as `jpn` variants, either a
 *   bare stem (あつぎ) or a full form with the generic (あつぎし).
 *
 *   Ported from the Python builders' `countries/jp/kana.py`.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { codePointLength } from "@mailwoman/core/strings/code-points"
import { openBuiltClient } from "@mailwoman/sqlite/sealed"
import { sql } from "kysely"
import type { PathBuilderLike } from "path-ts"

const MUNICIPALITY_GENERICS = ["市", "町", "村", "区"] as const

const GENERIC_READINGS: Readonly<Record<(typeof MUNICIPALITY_GENERICS)[number], readonly string[]>> = {
	市: ["し"],
	町: ["まち", "ちょう"],
	村: ["むら", "そん"],
	区: ["く"],
}

const isHiraganaCode = (code: number): boolean => code >= 0x30_41 && code < 0x30_97

/**
 * Whether `text` is non-empty and every character is hiragana or the prolonged-sound mark ー.
 */
export function isHiragana(text: string): boolean {
	return (
		text.length > 0 && [...text].every((character) => isHiraganaCode(character.codePointAt(0)!) || character === "ー")
	)
}

/**
 * Whether `text` is non-empty and holds neither kana nor ASCII.
 */
export function isKanjiName(text: string): boolean {
	return (
		text.length > 0 &&
		![...text].some((character) => {
			const code = character.codePointAt(0)!

			return isHiraganaCode(code) || (code >= 0x30_a1 && code <= 0x30_fa) || code < 0x80
		})
	)
}

const genericOf = (official: string) => MUNICIPALITY_GENERICS.find((generic) => official.endsWith(generic))

/**
 * The kana stem of a kanji name: its shortest all-hiragana variant, less the
 * generic's reading when it ends with one (とっとりし for 鳥取市 becomes とっとり), or `null`
 * when the name already holds hiragana or has no reading.
 */
export function pickKanaStem(official: string, variants: Iterable<string>): string | null {
	if ([...official].some((character) => isHiraganaCode(character.codePointAt(0)!))) return null

	const kana = [...new Set([...variants].filter(isHiragana))].toSorted(
		(a, b) => codePointLength(a) - codePointLength(b)
	)

	if (!kana.length) return null

	const stem = kana[0]!
	const generic = genericOf(official)

	if (generic) {
		for (const reading of GENERIC_READINGS[generic]) {
			if (stem.endsWith(reading) && codePointLength(stem) > codePointLength(reading)) {
				return stem.slice(0, -reading.length)
			}
		}
	}

	return stem
}

interface NameRow {
	id: number
	name: string
}

/**
 * Each kanji municipality name mapped to its kana surface, from the JP localities,
 * localadmins, counties and boroughs in a WOF admin database.
 *
 * WOF may store a city's preferred name without its generic (鳥取) and list the generic form
 * as a variant, so every kanji name of a place that ends with a generic becomes a key.
 * The reading covers the shortest generic name (北区), and a longer one keeps its
 * extra prefix in kanji, so 大阪市北区 becomes 大阪市きた区.
 *
 * @throws When the database is missing, naming it.
 */
export async function municipalityKanaFromAdminDB(path: PathBuilderLike): Promise<Map<string, string>> {
	if (!(await pathExists(path))) throw new Error(`No WOF admin database at ${path.toString()}`)

	using db = await openBuiltClient(path)

	const { rows } = await sql<NameRow>`
		SELECT s.id AS id, n.name AS name
		FROM spr s JOIN names n ON n.id = s.id
		WHERE s.country = 'JP' AND s.placetype IN ('locality', 'localadmin', 'county', 'borough') AND n.language = 'jpn'
	`.execute(db)

	const kanjiByPlace = new Map<number, string[]>()
	const kanaByPlace = new Map<number, string[]>()

	for (const { id, name } of rows) {
		const target = isHiragana(name) ? kanaByPlace : isKanjiName(name) ? kanjiByPlace : null

		if (!target) continue

		const list = target.get(id)

		if (list) {
			list.push(name)
		} else {
			target.set(id, [name])
		}
	}

	const out = new Map<string, string>()

	for (const [id, kanjiNames] of kanjiByPlace) {
		const kana = kanaByPlace.get(id)

		if (!kana) continue

		const genericNames = kanjiNames.filter((name) => genericOf(name))

		if (!genericNames.length) continue

		// The first shortest, as `min(key=len)` picks it.
		let base = genericNames[0]!

		for (const name of genericNames) {
			if (codePointLength(name) < codePointLength(base)) {
				base = name
			}
		}

		const stem = pickKanaStem(base, kana)

		if (stem === null) continue

		for (const kanji of genericNames) {
			if (kanji.endsWith(base) && !out.has(kanji)) {
				out.set(kanji, kanji.slice(0, kanji.length - base.length) + stem + (genericOf(base) ?? ""))
			}
		}
	}

	return out
}

/**
 * The kana surface of a corpus municipality, retrying without a county prefix (中新川郡上市町 as 上市町), or `null`.
 */
export function municipalityKanaLookup(
	kanaByMunicipality: ReadonlyMap<string, string>,
	municipality: string
): string | null {
	const direct = kanaByMunicipality.get(municipality)

	if (direct !== undefined) return direct

	const at = municipality.indexOf("郡")

	if (at === -1) return null

	const tail = municipality.slice(at + 1)

	return tail ? (kanaByMunicipality.get(tail) ?? null) : null
}
