/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Renders a component dict through an address layout into tagged pieces; `formatAddress` joins the pieces into
 *   a string, and the connector rules are described in `layout.ts`.
 */

import { isAlternation, isConnector, isLayout, isSlot, type AddressAtom, type AddressLayout } from "#address/layout"
import type { ComponentTag } from "#component"

/**
 * Component values keyed by tag.
 * This is the render input.
 */
export type ComponentDict = Partial<Record<ComponentTag, string>>

/**
 * One rendered piece of text.
 *
 * `tag` is null for connectors and line breaks.
 */
export interface AddressPiece {
	readonly tag: ComponentTag | null
	readonly text: string
	/**
	 * Marks a line break that the layout declared soft.
	 * Soft breaks still have the text `"\n"`.
	 */
	readonly softBreak?: true
}

/**
 * The result of rendering a dict through a layout.
 */
export interface AddressRendering {
	/**
	 * Every piece in print order, including connectors.
	 * A line break is a piece with the text `"\n"`.
	 */
	readonly pieces: readonly AddressPiece[]
	/**
	 * The tags the layout printed.
	 */
	readonly placed: readonly ComponentTag[]
	/**
	 * Tags that have a value in the dict but no slot in the layout.
	 *
	 * For example, the French layout has no region slot.
	 */
	readonly unplaced: readonly ComponentTag[]
}

function rendered(result: readonly AddressPiece[] | null): boolean {
	return result !== null && result.some((piece) => piece.tag !== null)
}

function evaluateAtom(atom: AddressAtom, components: ComponentDict): readonly AddressPiece[] | null {
	if (isSlot(atom)) {
		const text = components[atom.tag]?.trim()

		return text ? [{ tag: atom.tag, text }] : null
	}

	if (isAlternation(atom)) {
		for (const alternative of atom.alternatives) {
			const pieces = evaluateLines(alternative, components)

			if (pieces.length) return pieces
		}

		return null
	}

	if (isLayout(atom)) {
		const pieces = evaluateLines(atom, components)

		return pieces.length ? pieces : null
	}

	return null
}

/**
 * Picks one connector from adjacent surviving connectors.
 *
 * The first connector with punctuation wins, so `New York, 10118` keeps its comma when the region is absent.
 */
function strongestConnector(run: readonly string[]): string {
	return run.find((text) => /\S/u.test(text)) ?? run[0]!
}

function evaluateLine(atoms: readonly AddressAtom[], components: ComponentDict): readonly AddressPiece[] {
	const results = atoms.map((atom) => (isConnector(atom) ? null : evaluateAtom(atom, components)))
	const out: AddressPiece[] = []
	let pending: string[] = []

	const flush = (): void => {
		if (!pending.length) return

		out.push({ tag: null, text: strongestConnector(pending) })
		pending = []
	}

	for (const [index, atom] of atoms.entries()) {
		if (isConnector(atom)) {
			const left = results.slice(0, index)
			const right = results.slice(index + 1)

			// An edge connector needs its one neighbour; an interior connector needs a rendered atom on each side.
			const survives = !left.length
				? rendered(results[index + 1] ?? null)
				: !right.length
					? rendered(results[index - 1] ?? null)
					: left.some(rendered) && right.some(rendered)

			if (survives) {
				pending.push(atom.connector)
			}

			continue
		}

		const pieces = results[index]

		if (!pieces) continue

		flush()
		out.push(...pieces)
	}

	// Anything still pending trails the last value with no piece after it, so it separates no pair.
	return out.some((piece) => piece.tag !== null) ? out : []
}

function evaluateLines(layout: AddressLayout, components: ComponentDict): readonly AddressPiece[] {
	// Each line keeps its layout index because `softBreakBefore` uses indices from before empty lines are removed.
	const lines = layout.lines
		.map((line, index) => ({ index, pieces: evaluateLine(line, components) }))
		.filter((line) => line.pieces.length)

	return lines.flatMap((line, position) => {
		if (position === 0) return line.pieces

		const before: AddressPiece = layout.softBreakBefore?.has(line.index)
			? { tag: null, text: "\n", softBreak: true }
			: { tag: null, text: "\n" }

		return [before, ...line.pieces]
	})
}

/**
 * Renders `components` through `layout` into tagged pieces.
 */
export function renderAddress(layout: AddressLayout, components: ComponentDict): AddressRendering {
	const pieces = evaluateLines(layout, components)
	const placed = [...new Set(pieces.map((piece) => piece.tag).filter((tag): tag is ComponentTag => tag !== null))]
	const placedSet = new Set<ComponentTag>(placed)

	const unplaced = (Object.keys(components) as ComponentTag[]).filter(
		(tag) => Boolean(components[tag]?.trim()) && !placedSet.has(tag)
	)

	return { pieces, placed, unplaced }
}

/**
 * Joins a rendering into one string and replaces its line breaks with `separator`.
 *
 * Soft breaks use `softSeparator`, which defaults to `separator`.
 */
export function joinRendering(rendering: AddressRendering, separator = "\n", softSeparator = separator): string {
	return rendering.pieces
		.map((piece) => {
			if (piece.tag !== null || piece.text !== "\n") return piece.text

			return piece.softBreak ? softSeparator : separator
		})
		.join("")
}
