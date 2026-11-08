// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { walkNodes, type AddressNode } from "@mailwoman/core/decoder"
import type { ResolverBackend } from "@mailwoman/core/resolver"

import { decorateNode } from "#decorate-node"

/**
 * A character that separates the parts of an address in some script.
 */
const SEPARATOR = /[\s,，、;；/|·・]/u

/**
 * Reads an input as one place when its whole text names that place and the parse resolved none of its parts.
 *
 * `ミュンヘン` and `裕廊东` hold no separator.
 * The en-US parser reads them as a venue, or splits them into fragments the
 * gazetteer does not key, while it keys both whole names.
 *
 * An unspaced address whose parts resolve, or whose whole text names no place, keeps its parse.
 * This runs after the landmark layer, so a venue the landmark layer knows keeps that answer.
 */
export async function applyWholeInputPlace(
	roots: AddressNode[],
	written: string,
	backend: ResolverBackend,
	country: string | null
): Promise<void> {
	const text = written.trim()
	const nodes = [...walkNodes(roots)]

	if (!text || SEPARATOR.test(text) || nodes.some((node) => node.placeID)) return

	// A lone admin span already looked up its whole text, under the placetype and scope the walk applies.
	// Fragments and a venue span did not.
	if (nodes.length < 2 && nodes[0]?.tag !== "venue") return

	const found = await backend.findPlace({ text, ...(country ? { country } : {}) }).catch(() => [])
	const [place, ...others] = found

	if (!place?.exactMatch) return

	const whole = { tag: "locality", value: text, start: 0, end: text.length, confidence: 1, children: [] } as AddressNode

	decorateNode(whole, place, others)
	whole.metadata = { ...whole.metadata, whole_input_place: true }
	roots.splice(0, roots.length, whole)
}
