/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Assigns a cause to a row a model parses incorrectly by comparing expected and predicted spans.
 *
 *   Causes are tested in order and the first that holds wins:
 *
 *   1. `word-split`: a predicted span starts or ends between two letters or two digits of one word, as when shipped
 *      reads `კოჯორი` as `კ`, `ო`, `ჯო`, `რი`. The tokenizer or the vocabulary cannot keep the word whole.
 *   2. `designator`: the error involves a unit. An expected unit is missed or split, or the parse holds a unit the
 *      address does not have (`STE 302` read as street `… 302` with unit `ste`).
 *   3. `number-boundary`: the house number or postcode is misread, as a number read as a postcode
 *      (`1130 Babək prospekti`), or a number joined to the street (`Allee 6`).
 *   4. `venue`: the venue is missed, split, or read as another field (`Fito Club` read as locality).
 *   5. `street-extent`: the street span takes in or loses a neighboring field's words (`langmyrveien nordre aker`).
 *   6. `place-level`: only locality, dependent locality, region and subregion values are wrong. A place is read at the
 *      wrong level or two levels are joined (`löcken waldfeucht`).
 *   7. `other`.
 */

/**
 * One parsed span as the battery stores it: tag, start and end offsets in the
 * raw text, and the node's value.
 */
export type BatterySpan = [tag: string, start: number, end: number, value: string]

/**
 * The causes a wrong row is filed under, in the order {@linkcode classifyBatteryError} tests them.
 *
 * The order and the rules are the battery's of 2026-10-28, checked by hand on 20 rows.
 */
export const BATTERY_CAUSES = [
	"word-split",
	"designator",
	"number-boundary",
	"venue",
	"street-extent",
	"place-level",
	"other",
] as const

export type BatteryCause = (typeof BATTERY_CAUSES)[number]

const STREET_PARTS = new Set(["street_prefix", "street", "street_suffix"])
const PLACE_TAGS = new Set(["locality", "dependent_locality", "region", "subregion"])

/**
 * The parse as a field map with street prefix, name and suffix joined, lowercased.
 *
 * Commas are dropped and whitespace collapsed, so a venue written `Clas Ohlson Stavanger, Madla`
 * and parsed as two venue spans compares equal to the one expected span.
 */
export function batteryFieldMap(spans: ReadonlyArray<readonly [tag: string, value: string]>): Map<string, string> {
	const fields = new Map<string, string[]>()

	for (const [tag, value] of spans) {
		const key = STREET_PARTS.has(tag) ? "street" : tag

		fields.set(key, [...(fields.get(key) ?? []), value.toLowerCase()])
	}

	return new Map(
		[...fields].map(([tag, parts]) => [tag, parts.join(" ").replaceAll(",", " ").replaceAll(/\s+/gu, " ").trim()])
	)
}

/**
 * A field map as one comparable string, `tag=value` pairs sorted and joined by ` | `.
 */
export function batteryFieldKey(fields: ReadonlyMap<string, string>): string {
	return [...fields]
		.map(([tag, value]) => `${tag}=${value}`)
		.toSorted()
		.join(" | ")
}

/**
 * Reads a {@linkcode batteryFieldKey} string back into a field map.
 */
export function parseBatteryFieldKey(key: string): Map<string, string> {
	const fields = new Map<string, string>()

	for (const part of key.split(" | ")) {
		const at = part.indexOf("=")

		if (at > 0) {
			fields.set(part.slice(0, at), part.slice(at + 1))
		}
	}

	return fields
}

const WORD = /[\p{L}\p{N}]/u

/**
 * Whether a span boundary at `offset` falls between two word characters of `raw`.
 */
function insideWord(raw: string, offset: number): boolean {
	return offset > 0 && offset < raw.length && WORD.test(raw[offset - 1]!) && WORD.test(raw[offset]!)
}

/**
 * The fields whose values differ between the expected and predicted maps.
 */
export function differingFields(
	expected: ReadonlyMap<string, string>,
	predicted: ReadonlyMap<string, string>
): string[] {
	const tags = new Set([...expected.keys(), ...predicted.keys()])

	return [...tags].filter((tag) => expected.get(tag) !== predicted.get(tag))
}

/**
 * The first cause in {@linkcode BATTERY_CAUSES} that holds for a wrong row.
 */
export function classifyBatteryError(
	raw: string,
	expected: ReadonlyMap<string, string>,
	predicted: readonly BatterySpan[],
	predictedFields: ReadonlyMap<string, string> = batteryFieldMap(predicted.map((span) => [span[0], span[3]]))
): BatteryCause {
	const wrong = differingFields(expected, predictedFields)

	if (predicted.some(([, start, end]) => insideWord(raw, start) || insideWord(raw, end))) return "word-split"

	if (wrong.includes("unit")) return "designator"

	if (wrong.includes("house_number") || wrong.includes("postcode")) return "number-boundary"

	if (wrong.includes("venue")) return "venue"

	if (wrong.includes("street")) return "street-extent"

	if (wrong.length && wrong.every((tag) => PLACE_TAGS.has(tag))) return "place-level"

	return "other"
}
