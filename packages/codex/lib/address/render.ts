/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Render a component dict through a per-country layout, keeping the tags.
 *
 *   The formatter used to do three things in one function: order the components, join them into a string, and discard
 *   which tag produced which characters. A caller needing two of the three had to re-implement all three, which is why
 *   the same `filter(isPresent).join(…)` was hand-written in 28 files and why three corpus modules each hand-wrote
 *   per-country ordering the templates already encoded.
 *
 *   This is the one render. `formatAddress` is the join over it, and the alignment a caller used to recover by
 *   searching the output string for each value is now a fact the render already holds: {@linkcode AddressRendering}
 *   says which tags it PLACED and names the ones it could not, where a substring search cannot tell a component the
 *   layout dropped from one whose value happens to sit inside another.
 *
 *   ONE RULE, from `@mailwoman/codex/address-layout`: a node that renders nothing removes itself, and its connector
 *   goes with it. A connector between two slots needs a rendered slot on each side; a connector at a line's edge has
 *   one side, so it binds to the slot it touches. Adjacent survivors collapse to the first, so the layout's stronger
 *   separator wins — an absent region gives `New York, 10118`, which is what the engine this replaces produced.
 */

import { isAlternation, isConnector, isLayout, isSlot, type AddressAtom, type AddressLayout } from "#address/layout"
import type { ComponentTag } from "#component"

/**
 * A partial map of `ComponentTag` → string value — the canonical render input.
 */
export type ComponentDict = Partial<Record<ComponentTag, string>>

/**
 * One rendered piece. `tag` is null for a connector, which is what makes a rendering re-joinable at any separator
 * without re-deriving which characters were structural.
 */
export interface AddressPiece {
	readonly tag: ComponentTag | null
	readonly text: string
}

/**
 * What a layout did with a dict.
 */
export interface AddressRendering {
	/**
	 * Every piece in print order, connectors included. Line breaks appear as a piece whose text is `"\n"`.
	 */
	readonly pieces: readonly AddressPiece[]
	/**
	 * The tags the layout printed.
	 */
	readonly placed: readonly ComponentTag[]
	/**
	 * Tags the dict carried a value for that the layout has no slot for — NAMED rather than silently dropped. France
	 * absorbing a region into its postcode line is the common case, and a caller aligning components against the output
	 * needs to know the difference between "not printed" and "not supplied".
	 */
	readonly unplaced: readonly ComponentTag[]
}

/**
 * Whether an atom produced any tagged piece, which is what a connector's neighbours are judged on.
 */
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
 * Which of a run of surviving connectors to print.
 *
 * A run forms when the slots between two connectors all render nothing, so what is left is several separators with no
 * values between them. The STRONGEST wins: a connector carrying punctuation is a harder boundary than a space, and
 * printing the space would join two values the layout meant to separate. `Calle Mayor, 12` keeps its comma when the
 * street suffix is absent, and `New York, 10118` keeps its comma when the region is; the space forms of both would read
 * as one value.
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

			// A connector at an edge binds to the one slot it touches; between slots it needs one on each side.
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

	// Anything still pending trails the last value with nothing after it, so it separates nothing.
	return out.some((piece) => piece.tag !== null) ? out : []
}

function evaluateLines(layout: AddressLayout, components: ComponentDict): readonly AddressPiece[] {
	const lines = layout.lines.map((line) => evaluateLine(line, components)).filter((line) => line.length > 0)

	return lines.flatMap((line, index) => (index > 0 ? [{ tag: null, text: "\n" }, ...line] : line))
}

/**
 * Render `components` through `layout`, keeping the tags.
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
 * Join a rendering into one string, replacing its line breaks with `separator`.
 */
export function joinRendering(rendering: AddressRendering, separator = "\n"): string {
	return rendering.pieces.map((piece) => (piece.tag === null && piece.text === "\n" ? separator : piece.text)).join("")
}
