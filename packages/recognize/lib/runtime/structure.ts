// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Reads the `structure` family's fields from the engine's binary result.
 *
 *   One call into the engine returns the tokens, the segments, the region abbreviations
 *   and the script counts as `u32` words in linear memory.
 *   This module reads them in place and builds the structural objects of the parse pipeline,
 *   with offsets converted from UTF-8 bytes to UTF-16 code units.
 *
 *   The two orderings the legacy code fixes are kept: scripts rank by share and
 *   then by `localeCompare` on the code, and a token's script is the one the
 *   engine chose, with ties to the script seen first.
 */

import type { BCP47 } from "@mailwoman/registry/types"

import { offsetMap } from "#offsets"
import {
	ErrorCode,
	HitKind,
	KNOWN_FORMAT_WORDS,
	NO_FAMILY,
	SEGMENT_WORDS,
	STRUCTURE_HEADER_WORDS,
	TOKEN_WORDS,
} from "#runtime/abi"
import { stageText } from "#runtime/engine"
import { RecognizeError } from "#runtime/errors"
import { type Instance, trapped } from "#runtime/state"
import type {
	CharacterClass,
	KnownFormatHit,
	KnownFormatsFields,
	RegionAbbreviation,
	ScriptShare,
	Segment,
	SegmentSeparator,
	StructureFields,
	TokenCharacterClass,
	TokenClass,
} from "#types"

/**
 * The token class of each class code, in the order of `TokenClass`
 * in `crates/recognize-core/src/structure.rs`.
 */
const TOKEN_CLASSES: readonly TokenCharacterClass[] = ["digit", "alpha", "mixed", "punct", "cjk", "cyrillic", "arabic"]

/**
 * The script of each script code, in the order of `Script` in `crates/recognize-core/src/charset.rs`.
 * The values are the ten the legacy classifier produces.
 */
const SCRIPT_CODES: readonly BCP47.ScriptCode[] = [
	"Latn",
	"Hani",
	"Hira",
	"Kana",
	"Hang",
	"Cyrl",
	"Arab",
	"Yiii",
	"Zyyy",
	"Zzzz",
].map((code) => code as BCP47.ScriptCode)

/**
 * The separator of each separator code, in the order of `Separator`
 * in `crates/recognize-core/src/structure.rs`.
 */
const SEPARATORS: readonly SegmentSeparator[] = [null, "comma", "newline", "tab"]

/**
 * Folds the token classes into the class of the whole text, as `foldInputClass` does.
 */
function foldClass(counts: Uint32Array | number[]): CharacterClass {
	const [digit, alpha, mixed, , cjk, cyrillic, arabic] = counts as [
		number,
		number,
		number,
		number,
		number,
		number,
		number,
	]

	if (cjk && !alpha && !cyrillic && !arabic) return "cjk"

	if (cyrillic && !alpha && !cjk && !arabic) return "cyrillic"

	if (arabic && !alpha && !cjk && !cyrillic) return "arabic"

	if (cjk || cyrillic || arabic) return "mixed"

	if (mixed || (digit && alpha)) return "alphanumeric"

	if (digit && !alpha) return "numeric"

	if (alpha && !digit) return "alpha"

	return "mixed"
}

/**
 * Ranks the scripts by share, then by code, as `foldInputScripts` does.
 */
function rankScripts(words: Uint32Array): ScriptShare[] {
	let total = 0

	for (let code = 0; code < SCRIPT_CODES.length; code++) {
		total += words[3 + code]!
	}

	if (!total) return []

	const shares: ScriptShare[] = []

	for (let code = 0; code < SCRIPT_CODES.length; code++) {
		const count = words[3 + code]!

		if (count) {
			shares.push({ script: SCRIPT_CODES[code]!, share: count / total })
		}
	}

	return shares.toSorted((left, right) => right.share - left.share || left.script.localeCompare(right.script))
}

/**
 * What the reader needs of a known-formats family: its handle, what each of its
 * shapes means, and the PO box's name and confidence.
 *
 * `createRecognizer` builds it from the family's metadata when it binds the engine.
 */
export interface KnownFormatsBinding {
	readonly handle: number
	/**
	 * By the shape's position in the family's shape table: its format name, the number of tokens it
	 * covers and its confidence, or `null` for a shape that's no format, such as a PO box leader.
	 */
	readonly shapes: ReadonlyArray<{
		readonly format: string
		readonly tokens: 1 | 2
		readonly confidence: number
	} | null>
	readonly poBox: { readonly format: string; readonly confidence: number }
}

/**
 * Reads the known-format hits the engine appended after the region abbreviations.
 *
 * A token hit counts for a shape that covers one token and a pair hit for a shape
 * that covers two, and a hit of the other kind is dropped.
 */
function readKnownFormats(
	words: Uint32Array,
	start: number,
	text: string,
	convert: (byte: number) => number,
	binding: KnownFormatsBinding
): KnownFormatHit[] {
	const count = words[start]!
	const hits: KnownFormatHit[] = []
	let cursor = start + 1

	for (let index = 0; index < count; index++, cursor += KNOWN_FORMAT_WORDS) {
		const kind = words[cursor]!
		const from = convert(words[cursor + 2]!)
		const to = convert(words[cursor + 3]!)

		if (kind === HitKind.POBox) {
			hits.push({
				format: binding.poBox.format,
				span: { start: from, end: to, body: text.slice(from, to) },
				confidence: binding.poBox.confidence,
			})

			continue
		}

		const shape = binding.shapes[words[cursor + 1]!]

		if (!shape || shape.tokens !== (kind === HitKind.Token ? 1 : 2)) continue

		hits.push({
			format: shape.format,
			span: { start: from, end: to, body: text.slice(from, to) },
			confidence: shape.confidence,
		})
	}

	return hits
}

/**
 * Computes the structural fields of `text` with the family loaded under `handle`.
 *
 * It reuses the bytes a preceding call staged for the same text, and it overwrites
 * the recognition records, so the caller reads those first.
 */
export function structureFields(
	instance: Instance,
	text: string,
	handle: number,
	formats?: KnownFormatsBinding
): StructureFields & Partial<KnownFormatsFields> {
	try {
		const { exports } = instance
		const { pointer, written } = stageText(instance, text)
		const count = exports.rcg_structure(pointer, written, handle, formats ? formats.handle : NO_FAMILY)

		if (count < 0) {
			const length = exports.rcg_error_len()
			const message = new TextDecoder().decode(new Uint8Array(exports.memory.buffer, exports.rcg_error_ptr(), length))

			if (exports.rcg_error_code() === ErrorCode.InputTooLong) throw new RangeError(message)

			throw new RecognizeError(message)
		}

		const words = new Uint32Array(exports.memory.buffer, exports.rcg_result_ptr(), count)
		const tokenCount = words[0]!
		const segmentCount = words[1]!
		const regionCount = words[2]!
		const map = written === text.length ? null : offsetMap(text, written)
		const convert = map ? (byte: number): number => map.toUTF16(byte) : (byte: number): number => byte
		const tokenClasses: TokenClass[] = new Array(tokenCount)
		const classCounts = [0, 0, 0, 0, 0, 0, 0]
		let cursor = STRUCTURE_HEADER_WORDS

		for (let index = 0; index < tokenCount; index++, cursor += TOKEN_WORDS) {
			const start = convert(words[cursor]!)
			const end = convert(words[cursor + 1]!)
			const packed = words[cursor + 2]!
			const code = packed & 0xff

			classCounts[code]!++

			tokenClasses[index] = {
				span: { start, end, body: text.slice(start, end) },
				class: TOKEN_CLASSES[code]!,
				script: SCRIPT_CODES[packed >> 8]!,
			}
		}

		const segments: Segment[] = new Array(segmentCount)

		for (let index = 0; index < segmentCount; index++, cursor += SEGMENT_WORDS) {
			const start = convert(words[cursor]!)
			const end = convert(words[cursor + 1]!)
			const body = text.slice(start, end)

			segments[index] = { span: { start, end, body }, body, index, separator: SEPARATORS[words[cursor + 2]!]! }
		}

		const regionAbbreviations: RegionAbbreviation[] = new Array(regionCount)

		for (let index = 0; index < regionCount; index++, cursor++) {
			const { span } = tokenClasses[words[cursor]!]!

			regionAbbreviations[index] = { start: span.start, span: span.body }
		}

		const fields: StructureFields = {
			characterClass: tokenCount ? foldClass(classCounts) : "alpha",
			scripts: rankScripts(words),
			tokenClasses,
			segments,
			regionAbbreviations,
			totalLength: text.length,
		}

		if (!formats) return fields

		return { ...fields, knownFormats: readKnownFormats(words, cursor, text, convert, formats) }
	} catch (error) {
		throw trapped(error)
	}
}
