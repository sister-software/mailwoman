import { stringifyJSON } from "#json"

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The CN organizational-unit reader: the schema holds China's below-settlement ordinal chain as one
 *   `locality_unit` span, and this module both reads which rung each generic names and labels that span for the corpus
 *   recipe, from the one generic table.
 *
 *   The vocabulary is geography wearing organizational words, so a literal translation would read as mail to an army
 *   formation and the reader names the rung rather than translating it.
 */

/**
 * The rungs a generic can name, coarsest first, where `headquarters` is not a further level
 * but the central settlement of the unit it follows, and stays inside the span.
 */
export const CN_UNIT_RUNGS = [
	"farm",
	"regiment",
	"subfarm",
	"brigade",
	"company",
	"team",
	"group",
	"headquarters",
] as const

export type CNUnitRung = (typeof CN_UNIT_RUNGS)[number]

/**
 * Longer generics are listed first so `生产队` is read before `队` and `大队` before `队`, every
 * entry was found at least once as the tail of an ordinal unit in the coarse-placer CN census,
 * and a generic that only ever follows a name (`林场`, `牧场`, `垦殖场`) is deliberately absent.
 */
export const CN_UNIT_GENERICS: ReadonlyArray<readonly [generic: string, rung: CNUnitRung]> = [
	["生产大队", "brigade"],
	["生产队", "team"],
	["分场", "subfarm"],
	["大队", "brigade"],
	["团场", "regiment"],
	["场部", "headquarters"],
	["团", "regiment"],
	["连", "company"],
	["队", "team"],
	["组", "group"],
	["场", "farm"],
]

/**
 * The ordinals an organizational unit is numbered with: Chinese numerals (`三`, `二十九`, `一零三`, `十五`)
 * or Arabic digits, where `〇`/`零` occur inside xpcc regiment numbers (`一零三团`).
 */
const ORDINAL = "[〇零一二三四五六七八九十百千\\d]+"

const GENERIC_ALTERNATION = CN_UNIT_GENERICS.map(([generic]) => generic).join("|")

const UNIT = `(?:${ORDINAL}(?:${GENERIC_ALTERNATION})|场部)`

const CHAIN = new RegExp(`^(?:${UNIT})+$`, "u")

/**
 * Anchored on the right and greedy on the left, so `八场八队` reads as two units with
 * an empty head rather than as the head `八场`.
 */
const TRAILING_CHAIN = new RegExp(`((?:${UNIT})+)$`, "u")

const UNIT_PARTS = new RegExp(`(${ORDINAL})(${GENERIC_ALTERNATION})|(场部)`, "gu")

/**
 * One rung of a read chain.
 */
export interface CNUnit {
	surface: string
	rung: CNUnitRung
	/**
	 * The ordinal as written, or `null` for a headquarters marker.
	 */
	ordinal: string | null
	generic: string
}

/**
 * Whether a string is a well-formed `locality_unit` chain.
 */
export function isCNUnitChain(span: string): boolean {
	return CHAIN.test(span)
}

/**
 * Read a `locality_unit` span into its rungs, outermost first.
 *
 * @throws On a span that is not a chain, because reading part of it would report a hierarchy nobody wrote.
 */
export function readCNUnits(span: string): CNUnit[] {
	if (!isCNUnitChain(span)) {
		throw new Error(`readCNUnits: ${stringifyJSON(span)} is not an organizational-unit chain`)
	}

	const units: CNUnit[] = []

	for (const match of span.matchAll(UNIT_PARTS)) {
		if (match[3]) {
			units.push({ surface: match[3], rung: "headquarters", ordinal: null, generic: match[3] })

			continue
		}

		const generic = match[2]!
		const rung = CN_UNIT_GENERICS.find(([candidate]) => candidate === generic)![1]

		units.push({ surface: match[0], rung, ordinal: match[1]!, generic })
	}

	return units
}

/**
 * Split a CJK run into the named head and the trailing organizational chain,
 * for the corpus labeler: a generic with no ordinal in front of it is part of a name
 * rather than a rung, so `红卫大队` stays in the head.
 */
export function splitCNUnitChain(run: string): { head: string; chain: string } | null {
	const match = TRAILING_CHAIN.exec(run)

	if (!match) return null

	const chain = match[1]!

	return { head: run.slice(0, run.length - chain.length), chain }
}
