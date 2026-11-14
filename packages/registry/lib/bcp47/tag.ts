// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   BCP 47 language tags (RFC 5646): parsing, validation against the IANA Language
 *   Subtag Registry, and canonicalization.
 *
 *   A tag is accepted when it is well-formed (section 2.1) and valid (section 2.2.9):
 *   every language, extlang, script, region and variant subtag is registered, an extlang's
 *   prefix matches the language, and no variant or extension singleton repeats.
 *
 *   The canonical form (section 4.5) replaces a deprecated subtag or tag with its preferred value,
 *   replaces a language-extlang pair with the extlang's preferred value (`zh-yue` becomes `yue`),
 *   orders extensions by singleton, and applies the case conventions: `ja-Jpan-JP`.
 *   It keeps a script the language would suppress, so `ja-Jpan` stays `ja-Jpan`.
 */

import { extlangSubtagRows } from "#artifacts/bcp47/extlang"
import { languageSubtagRows } from "#artifacts/bcp47/language"
import { regionSubtagRows } from "#artifacts/bcp47/region"
import { scriptSubtagRows } from "#artifacts/bcp47/script"
import { tagSubtagRows } from "#artifacts/bcp47/tag"
import { variantSubtagRows } from "#artifacts/bcp47/variant"
import { lazySubtagIndex } from "#bcp47/subtag-index"
import { type Parsed, ParseFailure } from "#errors"
import { type BCP47, SubtagType } from "#types"

const languages = lazySubtagIndex(languageSubtagRows)
const extlangs = lazySubtagIndex(extlangSubtagRows)
const scripts = lazySubtagIndex(scriptSubtagRows)
const regions = lazySubtagIndex(regionSubtagRows)
const variants = lazySubtagIndex(variantSubtagRows)
const wholeTags = lazySubtagIndex(tagSubtagRows)

/**
 * A parsed tag in canonical form.
 */
export interface LanguageTag {
	tag: BCP47.LanguageTag
	/**
	 * The primary language subtag, such as `ja`.
	 *
	 * An irregular grandfathered tag without a preferred value, such as `i-default`,
	 * holds the whole tag here.
	 * A private-use tag such as `x-whatever` holds an empty string.
	 */
	language: string
	script: string | null
	region: string | null
	variants: readonly string[]
	/**
	 * Each extension with its singleton, such as `u-ca-gregory`, ordered by singleton.
	 */
	extensions: readonly string[]
	/**
	 * The private-use sequence with its `x-` prefix, or `null`.
	 */
	privateUse: string | null
}

// The subtag grammars of RFC 5646, section 2.1, over a lowercased tag.
const SUBTAG = /^[a-z0-9]{1,8}$/
const LANGUAGE = /^(?:[a-z]{2,3}|[a-z]{5,8})$/
const SHORT_LANGUAGE = /^[a-z]{2,3}$/
const EXTLANG = /^[a-z]{3}$/
const SCRIPT = /^[a-z]{4}$/
const REGION = /^(?:[a-z]{2}|[0-9]{3})$/
const VARIANT = /^(?:[a-z0-9]{5,8}|[0-9][a-z0-9]{3})$/
const SINGLETON = /^[0-9a-z]$/
const EXTENSION_BODY = /^[a-z0-9]{2,8}$/

/**
 * The grammar admits up to three extlang subtags after a two- or three-letter language.
 */
const MAX_EXTLANGS = 3

function refuse(input: string, reason: ParseFailure, part?: string): Parsed<LanguageTag> {
	return part ? { ok: false, reason, input, part } : { ok: false, reason, input }
}

function titleCase(subtag: string): string {
	return subtag.charAt(0).toUpperCase() + subtag.slice(1)
}

function compose(parts: Omit<LanguageTag, "tag">): BCP47.LanguageTag {
	return [parts.language, parts.script, parts.region, ...parts.variants, ...parts.extensions, parts.privateUse]
		.filter((part): part is string => typeof part === "string" && part !== "")
		.join("-") as BCP47.LanguageTag
}

/**
 * Parses, validates and canonicalizes a BCP 47 tag in any case.
 *
 * A refusal reports `shape` for an ill-formed tag and `not-found-in-snapshot` for a well-formed
 * tag with an unregistered or misplaced subtag, with the offending subtag as `part`.
 */
export function parseLanguageTag(input: string): Parsed<LanguageTag> {
	const lower = input.toLowerCase()
	const whole = wholeTags().get(lower)

	if (whole?.type === SubtagType.Grandfathered) {
		if (whole.preferredValue) return parseLanguageTag(whole.preferredValue)

		return {
			ok: true,
			value: {
				tag: whole.subtag as BCP47.LanguageTag,
				language: whole.subtag,
				script: null,
				region: null,
				variants: [],
				extensions: [],
				privateUse: null,
			},
		}
	}

	if (whole?.type === SubtagType.Redundant && whole.preferredValue) return parseLanguageTag(whole.preferredValue)

	const subtags = lower.split("-")

	if (subtags.some((subtag) => !SUBTAG.test(subtag))) return refuse(input, ParseFailure.Shape)

	let position = 0
	const at = (): string | undefined => subtags[position]
	const matches = (grammar: RegExp): boolean => grammar.test(at() ?? "")

	if (at() === "x") {
		if (!subtags[1]) return refuse(input, ParseFailure.Shape)

		const privateUse = subtags.join("-")

		return {
			ok: true,
			value: {
				tag: privateUse as BCP47.LanguageTag,
				language: "",
				script: null,
				region: null,
				variants: [],
				extensions: [],
				privateUse,
			},
		}
	}

	let language = at()

	if (!language || !LANGUAGE.test(language)) return refuse(input, ParseFailure.Shape)

	const languageRow = languages().get(language)

	if (!languageRow) return refuse(input, ParseFailure.NotFound, language)

	language = languageRow.preferredValue ?? language

	position++

	// One extlang is valid.
	// The grammar admits three, so a second is well-formed and refused as invalid.
	const extlangsSeen: string[] = []

	while (SHORT_LANGUAGE.test(subtags[0]!) && matches(EXTLANG)) {
		extlangsSeen.push(at()!)

		position++
	}

	if (extlangsSeen.length > MAX_EXTLANGS) return refuse(input, ParseFailure.Shape)

	if (extlangsSeen.length > 1) return refuse(input, ParseFailure.NotFound, extlangsSeen[1])

	const extlang = extlangsSeen[0]

	if (extlang) {
		const extlangRow = extlangs().get(extlang)

		if (!extlangRow || extlangRow.prefixes?.[0] !== subtags[0]) return refuse(input, ParseFailure.NotFound, extlang)

		language = extlangRow.preferredValue ?? extlang
	}

	let script: string | null = null

	if (matches(SCRIPT)) {
		const row = scripts().get(at()!)

		if (!row) return refuse(input, ParseFailure.NotFound, at())

		script = titleCase(row.preferredValue ?? at()!)

		position++
	}

	let region: string | null = null

	if (matches(REGION)) {
		const row = regions().get(at()!)

		if (!row) return refuse(input, ParseFailure.NotFound, at())

		region = (row.preferredValue ?? at()!).toUpperCase()

		position++
	}

	const variantsSeen: string[] = []

	while (at()) {
		const subtag = at()!

		if (!VARIANT.test(subtag)) break

		const row = variants().get(subtag)

		if (!row) return refuse(input, ParseFailure.NotFound, subtag)

		const canonical = row.preferredValue ?? subtag

		if (variantsSeen.includes(canonical)) return refuse(input, ParseFailure.NotFound, subtag)

		variantsSeen.push(canonical)

		position++
	}

	const extensions: string[] = []
	const singletons = new Set<string>()
	let privateUse: string | null = null

	while (at()) {
		const singleton = at()!

		if (!SINGLETON.test(singleton)) return refuse(input, ParseFailure.Shape, singleton)

		position++

		const body: string[] = []

		if (singleton === "x") {
			while (at()) {
				body.push(at()!)

				position++
			}

			if (!body.length) return refuse(input, ParseFailure.Shape, singleton)

			privateUse = ["x", ...body].join("-")

			break
		}

		while (matches(EXTENSION_BODY)) {
			body.push(at()!)

			position++
		}

		if (!body.length) return refuse(input, ParseFailure.Shape, singleton)

		if (singletons.has(singleton)) return refuse(input, ParseFailure.NotFound, singleton)

		singletons.add(singleton)
		extensions.push([singleton, ...body].join("-"))
	}

	extensions.sort()

	const parts = { language, script, region, variants: variantsSeen, extensions, privateUse }

	return { ok: true, value: { tag: compose(parts), ...parts } }
}

/**
 * Whether `input` is a valid tag already in canonical form.
 */
export function isLanguageTag(input: string): input is BCP47.LanguageTag {
	const parsed = parseLanguageTag(input)

	return parsed.ok && parsed.value.tag === input
}

/**
 * The script a tag's text is written in: its explicit script subtag,
 * else its language's suppressed script, else `null`.
 *
 * `ja-Jpan` and `ja` both give `Jpan`; `zh` gives `null`, because Chinese is written
 * in `Hans` or `Hant` and the registry suppresses neither.
 */
export function impliedScript(tag: LanguageTag): BCP47.ScriptCode | null {
	if (tag.script) return tag.script as BCP47.ScriptCode

	const suppressed = languages().get(tag.language)?.suppressScript

	return suppressed ? (suppressed as BCP47.ScriptCode) : null
}
