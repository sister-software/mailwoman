/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The CN organizational-unit reader (#2034). China's rural and state-farm addresses carry a hierarchy below the
 *   named settlement that the universal tags have no rung for: `孟定农场 → 三分场 → 八队` (Mengding Farm → No. 3 sub-farm →
 *   No. 8 production team), the XPCC ladder `一四三团十二连` (143rd regiment → 12th company), the villager group `民权三组`.
 *   The schema holds the whole ordinal chain as ONE `locality_unit` span; this module is the deterministic reading of
 *   that span — which rung each generic names — and the labeler the corpus recipe uses to write the span in the first
 *   place. Both halves share the one generic table, so a generic added for labeling is read back the same way.
 *
 *   The vocabulary is geography wearing organizational words. `团` is a regiment and `连` a company, but a 1983
 *   place-name reform treated a `团` as approximately a town and a `连` as approximately a village, and current XPCC farm
 *   pages still describe farms by numbered `连队`. A literal translation reads as mail to an army formation; the reader
 *   names the rung, never translates it.
 */

/**
 * The rungs a generic can name, coarsest first. `headquarters` is not a rung: `场部` names the central settlement of the
 * unit it follows, a point inside the unit rather than a further level, and stays inside the span.
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
 * Generic suffix → rung. Longer generics are listed first so `生产队` is read before `队` and `大队` before `队`. Every entry
 * here is a suffix the census of the coarse-placer CN rows found at least once as the tail of an ordinal unit; a
 * generic that only ever follows a NAME (`林场`, `牧场`, `垦殖场`) belongs to the named head and is deliberately absent.
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
 * The ordinals an organizational unit is numbered with: Chinese numerals (`三`, `二十九`, `一零三`, `十五`) or Arabic digits.
 * `〇`/`零` occur inside XPCC regiment numbers (`一零三团`).
 */
const ORDINAL = "[〇零一二三四五六七八九十百千\\d]+"

const GENERIC_ALTERNATION = CN_UNIT_GENERICS.map(([generic]) => generic).join("|")

/**
 * One ordinal unit: `三分场`, `二十九队`, `一零三团`, `十五分场`. A headquarters marker carries no ordinal.
 */
const UNIT = `(?:${ORDINAL}(?:${GENERIC_ALTERNATION})|场部)`

/**
 * The whole chain the span holds — one or more units, nothing else.
 */
const CHAIN = new RegExp(`^(?:${UNIT})+$`, "u")

/**
 * A chain at the END of a longer CJK run, so the labeler can find where the named head stops. Anchored on the right and
 * greedy on the left, so `八场八队` reads as two units with an empty head rather than as the head `八场`.
 */
const TRAILING_CHAIN = new RegExp(`((?:${UNIT})+)$`, "u")

const UNIT_PARTS = new RegExp(`(${ORDINAL})(${GENERIC_ALTERNATION})|(场部)`, "gu")

/**
 * One rung of a read chain.
 */
export interface CNUnit {
	/**
	 * The unit's surface, verbatim: `三分场`.
	 */
	surface: string
	rung: CNUnitRung
	/**
	 * The ordinal as written (`三`, `二十九`, `一零三`), or `null` for a headquarters marker.
	 */
	ordinal: string | null
	/**
	 * The generic that named the rung: `分场`.
	 */
	generic: string
}

/**
 * Whether a string is a well-formed `locality_unit` span — nothing but ordinal units and an optional headquarters.
 */
export function isCNUnitChain(span: string): boolean {
	return CHAIN.test(span)
}

/**
 * Read a `locality_unit` span into its rungs, outermost first. Throws on a span that is not a chain: a consumer that
 * reached this with anything else has a labeling defect, and reading part of it would report a hierarchy nobody wrote.
 */
export function readCNUnits(span: string): CNUnit[] {
	if (!isCNUnitChain(span)) {
		throw new Error(`readCNUnits: ${JSON.stringify(span)} is not an organizational-unit chain`)
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
 * Split a CJK run into the named head and the trailing organizational chain, for the corpus labeler.
 *
 * `孟定农场三分场二队` → head `孟定农场`, chain `三分场二队`; `八场八队` → head empty, chain `八场八队`. A generic with no ordinal in front of it
 * is part of a NAME, not a rung: `红卫大队` is a brigade-era toponym that survives as a village name, so it carries no
 * chain and the whole run stays the head. `null` when the run carries no chain at all.
 */
export function splitCNUnitChain(run: string): { head: string; chain: string } | null {
	const match = TRAILING_CHAIN.exec(run)

	if (!match) return null

	const chain = match[1]!

	return { head: run.slice(0, run.length - chain.length), chain }
}
