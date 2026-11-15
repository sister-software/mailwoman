// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Builds the family definition of the `postcode_legacy` family from the legacy-formats table.
 *
 *   The definition is the input format `recognize-build --definition` compiles.
 *   See `packages/recognize/crates/recognize-build/src/definition.rs`
 *   and `packages/recognize/definitions/family-definition.schema.json`.
 *
 *   Shape IDs are plain identifiers.
 *   The known-formats pass reads two pieces of data from each shape and no naming convention:
 *   `order`, the row's position in the table, decides the order of the hits of one text,
 *   and `role: "po_box_leader"` marks a PO box leader.
 */

import { LEGACY_FORMATS, PO_BOX, PO_BOX_LEADERS } from "#legacy-formats/table"

/**
 * The family's ID.
 */
export const FAMILY_ID = "postcode_legacy"

/**
 * The file name the definition is written under.
 * The IR records it as the source of each shape.
 */
export const DEFINITION_FILE = `${FAMILY_ID}.definition.json`

/**
 * The command the generated files name as their generator.
 */
export const GENERATOR = "node packages/postcode/tools/generate.run.ts"

const WORDS = { 1: "one", 2: "two" } as const

/**
 * The ID of the shape of the table's row at `index`.
 */
function shapeID(index: number): string {
	const row = LEGACY_FORMATS[index]!

	return `format.${row.format}_${WORDS[row.tokens]}`
}

/**
 * A literal as regular-expression text.
 */
function escapeLiteral(text: string): string {
	return text.replaceAll(/[.\\+*?()|[\]{}^$]/gu, "\\$&")
}

/**
 * One shape of the definition.
 */
export interface LegacyDefinitionShape {
	id: string
	pattern: string
	role?: "po_box_leader"
	order?: number
	overlaps?: string[]
	metadata: Record<string, unknown>
}

/**
 * The definition `recognize-build --definition` reads.
 */
export interface LegacyDefinition {
	format: string
	version: number
	family: string
	generator: string
	fields: { reader: string; type: string; from: string }
	metadata: Record<string, unknown>
	shapes: LegacyDefinitionShape[]
}

/**
 * The family definition as a plain object, ready to serialize.
 */
export function legacyDefinition(): LegacyDefinition {
	const formats = LEGACY_FORMATS.map((row, index) => {
		const overlaps = "overlaps" in row ? row.overlaps : []

		const partners = LEGACY_FORMATS.flatMap((other, otherIndex) =>
			otherIndex !== index && other.tokens === row.tokens && (overlaps as readonly string[]).includes(other.format)
				? [shapeID(otherIndex)]
				: []
		)

		return {
			id: shapeID(index),
			pattern: row.pattern,
			order: index,
			...(partners.length && { overlaps: partners }),
			metadata: { format: row.format, country: row.country, tokens: row.tokens, confidence: row.confidence },
		}
	})

	const leaders = PO_BOX_LEADERS.map(({ language, leaders: words }) => ({
		id: `po_box.${language}`,
		role: "po_box_leader" as const,
		pattern: `(?i-u:${words.map(escapeLiteral).join("|")})`,
		metadata: { language, leaders: words },
	}))

	return {
		format: "mailwoman.recognize.family-definition",
		version: 1,
		family: FAMILY_ID,
		generator: GENERATOR,
		fields: { reader: "knownFormats", type: "PostcodeLegacyFields", from: "./fields.ts" },
		metadata: { poBox: PO_BOX },
		shapes: [...formats, ...leaders],
	}
}
