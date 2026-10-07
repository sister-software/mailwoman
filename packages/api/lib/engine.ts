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
import type { GeocodeResult } from "@mailwoman/core/geocode"

import type { BatchResponse } from "#operations/geocode/batch"
import type { RequestInputMode } from "#operations/input-mode"
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
	inputMode: RequestInputMode
	/**
	 * Whether to include a diagnostic report.
	 */
	debug: boolean
}

/**
 * Geocode one address.
 */
export type GeocodeCallback = (address: string, opts: Pick<ParseInit, "inputMode">) => Promise<GeocodeResult>

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
