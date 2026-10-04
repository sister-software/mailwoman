/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The US filing denominator control. A broadband filing row describes a provider, technology and speed
 *   tier for a census block, and several rows can describe one block. The only count the rows support is
 *   the number of distinct blocks. Buildings, units and subscribers need their own records.
 */

import type { Evidence } from "#links"

export interface FilingRow {
	block: string
	provider: string
	technology: string
	speedTier: string
	evidence: Evidence
}

export interface FilingDenominators {
	blocks: number
	buildings: "unknown"
	units: "unknown"
	subscribers: "unknown"
}

export function distinctBlocks(rows: readonly FilingRow[]): FilingDenominators {
	return {
		blocks: new Set(rows.map((row) => row.block)).size,
		buildings: "unknown",
		units: "unknown",
		subscribers: "unknown",
	}
}
