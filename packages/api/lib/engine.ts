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

import type { GeocodeOutcomeLike } from "#schema"

/**
 * One parsed component in reading order (a `ComponentTag` + the covered text).
 */
export interface ParseComponent {
	tag: string
	value: string
}

/**
 * One parse outcome: ordered components + the full decoded tree (the same language `/v1/resolve` speaks).
 */
export interface ParsedAddressResult {
	input: string
	components: ParseComponent[]
	tree: AddressTree
	debug?: string
}

export interface BatchResultFailure {
	input: string
	error: string
}

/**
 * A batch row slot (per-row isolation).
 */
export type BatchResultEntry<T extends Partial<GeocodeOutcomeLike> = GeocodeOutcomeLike> = T | BatchResultFailure

export interface ResolveTreeOutcome {
	tree: AddressTree
}

/**
 * The `/health` data block the engine contributes (model card, data-root inventory).
 */
export type HealthData = Record<string, unknown>

/**
 * The input register (Decision A / GTM B10; canonical docs on `@mailwoman/core/pipeline`'s `InputMode` — duplicated
 * structurally so `@mailwoman/api` stays engine-agnostic). `formatted` runs the evidence-bundle channels off.
 */
export type WireInputMode = "fragmented" | "formatted"

export interface ParseInit {
	inputMode?: WireInputMode
	debug?: boolean
}

export type GeocodeCallback<T extends Partial<GeocodeOutcomeLike> = GeocodeOutcomeLike> = (
	address: string,
	opts?: ParseInit
) => Promise<T>

export interface MailwomanAPIEngine<T extends Partial<GeocodeOutcomeLike> = GeocodeOutcomeLike> {
	parse?(address: string, opts: ParseInit): Promise<ParsedAddressResult>
	geocode?: GeocodeCallback<T>
	batch?(addresses: string[], opts?: ParseInit): Promise<{ results: BatchResultEntry<T>[] }>
	resolveTree?(tree: AddressTree, opts: Record<string, unknown>): Promise<ResolveTreeOutcome>
	reload?(): Promise<{ reloaded: boolean; versions: unknown }>
	health?(): Promise<HealthData>
}
