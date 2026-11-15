// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Brands for validated payload values.
 *
 *   A brand is a declaration-only unique symbol, so a branded value is a plain number at runtime
 *   and the compiler refuses to pass an unvalidated number where a validated one is expected.
 *   The brands follow the style of `@mailwoman/registry`'s `types.ts`.
 *
 *   A brand records that the engine's validator accepted the value when it built the payload.
 *   Script codes keep the registry's `BCP47.ScriptCode`, and no second script-code type is declared here.
 */

/**
 * Value types a validator produces.
 */
export declare namespace Validated {
	const $Decimal: unique symbol
	const $Integer: unique symbol

	/**
	 * A finite number the engine parsed from a capture.
	 */
	type Decimal = number & { readonly [$Decimal]: true }

	/**
	 * A whole number the engine parsed from a capture, within the range of a signed 64-bit integer.
	 *
	 * A value past `Number.MAX_SAFE_INTEGER` loses precision in a JavaScript number.
	 */
	type Integer = number & { readonly [$Integer]: true }
}
