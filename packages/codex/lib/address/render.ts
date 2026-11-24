// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Renders a component dictionary through an address layout into tagged pieces.
 *
 *   `formatAddress` joins the pieces into a string.
 *   `layout.ts` describes connector rules.
 */

import {
	isAlternation,
	isConnector,
	isLayout,
	isSlot,
	type AddressAtom,
	type AddressLayout,
	type AddressSlot,
} from "#address/layout"
import type { ComponentTag } from "#component"
import { withoutPrintedPrefix, withoutRepeatedPrefix, withPrintedPrefix } from "#labels/postcode/printed-prefix"

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
	readonly softBreak: boolean
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

/**
 * Options accepted by {@linkcode renderAddress}.
 */
export interface RenderAddressOptions {
	/**
	 * A number in [0, 1) that picks which documented form a slot with
	 * {@linkcode AddressSlot.otherForms} prints, each form taking its share of the interval.
	 *
	 * A corpus writer derives it from the row's identity, so one row always renders one form.
	 * Unset, every slot adds its first form's prefix to a value that lacks one,
	 * and prints a value that already holds a prefix as given.
	 */
	formDraw?: number | null
}

/**
 * What one render reads: the components and the form draw.
 */
interface RenderInput {
	readonly components: ComponentDict
	readonly formDraw: number | null
}

/**
 * The prefix `slot` prints in this render: the form whose share of [0, 1) holds `formDraw`,
 * the other forms taking the interval's start in order and the slot's own prefix the remainder.
 */
function chosenPrefix(slot: AddressSlot, formDraw: number | null): string | undefined {
	if (typeof formDraw !== "number" || !slot.otherForms) return slot.prefix

	let edge = 0

	for (const form of slot.otherForms) {
		edge += form.share

		if (formDraw < edge) return form.prefix
	}

	return slot.prefix
}

/**
 * The text a slot prints for `value`: its prefix written once, and a postcode's repeated
 * country code, such as GLEIF's `FI-FI-15860`, written once even where the layout prints none.
 *
 * In a drawn render, a slot whose drawn form is bare prints the value without the marks
 * of its other forms, so the domestic form of GLEIF's `HR-10000` is `10000`.
 * An undrawn render prints a value that holds a prefix as given.
 */
function printedValue(slot: AddressSlot, value: string, formDraw: number | null): string {
	const prefix = chosenPrefix(slot, formDraw)

	if (prefix) return withPrintedPrefix(prefix, value)

	// Only a drawn render removes a prefix: a caller's `FI-15860` prints as given.
	if (slot.otherForms && typeof formDraw === "number") {
		return withoutPrintedPrefix([slot.prefix ?? "", ...slot.otherForms.map((form) => form.prefix)], value)
	}

	return slot.tag === "postcode" ? withoutRepeatedPrefix(value) : value
}

function evaluateAtom(atom: AddressAtom, input: RenderInput): readonly AddressPiece[] | null {
	if (isSlot(atom)) {
		const value = input.components[atom.tag]?.trim()
		const text = value ? printedValue(atom, value, input.formDraw) : atom.fallback

		return text ? [{ tag: atom.tag, text, softBreak: false }] : null
	}

	if (isAlternation(atom)) {
		for (const alternative of atom.alternatives) {
			const pieces = evaluateLines(alternative, input)

			if (pieces.length) return pieces
		}

		return null
	}

	if (isLayout(atom)) {
		const pieces = evaluateLines(atom, input)

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

function evaluateLine(atoms: readonly AddressAtom[], input: RenderInput): readonly AddressPiece[] {
	const results = atoms.map((atom) => (isConnector(atom) ? null : evaluateAtom(atom, input)))
	const out: AddressPiece[] = []
	let pending: string[] = []

	const flush = (): void => {
		if (!pending.length) return

		out.push({ tag: null, text: strongestConnector(pending), softBreak: false })
		pending = []
	}

	for (const [index, atom] of atoms.entries()) {
		if (isConnector(atom)) {
			const left = results.slice(0, index)
			const right = results.slice(index + 1)

			// An edge connector needs its one neighbor.
			// An interior connector needs a rendered atom on each side.
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

function evaluateLines(layout: AddressLayout, input: RenderInput): readonly AddressPiece[] {
	// Each line keeps its layout index because `softBreakBefore` uses indices from before empty lines are removed.
	const lines = layout.lines
		.map((line, index) => ({ index, pieces: evaluateLine(line, input) }))
		.filter((line) => line.pieces.length)

	return lines.flatMap((line, position) => {
		if (position === 0) return line.pieces

		const before: AddressPiece = layout.softBreakBefore?.has(line.index)
			? { tag: null, text: "\n", softBreak: true }
			: { tag: null, text: "\n", softBreak: false }

		return [before, ...line.pieces]
	})
}

/**
 * Renders `components` through `layout` into tagged pieces.
 */
export function renderAddress(
	layout: AddressLayout,
	components: ComponentDict,
	opts: RenderAddressOptions = {}
): AddressRendering {
	const pieces = evaluateLines(layout, { components, formDraw: opts.formDraw ?? null })
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
			if (piece.tag || piece.text !== "\n") return piece.text

			return piece.softBreak ? softSeparator : separator
		})
		.join("")
}
