// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   A row's street components, written under its country's street span convention.
 *
 *   `docs/engineering/reference/SCHEMA.mdx` labels a US street's directional
 *   and type as `street_prefix` and `street_suffix` spans.
 *   An adapter that reads one street line, such as the NPPES practice location
 *   or a notary register's address, emits the whole line as `street`.
 *
 *   The model then learns both forms for one US street.
 *   The evaluation reads the whole form as an unlabeled affix.
 */

import { streetSpanConventionFor } from "@mailwoman/codex/labels/street/convention"

import type { CanonicalRow } from "#types"
import { decomposeStreet } from "#us/adapters/tiger/street-decompose"

/**
 * Returns `components` with a whole `street` split into `street_prefix`, `street`
 * and `street_suffix` when `country`'s convention is `split` and the row labels no street affix.
 *
 * The split reads the dictionaries the TIGER adapter's {@linkcode decomposeStreet} reads,
 * so every US source labels one street one way.
 * A street with no directional or type keyword keeps its one span.
 */
export function withConventionStreet(
	components: CanonicalRow["components"],
	country: string
): CanonicalRow["components"] {
	const street = components.street

	if (!street || streetSpanConventionFor(country) !== "split") return components

	if (components.street_prefix || components.street_suffix || components.street_prefix_particle) return components

	const { prefix, street: name, suffix } = decomposeStreet(street)

	if (!prefix && !suffix) return components

	return {
		...components,
		...(prefix ? { street_prefix: prefix } : {}),
		street: name,
		...(suffix ? { street_suffix: suffix } : {}),
	}
}
