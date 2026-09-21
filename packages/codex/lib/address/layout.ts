/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Per-address-system layouts: the order a system prints its components in, as data.
 *
 *   A layout is written as a tagged template that reads in the order it prints, so reviewing one means looking at the
 *   shape of the address it produces rather than at a nested function call. The interpolations are slots. the literal
 *   text between them are connectors.
 *
 *   one rule governs rendering, and it replaces four mechanisms that each did part of the job elsewhere — the
 *   `filter(isPresent).join(…)` written by hand in 28 files, a pass that stripped a connector a template wrote between
 *   two slots when one was empty, a pass that spliced a missing line back in, and a chain of `if (x) parts.push(x)`:
 *
 *   > A node that renders nothing removes itself, and its connector goes with it.
 *
 *   A connector between two slots renders when a slot rendered on each side of it. A connector at the edge of a line
 *   has only one side, so it binds to the single slot it touches — which is how Japan's postal mark 〒 disappears with
 *   an absent postcode while an interior space does not.
 *
 *   why A template rather than nested calls. The order has to be readable by someone checking whether a country is
 *   right, and the check is "does this look like an address from there". A nested `seq(", ", locality, seq(" ", region,
 *   postcode))` encodes the same thing and reads like a parser. The template also needs no nesting for the common case:
 *   treating every separator as a connector makes each line flat, and the four outcomes of a partially-filled tail
 *   (`New York, NY 10118` / `New York, NY` / `New York, 10118` / `NY 10118`) fall out of the one rule.
 *
 *   The renderer is the sibling `render.ts`, and the public surface over it is `format.ts`. They are separate modules
 *   rather than one so a consumer that only wants the table — a conformance check, a documentation build — imports
 *   `#address/layouts` and loads no evaluator.
 */

import { COMPONENT_TAGS, type ComponentTag } from "#component"

/**
 * A slot: one component tag's value, or nothing when the dict has no value for it.
 */
export interface AddressSlot {
	readonly tag: ComponentTag
}

/**
 * A connector: literal text that renders only between neighbours that rendered.
 *
 * Written as the text between interpolations, never constructed by hand.
 */
export interface AddressConnector {
	readonly connector: string
}

/**
 * First alternative that renders.
 *
 * The street line needs it and nothing else does: an intersection prints as `<a> & <b>`
 * where a street prints as its own family of tags.
 */
export interface AddressAlternation {
	readonly alternatives: readonly AddressLayout[]
}

export type AddressAtom = AddressSlot | AddressConnector | AddressAlternation | AddressLayout

/**
 * A layout: lines of atoms, in print order.
 *
 * A line break in the template starts a new line. how lines are joined for single-line
 * output is the caller's choice, and per-system for the systems that join on nothing.
 */
export interface AddressLayout {
	readonly lines: ReadonlyArray<readonly AddressAtom[]>
	/**
	 * Line indices whose preceding break collapses to a space on one line
	 * rather than taking the system's join.
	 *
	 * A system can need two different joins between its own lines. Great Britain prints the post town and the postcode on
	 * separate lines, which is Royal Mail's form and what the multi-line render must keep, while one line is written `27
	 * Minories, London EC3N 1DE` — a comma after the street and a space before the postcode. One join per system cannot
	 * say that, and the single-line render answered `London, EC3N 1DE`.
	 *
	 * Keyed by the line a break PRECEDES rather than the one it follows,
	 * because `evaluateLines` drops a line no component filled.
	 * An index counted from the left survives that drop, and a count of breaks does not.
	 */
	readonly softBreakBefore?: ReadonlySet<number>
}

/**
 * The same layout, with the break before the line that starts with `tag` marked soft.
 *
 * Named by tag rather than by index so the mark survives an edit to the lines above it.
 * A layout with no line starting on `tag` is returned unchanged: the caller is describing a line that
 * is not there, and silently marking some other break would move a separator nobody asked about.
 */
export function withSoftBreakBefore(layout: AddressLayout, tag: string): AddressLayout {
	const index = layout.lines.findIndex((line) => {
		const first = line.find((atom) => !isConnector(atom))

		return Boolean(first && isSlot(first) && first.tag === tag)
	})

	if (index <= 0) return layout

	return { ...layout, softBreakBefore: new Set([...(layout.softBreakBefore ?? []), index]) }
}

export function isSlot(atom: AddressAtom): atom is AddressSlot {
	return "tag" in atom
}

export function isConnector(atom: AddressAtom): atom is AddressConnector {
	return "connector" in atom
}

export function isAlternation(atom: AddressAtom): atom is AddressAlternation {
	return "alternatives" in atom
}

export function isLayout(atom: AddressAtom): atom is AddressLayout {
	return "lines" in atom
}

/**
 * Every {@linkcode ComponentTag} as a slot, so a layout names a tag by destructuring
 * rather than by quoting it.
 *
 * A misspelled slot is then an unresolved identifier at compile time, and the spelling
 * stays the tag's own — `dependent_locality`, never a parallel camelCase vocabulary.
 */
export const SLOTS: Readonly<Record<ComponentTag, AddressSlot>> = Object.freeze(
	Object.fromEntries(COMPONENT_TAGS.map((tag) => [tag, Object.freeze({ tag })])) as Record<ComponentTag, AddressSlot>
)

/**
 * The first alternative that renders wins.
 *
 * Used for the street line, where an intersection and a street name are two ways
 * of saying where rather than two things to print.
 */
export function either(...alternatives: readonly AddressLayout[]): AddressAlternation {
	return { alternatives }
}

/**
 * A post-office box takes a line of its own directly above the street line,
 * and coexists with one: a record may carry both a box and a street address,
 * and printing the box alone would lose the half a courier needs.
 *
 * That placement is measured rather than assumed.
 * The engine this table replaces rendered `P.O. Box 5` + `100 Main St` + `Portland, or 97214`
 * as three lines in that order, and the same shape for Germany, Australia and Great Britain.
 * libaddressinput models no box at all, which is why the slot is authored here rather than transcribed.
 */
const poBoxLine = SLOTS.po_box

/**
 * The street line where the number leads: the anglophone order, and France's.
 *
 * An intersection is an alternative to the street name because it is a different way of saying
 * where rather than a second thing to print — the shape the old `composeRoad` drew in
 * its own docstring before hand-compiling it into a chain of `if` statements.
 * The box is not an alternative, so it sits outside the choice.
 */
export const numberFirstStreet: AddressLayout = addr`${poBoxLine}
${either(
	addr`${SLOTS.intersection_a} & ${SLOTS.intersection_b}`,
	addr`${SLOTS.house_number} ${SLOTS.street_prefix} ${SLOTS.street_prefix_particle} ${SLOTS.street} ${SLOTS.street_suffix} ${SLOTS.unit}`
)}`

/**
 * The number-first line where a comma separates the number from the name — India's order.
 */
export const numberFirstCommaStreet: AddressLayout = addr`${poBoxLine}
${either(
	addr`${SLOTS.intersection_a} & ${SLOTS.intersection_b}`,
	addr`${SLOTS.house_number}, ${SLOTS.street_prefix} ${SLOTS.street_prefix_particle} ${SLOTS.street} ${SLOTS.street_suffix} ${SLOTS.unit}`
)}`

/**
 * The street line where the number follows the name: the German-order systems, and Italy.
 */
export const numberLastStreet: AddressLayout = addr`${poBoxLine}
${either(
	addr`${SLOTS.intersection_a} & ${SLOTS.intersection_b}`,
	addr`${SLOTS.street_prefix} ${SLOTS.street_prefix_particle} ${SLOTS.street} ${SLOTS.street_suffix} ${SLOTS.house_number} ${SLOTS.unit}`
)}`

/**
 * The number-last line where a comma separates the name from the number —
 * `Calle Mayor, 12`, and Brazil's order.
 *
 * The separator is not cosmetic.
 * Spain's corpus recipe renders both this form and the space form on purpose, because both
 * occur in what a person types. collapsing one into the other would remove half the signal.
 */
export const numberLastCommaStreet: AddressLayout = addr`${poBoxLine}
${either(
	addr`${SLOTS.intersection_a} & ${SLOTS.intersection_b}`,
	addr`${SLOTS.street_prefix} ${SLOTS.street_prefix_particle} ${SLOTS.street} ${SLOTS.street_suffix}, ${SLOTS.house_number} ${SLOTS.unit}`
)}`

/**
 * The street line written in Han script: the name, then the number, with nothing between them — `佐敦道21號`.
 *
 * A separator is not optional here the way a space or a comma is elsewhere.
 * `佐敦道 21號` is the romanized convention spelled in Chinese characters, which is what
 * a Latin-order layout produces when it is handed Han components, and it is the half
 * of the Hong Kong defect that survives getting the field order right.
 *
 * Lives beside the other street nodes rather than in the layout table, because the
 * generated skeletons name it: a country's local-script street order is the same
 * kind of fact as its number-first or number-last order.
 */
export const hanStreet: AddressLayout = addr`${poBoxLine}
${either(
	addr`${SLOTS.intersection_a} & ${SLOTS.intersection_b}`,
	addr`${SLOTS.street_prefix}${SLOTS.street_prefix_particle}${SLOTS.street}${SLOTS.street_suffix}${SLOTS.house_number}${SLOTS.unit}`
)}`

/**
 * Build a layout from a tagged template.
 *
 * A newline in the literal text starts a line. other literal text is a connector.
 * an interpolation is a slot, an alternation, or another layout.
 */
export function addr(strings: TemplateStringsArray, ...values: readonly AddressAtom[]): AddressLayout {
	const lines: AddressAtom[][] = [[]]

	const push = (atom: AddressAtom): void => {
		lines.at(-1)!.push(atom)
	}

	for (const [index, raw] of strings.entries()) {
		// A template's literal segment is bounded by the source text that spells it — one address line at most, and a
		// layout cannot grow at runtime.
		// oxlint-disable-next-line mailwoman/prefer-spliterator -- bounded by the source text, see above
		const segments = raw.split("\n")

		for (const [segmentIndex, segment] of segments.entries()) {
			if (segmentIndex > 0) {
				lines.push([])
			}

			if (segment) {
				push({ connector: segment })
			}
		}

		const value = values[index]

		if (value) {
			push(value)
		}
	}

	return { lines: lines.filter((line) => line.length) }
}
