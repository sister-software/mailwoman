/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The native-surface engine interface. Engine-agnostic like the drop-ins: the `mailwoman` CLI
 *   wires the real parse/geocode/resolve stack, and tests inject fixtures. `format` needs no
 *   engine method, because the routes wire it in-package from `@mailwoman/codex`.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import type { InputModeSelection } from "@mailwoman/core/pipeline"

import type { GeocodeBiasPoint, GeocodeResponse } from "#operations/geocode/address"
import type { BatchResponse } from "#operations/geocode/batch"
import type { ParseResponse } from "#operations/parse/address"
import type { ReloadResponse } from "#operations/reload-data"
import type { ResolveResponse } from "#operations/resolve-tree"

/**
 * The `/health` data block the engine contributes (model card, data-root inventory).
 */
export type HealthData = Record<string, unknown>

/**
 * Per-call options for {@link MailwomanAPIEngine.parse} and the geocode methods.
 */
export interface ParseInit {
	/**
	 * The input register; `formatted` runs the evidence-bundle channels off,
	 * and `auto` derives it from the input.
	 */
	inputMode: InputModeSelection
	/**
	 * Whether to include a diagnostic report.
	 */
	debug: boolean
}

/**
 * Per-call options for {@link MailwomanAPIEngine.geocode}.
 */
export interface GeocodeInit extends Pick<ParseInit, "inputMode"> {
	/**
	 * Points the resolver prefers candidates near.
	 * An empty list applies no bias.
	 */
	bias: readonly GeocodeBiasPoint[]
	/**
	 * Whether the response carries the decoded tree.
	 * When false, `tree` is null.
	 */
	includeTree: boolean
}

/**
 * Geocode one address.
 */
export type GeocodeCallback = (address: string, opts: GeocodeInit) => Promise<GeocodeResponse>

/**
 * The engine the native routes call.
 *
 * Every method is optional.
 * A route whose method is absent answers 501 or 503.
 */
export interface MailwomanAPIEngine {
	parse?(address: string, opts: ParseInit): Promise<ParseResponse>
	geocode?: GeocodeCallback
	batch?(addresses: string[], opts: Pick<ParseInit, "inputMode">): Promise<BatchResponse>
	resolveTree?(tree: AddressTree, opts: Record<string, unknown>): Promise<ResolveResponse>
	reload?(): Promise<ReloadResponse>
	health?(): Promise<HealthData>
}
