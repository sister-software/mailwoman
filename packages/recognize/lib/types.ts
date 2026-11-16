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

import type { BCP47 } from "@mailwoman/registry/types"

/**
 * Value types a validator produces.
 */
export declare namespace Validated {
	const $Decimal: unique symbol
	const $Integer: unique symbol
	const $Latitude: unique symbol
	const $Longitude: unique symbol
	const $Uncertainty: unique symbol
	const $FullPlusCode: unique symbol
	const $ShortPlusCode: unique symbol
	const $Digipin: unique symbol

	/**
	 * A latitude in WGS84 degrees, finite and from -90 to 90 inclusive.
	 * The engine's validator built it, so the range was checked.
	 */
	type Latitude = number & { readonly [$Latitude]: true }

	/**
	 * A longitude in WGS84 degrees, finite and from -180 to 180 inclusive.
	 */
	type Longitude = number & { readonly [$Longitude]: true }

	/**
	 * An uncertainty in meters, finite and not negative.
	 *
	 * Zero is a specific point and is distinct from an absent uncertainty.
	 */
	type Uncertainty = number & { readonly [$Uncertainty]: true }

	/**
	 * A full Open Location Code in upper case: eight digits, the `+`, and two or three digits.
	 *
	 * The `PlusCode` validator accepted it.
	 * It decodes to a cell by itself.
	 */
	type FullPlusCode = string & { readonly [$FullPlusCode]: true }

	/**
	 * A short Open Location Code in upper case: two, four or six digits, the `+`, and two or three digits.
	 *
	 * The `PlusCode` validator accepted it.
	 * It decodes to a cell only beside a reference position.
	 */
	type ShortPlusCode = string & { readonly [$ShortPlusCode]: true }

	/**
	 * A DIGIPIN as ten upper-case characters of the DIGIPIN alphabet, without hyphens.
	 * The `DIGIPIN` validator accepted it.
	 */
	type Digipin = string & { readonly [$Digipin]: true }

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

/**
 * A half-open range of UTF-16 code units.
 */
export interface CharRange {
	readonly start: number
	readonly end: number
}

/**
 * A half-open range of UTF-16 code units and the text it covers.
 */
export interface TextSpan extends CharRange {
	readonly body: string
}

/**
 * The character class of one token.
 */
export const TokenCharacterClass = {
	Digit: "digit",
	Alpha: "alpha",
	Mixed: "mixed",
	Punct: "punct",
	Cjk: "cjk",
	Cyrillic: "cyrillic",
	Arabic: "arabic",
} as const

export type TokenCharacterClass = (typeof TokenCharacterClass)[keyof typeof TokenCharacterClass]

/**
 * The character class of a whole text, folded from its token classes.
 */
export const CharacterClass = {
	Numeric: "numeric",
	Alpha: "alpha",
	Alphanumeric: "alphanumeric",
	Cjk: "cjk",
	Cyrillic: "cyrillic",
	Arabic: "arabic",
	Mixed: "mixed",
} as const

export type CharacterClass = (typeof CharacterClass)[keyof typeof CharacterClass]

/**
 * The separator before a segment: `null` before the first one, and `comma` for a comma or a semicolon.
 */
export type SegmentSeparator = "comma" | "newline" | "tab" | null

/**
 * One script of a text and its share of the codepoints that have a script.
 */
export interface ScriptShare {
	readonly script: BCP47.ScriptCode
	readonly share: number
}

/**
 * One token with its class and script.
 */
export interface TokenClass {
	readonly span: TextSpan
	readonly class: TokenCharacterClass
	readonly script: BCP47.ScriptCode
}

/**
 * One segment between separators, trimmed of white space.
 */
export interface Segment {
	readonly span: TextSpan
	readonly body: string
	/**
	 * The position in the segment list.
	 *
	 * The pipeline's `SegmentView` in `@mailwoman/core` holds it.
	 */
	readonly index: number
	readonly separator: SegmentSeparator
}

/**
 * A region abbreviation such as `NY`: its offset and its text.
 */
export interface RegionAbbreviation {
	readonly start: number
	readonly span: string
}

/**
 * The fields the `structure` family returns: the structural evidence the parse pipeline reads.
 * Offsets are UTF-16 code units, half-open.
 */
export interface StructureFields {
	readonly characterClass: CharacterClass
	readonly scripts: readonly ScriptShare[]
	readonly tokenClasses: readonly TokenClass[]
	readonly segments: readonly Segment[]
	readonly regionAbbreviations: readonly RegionAbbreviation[]
	readonly totalLength: number
}

/**
 * One known format a text holds: a postcode format or a PO box, the span it covers and its confidence.
 *
 * `Format` is the closed union of the names of the family that returns the hit.
 * Offsets are UTF-16 code units, half-open.
 */
export interface KnownFormatHit<Format extends string = string> {
	readonly format: Format
	readonly span: TextSpan
	readonly confidence: number
}

/**
 * The fields a family that fills `knownFormats` returns, with the format names loosely typed.
 *
 * A family declares the same shape with its own union of names.
 */
export interface KnownFormatsFields {
	readonly knownFormats: ReadonlyArray<KnownFormatHit>
}

/**
 * The order a decimal pair was read in.
 *
 * `lat_lon` is the order as written.
 * `lon_lat` is reported only when the written order is out of range and the other order is in range.
 */
export const AxisOrder = {
	LatLon: "lat_lon",
	LonLat: "lon_lat",
} as const

export type AxisOrder = (typeof AxisOrder)[keyof typeof AxisOrder]
