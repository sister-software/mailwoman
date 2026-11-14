// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Renders a publisher's address components into one held-out row.
 *
 *   The text is the single-line address as the country formats it
 *   (`formatAddressRow` with `singleLine`), and the expected spans are the corpus aligner's
 *   alignment of the components onto that text, the annotation every frozen dataset stores.
 *   The module holds no rule for any one country: the codex supplies the format from the country code.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import type { ComponentTag } from "@mailwoman/codex/component"
import { alignRow } from "@mailwoman/corpus/utils/align"

import type { HeldoutRow } from "#tools/eval-harness/heldout/per/country"

/**
 * A rendered row and the components the parser is expected to return, as the formatter rendered them.
 */
export interface RenderedHeldoutRow {
	row: HeldoutRow
	expected: Partial<Record<ComponentTag, string>>
}

/**
 * The held-out row for `components`, or the reason it yields none: `render-failed` when the
 * formatter cannot place the components, `align-<reason>` when the aligner refuses them.
 */
export function renderHeldoutRow(
	components: Partial<Record<ComponentTag, string>>,
	input: { country: string; source: string; sourceID: string; group: string; license: string }
): RenderedHeldoutRow | { refused: string } {
	const rendered = formatAddressRow(components, input.country, { singleLine: true })

	if (!rendered) return { refused: "render-failed" }

	const aligned = alignRow({
		raw: rendered.raw,
		components: rendered.components,
		country: input.country,
		source: input.source,
		source_id: input.sourceID,
		license: input.license,
	})

	if (aligned.kind !== "labeled") return { refused: `align-${aligned.row.reason}` }

	const { span_starts: starts, span_ends: ends, span_tags: tags } = aligned.row

	// A labeled row always holds its span triple.
	// A row without one is a fault of the aligner.
	if (!starts || !ends || !tags) throw new Error(`the aligner labeled ${input.sourceID} without its span triple`)

	return {
		row: {
			raw: aligned.row.raw,
			span_starts: [...starts],
			span_ends: [...ends],
			span_tags: [...tags],
			country: input.country,
			source: input.source,
			source_id: input.sourceID,
			group: input.group,
		},
		expected: rendered.components,
	}
}
