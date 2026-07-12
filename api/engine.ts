/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The native-surface engine contract. Engine-agnostic like the drop-ins: the `mailwoman` CLI
 *   wires the real parse/geocode/resolve stack (phase 4b); tests inject fixtures. `format` is the
 *   exception — it's wired in-package from `@mailwoman/formatter` (the surface exists to expose it).
 */

import type { AddressTree } from "@mailwoman/core"

/** One parsed component in reading order (a `ComponentTag` + the covered text). */
export interface ParseComponent {
	tag: string
	value: string
}

/** One parse outcome: ordered components + the full decoded tree (the same language `/v1/resolve` speaks). */
export interface ParseOutcome {
	input: string
	components: ParseComponent[]
	tree: AddressTree
	debug?: string
}

/** A geocode outcome — the engine returns the geocode-core `GeocodeResult` shape verbatim (passthrough). */
export type GeocodeOutcome = Record<string, unknown>

/** A batch row: a GeocodeOutcome, or an `{ input, error }` slot (per-row isolation). */
export type BatchRow = GeocodeOutcome | { input: string; error: string }

export interface ResolveTreeOutcome {
	tree: AddressTree
}

/** The `/health` data block the engine contributes (model card, data-root inventory). */
export type HealthData = Record<string, unknown>

export interface MailwomanAPIEngine {
	parse?(address: string, opts: { debug: boolean }): Promise<ParseOutcome>
	geocode?(address: string): Promise<GeocodeOutcome>
	batch?(addresses: string[]): Promise<{ results: BatchRow[] }>
	resolveTree?(tree: AddressTree, opts: Record<string, unknown>): Promise<ResolveTreeOutcome>
	reload?(): Promise<{ reloaded: boolean; versions: unknown }>
	health?(): HealthData
}
