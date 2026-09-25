/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Address layouts written as tagged templates in print order. Interpolations are slots, and the literal text
 *   between them is a connector.
 *
 *   A node that renders nothing drops out together with its connector. An interior connector renders only when
 *   both neighbours rendered. An edge connector binds to the one slot it touches, so Japan's 〒 mark drops with an
 *   absent postcode.
 *
 *   The evaluator lives in `render.ts`, so modules that only need the layout table do not load it.
 */

import { COMPONENT_TAGS, type ComponentTag } from "#component"

/**
 * A slot that renders one component tag's value, or nothing when the value is absent.
 */
export interface AddressSlot {
	readonly tag: ComponentTag
}

/**
 * Literal text that renders only between neighbours that rendered.
 *
 * The `addr` template creates connectors from the text between interpolations.
 */
export interface AddressConnector {
	readonly connector: string
}

/**
 * A choice that renders its first alternative with output.
 *
 * The street line uses it to choose between an intersection and a street address.
 */
export interface AddressAlternation {
	readonly alternatives: readonly AddressLayout[]
}

/**
 * One element of a layout line.
 */
export type AddressAtom = AddressSlot | AddressConnector | AddressAlternation | AddressLayout

/**
 * Lines of atoms in print order.
 *
 * The caller chooses how lines are joined for single-line output.
 */
export interface AddressLayout {
	readonly lines: ReadonlyArray<readonly AddressAtom[]>
	/**
	 * Indices of lines whose preceding break becomes a space in single-line output,
	 * in place of the system's join.
	 *
	 * Great Britain prints the post town and postcode on separate lines,
	 * but its single-line form is `27 Minories, London EC3N 1DE`.
	 *
	 * Each index refers to the line after the break.
	 * `evaluateLines` drops empty lines, and an index into the template's lines stays valid after that drop.
	 */
	readonly softBreakBefore?: ReadonlySet<number>
}

/**
 * Returns a copy of the layout with a soft break before the line that starts with `tag`.
 *
 * The line is found by tag so that edits to earlier lines do not move the mark.
 * When no line after the first starts with `tag`, the layout is returned unchanged.
 */
export function withSoftBreakBefore(layout: AddressLayout, tag: string): AddressLayout {
	const index = layout.lines.findIndex((line) => {
		const first = line.find((atom) => !isConnector(atom))

		return Boolean(first && isSlot(first) && first.tag === tag)
	})

	if (index <= 0) return layout

	return { ...layout, softBreakBefore: new Set([...(layout.softBreakBefore ?? []), index]) }
}

/**
 * Returns whether an atom is a slot.
 */
export function isSlot(atom: AddressAtom): atom is AddressSlot {
	return "tag" in atom
}

/**
 * Returns whether an atom is a connector.
 */
export function isConnector(atom: AddressAtom): atom is AddressConnector {
	return "connector" in atom
}

/**
 * Returns whether an atom is an alternation.
 */
export function isAlternation(atom: AddressAtom): atom is AddressAlternation {
	return "alternatives" in atom
}

/**
 * Returns whether an atom is a nested layout.
 */
export function isLayout(atom: AddressAtom): atom is AddressLayout {
	return "lines" in atom
}

/**
 * A slot for every {@linkcode ComponentTag}, keyed by tag.
 *
 * Layouts reference `SLOTS.<tag>` so that a misspelled tag fails to compile.
 */
export const SLOTS: Readonly<Record<ComponentTag, AddressSlot>> = Object.freeze(
	Object.fromEntries(COMPONENT_TAGS.map((tag) => [tag, Object.freeze({ tag })])) as Record<ComponentTag, AddressSlot>
)

/**
 * Creates an alternation that renders the first alternative with output.
 */
export function either(...alternatives: readonly AddressLayout[]): AddressAlternation {
	return { alternatives }
}

/**
 * The post-office box line, printed directly above the street line.
 *
 * A record can hold both a box and a street address, and both lines are printed.
 * Libaddressinput has no box field, so this placement is defined here.
 */
const poBoxLine = SLOTS.po_box

/**
 * The street line with the number first, used by anglophone systems and France.
 */
export const numberFirstStreet: AddressLayout = addr`${poBoxLine}
${either(
	addr`${SLOTS.intersection_a} & ${SLOTS.intersection_b}`,
	addr`${SLOTS.house_number} ${SLOTS.street_prefix} ${SLOTS.street_prefix_particle} ${SLOTS.street} ${SLOTS.street_suffix} ${SLOTS.unit}`
)}`

/**
 * The street line with the number first and a comma before the name, used by India.
 */
export const numberFirstCommaStreet: AddressLayout = addr`${poBoxLine}
${either(
	addr`${SLOTS.intersection_a} & ${SLOTS.intersection_b}`,
	addr`${SLOTS.house_number}, ${SLOTS.street_prefix} ${SLOTS.street_prefix_particle} ${SLOTS.street} ${SLOTS.street_suffix} ${SLOTS.unit}`
)}`

/**
 * The street line with the number after the name, used by German-order systems and Italy.
 */
export const numberLastStreet: AddressLayout = addr`${poBoxLine}
${either(
	addr`${SLOTS.intersection_a} & ${SLOTS.intersection_b}`,
	addr`${SLOTS.street_prefix} ${SLOTS.street_prefix_particle} ${SLOTS.street} ${SLOTS.street_suffix} ${SLOTS.house_number} ${SLOTS.unit}`
)}`

/**
 * The street line with the number after the name and a comma between them, as in `Calle Mayor, 12`.
 *
 * Brazil uses this form.
 * Spain's corpus recipe renders both this form and the space form because people type both.
 */
export const numberLastCommaStreet: AddressLayout = addr`${poBoxLine}
${either(
	addr`${SLOTS.intersection_a} & ${SLOTS.intersection_b}`,
	addr`${SLOTS.street_prefix} ${SLOTS.street_prefix_particle} ${SLOTS.street} ${SLOTS.street_suffix}, ${SLOTS.house_number} ${SLOTS.unit}`
)}`

/**
 * The Han-script street line, with the name and number written together, as in `佐敦道21號`.
 *
 * A space between them is a romanized convention and is wrong in Han script.
 * The generated skeletons reference this node alongside the other street lines.
 */
export const hanStreet: AddressLayout = addr`${poBoxLine}
${either(
	addr`${SLOTS.intersection_a} & ${SLOTS.intersection_b}`,
	addr`${SLOTS.street_prefix}${SLOTS.street_prefix_particle}${SLOTS.street}${SLOTS.street_suffix}${SLOTS.house_number}${SLOTS.unit}`
)}`

/**
 * Builds a layout from a tagged template.
 *
 * A newline in the literal text starts a new line, and other literal text becomes a connector.
 * Each interpolation is a slot, an alternation or a nested layout.
 */
export function addr(strings: TemplateStringsArray, ...values: readonly AddressAtom[]): AddressLayout {
	const lines: AddressAtom[][] = [[]]

	const push = (atom: AddressAtom): void => {
		lines.at(-1)!.push(atom)
	}

	for (const [index, raw] of strings.entries()) {
		// Template literal segments come from source code, so their size is fixed.
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
