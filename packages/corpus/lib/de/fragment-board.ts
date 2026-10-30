/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The DE fragment board: 400 Overture-DE rows per failure class, mirroring the FR board's taxonomy, with
 *   the reserved street surfaces beside it.
 *
 *   The classes are the preposition-led street (`Am`, `An der`, `Zur` …), the date street (`Straße des 17. Juni`),
 *   the street whose folded word n-gram is a locality-lexicon entry, the street with a house number after it and
 *   with an alphanumeric one, the bare street, and the bare municipality, which expects no street.
 *
 *   The training feed's only DE street data is the `rendered-de` source (OpenAddresses Berlin and Saxony), so the
 *   board excludes Berlin (`BE`) and Saxony (`SN`). Street vocabulary such as `Hauptstraße` still repeats across
 *   states, so the board measures class behavior over shared vocabulary with held-out compositions.
 *
 *   One seeded `PyRandom` fills every class's reservoir in row order, and each class keeps one row per surface.
 *   The patterns use Unicode word and digit classes, because Python's `re` reads `\w`, `\d` and `\b` that way.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { orderedJSON } from "@mailwoman/core/json"
import { codePointLength } from "@mailwoman/core/strings/code-points"
import { compareByScalarValue } from "@mailwoman/core/strings/compare"
import { pythonSplitWhitespace } from "@mailwoman/core/strings/python-text"
import { basename, dirname } from "path-ts"

import { openParquetRowStream } from "#parquet/streams"
import { PyRandom } from "#training/pyrandom"

/**
 * The states whose OpenAddresses files the training feed reads, left out of the board.
 */
export const DE_TRAINING_STATES: ReadonlySet<string> = new Set(["BE", "SN"])

/**
 * The board's classes, in the order the board file lists them.
 */
export const DE_BOARD_CLASSES = [
	"admin-street-homonym",
	"alnum-housenumber",
	"bare-locality",
	"bare-street",
	"date-name",
	"street-housenumber",
	"street-particle",
] as const

export type DEBoardClass = (typeof DE_BOARD_CLASSES)[number]

/**
 * A word character as Python's `re` reads `\w`: a letter, a number or an underscore.
 */
const WORD = String.raw`[\p{L}\p{N}_]`

const PARTICLE = new RegExp(
	String.raw`^(am|an der|an den|zur|zum|auf der|auf dem|im|in der|in den|unter den|unter der|hinter der|hinter dem|vor der|vor dem|bei der|beim|an|zu)\s`,
	"iu"
)

const MONTHS = "januar|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember"

const DATEISH = new RegExp(
	String.raw`(?<!${WORD})\p{Nd}{1,2}\.?\s*(${MONTHS})(?!${WORD})|(?<!${WORD})stra(ß|ss)e des \p{Nd}`,
	"iu"
)

const ALNUM_NUMBER = /\p{Nd}[a-zA-Z]|[a-zA-Z]\p{Nd}|\p{Nd}[-/]\p{Nd}/u

const EDGE_NON_WORD = new RegExp(String.raw`^(?:(?!${WORD}).)+|(?:(?!${WORD}).)+$`, "gu")

/**
 * The painter's word fold (`painterFold` in the gazetteer's evidence lexicons), which this
 * package cannot import because the gazetteer depends on it: whitespace tokens with their
 * leading and trailing non-word characters removed, lower-cased, empty tokens dropped.
 */
export function foldBoardWords(surface: string): string[] {
	return pythonSplitWhitespace(surface)
		.map((word) => word.replace(EDGE_NON_WORD, ""))
		.filter((word) => word)
		.map((word) => word.toLowerCase())
}

/**
 * A surface's board key: NFC, folded, the words joined by one space.
 */
export function normalizeBoardSurface(text: string): string {
	return foldBoardWords(text.normalize("NFC")).join(" ")
}

const LONGEST_NGRAM = 4

/**
 * The class a street takes, checked in order: date, particle, lexicon homonym, then bare street.
 */
export function streetClass(street: string, lexicon: ReadonlySet<string>): DEBoardClass {
	if (DATEISH.test(street)) return "date-name"

	if (PARTICLE.test(street)) return "street-particle"

	const words = foldBoardWords(street)

	for (let n = 1; n <= Math.min(words.length, LONGEST_NGRAM); n++) {
		for (let start = 0; start + n <= words.length; start++) {
			if (lexicon.has(words.slice(start, start + n).join(" "))) return "admin-street-homonym"
		}
	}

	return "bare-street"
}

/**
 * The class a street with a house number takes.
 */
export const housenumberClass = (number: string): DEBoardClass =>
	ALNUM_NUMBER.test(number) ? "alnum-housenumber" : "street-housenumber"

/**
 * One board row before its class, source and id.
 */
export type DEBoardRow =
	| { input: string; expect_no_street: true; surface: string }
	| { input: string; expect: { street: string[] }; surface: string }

interface OvertureDERow {
	street: string | null
	number: string | null
	address_levels: Array<{ value: string | null }> | null
}

/**
 * Options for {@linkcode buildDEFragmentBoard}.
 */
export interface DEFragmentBoardOptions {
	parquet: string
	lexicon: string
	out: string
	perClass: number
	seed: number
}

const MIN_STREET_CHARS = 3

/**
 * Writes the board JSONL at `out` and the sorted reserved surfaces beside it as
 * `<stem>.surfaces.txt`, and returns each class's row count.
 *
 * A class short of `perClass` is written with the rows it has.
 *
 * @throws When the parquet file or the lexicon is missing, naming it.
 */
export async function buildDEFragmentBoard(options: DEFragmentBoardOptions): Promise<Map<DEBoardClass, number>> {
	if (!(await pathExists(options.parquet))) throw new Error(`No Overture-DE parquet at ${options.parquet}`)

	const lexicon = new Set(
		Object.keys((await readLocalJSONFile<{ entries: Record<string, unknown> }>(options.lexicon)).entries)
	)

	const rng = new PyRandom(options.seed)
	const reservoirs = new Map(DE_BOARD_CLASSES.map((klass) => [klass, [] as DEBoardRow[]]))
	const seen = new Map(DE_BOARD_CLASSES.map((klass) => [klass, 0]))
	const keys = new Map(DE_BOARD_CLASSES.map((klass) => [klass, new Set<string>()]))

	const offer = (klass: DEBoardClass, row: DEBoardRow, key: string) => {
		const taken = keys.get(klass)!

		if (taken.has(key)) return

		taken.add(key)

		const count = seen.get(klass)! + 1
		const reservoir = reservoirs.get(klass)!

		seen.set(klass, count)

		if (reservoir.length < options.perClass) {
			reservoir.push(row)

			return
		}

		const slot = rng.randrange(count)

		if (slot < options.perClass) {
			reservoir[slot] = row
		}
	}

	for await (const row of openParquetRowStream<OvertureDERow>(options.parquet, {
		columns: ["street", "number", "address_levels"],
	})) {
		const levels = row.address_levels

		if (!levels || levels.length < 2 || !levels[0]!.value || DE_TRAINING_STATES.has(levels[0]!.value)) continue

		const municipality = levels[1]!.value

		if (municipality) {
			const surface = normalizeBoardSurface(municipality)

			offer("bare-locality", { input: municipality, expect_no_street: true, surface }, surface)
		}

		const { street, number } = row

		if (!street || codePointLength(street) < MIN_STREET_CHARS) continue

		const surface = normalizeBoardSurface(street)

		if (!surface) continue

		offer(streetClass(street, lexicon), { input: street, expect: { street: [street] }, surface }, surface)

		if (number) {
			offer(
				housenumberClass(number),
				{ input: `${street} ${number}`, expect: { street: [street] }, surface },
				`${surface}|${number}`
			)
		}
	}

	const lines: string[] = []
	const surfaces = new Set<string>()

	for (const klass of DE_BOARD_CLASSES) {
		const rows = reservoirs.get(klass)!

		if (rows.length < options.perClass) {
			console.log(`WARN ${klass}: only ${rows.length} rows (wanted ${options.perClass})`)
		}

		for (const [index, row] of rows.entries()) {
			lines.push(
				orderedJSON({ klass, ...row, source: "overture:de", id: `ovt-de-${klass}-${String(index).padStart(5, "0")}` })
			)

			surfaces.add(row.surface)
		}
	}

	const stem = basename(options.out).replace(/\.[^.]*$/u, "")

	await writeLocalTextFile(lines, options.out)

	await writeLocalTextFile(
		`${[...surfaces].toSorted(compareByScalarValue).join("\n")}\n`,
		`${dirname(options.out)}/${stem}.surfaces.txt`
	)

	console.log(
		`${options.out}: ${lines.length} rows across ${DE_BOARD_CLASSES.length} classes; ${surfaces.size} reserved surfaces`
	)

	return new Map(DE_BOARD_CLASSES.map((klass) => [klass, reservoirs.get(klass)!.length]))
}
