// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Reads the IANA Language Subtag Registry into normalized subtag records.
 *
 *   The registry is a record-jar file (RFC 5646, section 3.1): records separated by `%%` lines, one
 *   `Field-Name: body` per line, and a line that starts with whitespace continuing the field before it.
 *   A field such as `Description` or `Prefix` may repeat.
 *
 *   The registry covers every BCP 47 subtag type, so this one source feeds ISO 639
 *   language subtags, ISO 15924 scripts, ISO 3166-1 and UN M49 region subtags,
 *   variants, and the grandfathered and redundant whole tags.
 */

import { stringifyJSON } from "@mailwoman/core/json"

import { type SubtagRow, SubtagType } from "#types"

/**
 * The subtag types in the order the normalized file sorts them.
 */
export const SUBTAG_TYPES: readonly SubtagType[] = Object.values(SubtagType)

/**
 * One registry record: a table row plus the date the registry added it.
 */
export interface SubtagRecord extends SubtagRow {
	type: SubtagType
	added: string
}

export interface NormalizedSubtags {
	profile: string
	source: string
	normalizationVersion: number
	/**
	 * The registry's own `File-Date`.
	 */
	fileDate: string
	records: SubtagRecord[]
}

/**
 * The version of the rules below.
 * A change that moves a record's bytes moves this number.
 */
export const SUBTAG_NORMALIZATION_VERSION = 1

function isSubtagType(value: string): value is SubtagType {
	return (SUBTAG_TYPES as readonly string[]).includes(value)
}

/**
 * Splits the registry text into records of field lists, joining continuation lines.
 */
export function readRecordJar(text: string): Array<Array<[string, string]>> {
	const records: Array<Array<[string, string]>> = []
	let current: Array<[string, string]> = []

	// oxlint-disable-next-line mailwoman/prefer-spliterator -- one 732 KB registry file, read whole and bounded
	for (const line of text.split("\n")) {
		if (line === "%%") {
			records.push(current)
			current = []

			continue
		}

		if (/^\s/.test(line)) {
			const last = current.at(-1)

			if (!last) throw new Error(`continuation line before any field: ${stringifyJSON(line)}`)

			last[1] = `${last[1]} ${line.trim()}`

			continue
		}

		if (line.trim() === "") continue

		const colon = line.indexOf(":")

		if (colon < 1) throw new Error(`registry line without a field name: ${stringifyJSON(line)}`)

		current.push([line.slice(0, colon), line.slice(colon + 1).trim()])
	}

	records.push(current)

	return records
}

/**
 * Normalizes the registry into records sorted by type, then subtag.
 *
 * A field this reader doesn't know is an error naming the record, because a dropped
 * field would change what the registry answers without anyone deciding it.
 */
export function normalizeSubtags(text: string, profile: string, source: string): NormalizedSubtags {
	const [header, ...entries] = readRecordJar(text)
	const fileDate = header?.find(([name]) => name === "File-Date")?.[1]

	if (!fileDate) throw new Error("the registry's first record holds no File-Date")

	const records = entries.map((fields): SubtagRecord => {
		const one = (name: string): string | undefined => fields.find(([field]) => field === name)?.[1]
		const many = (name: string): string[] => fields.filter(([field]) => field === name).map(([, body]) => body)
		const type = one("Type")
		const subtag = one("Subtag") ?? one("Tag")

		if (!type || !isSubtagType(type) || !subtag) {
			throw new Error(`registry record without a known Type and Subtag or Tag: ${stringifyJSON(fields)}`)
		}

		for (const [name] of fields) {
			if (!KNOWN_FIELDS.has(name)) throw new Error(`${subtag}: unknown registry field ${name}`)
		}

		const prefixes = many("Prefix")

		// An absent optional field stays absent rather than holding an empty value, so each row's JSON stays short.
		return {
			type,
			subtag,
			descriptions: many("Description"),
			added: one("Added") ?? "",
			...optional("deprecated", one("Deprecated")),
			...optional("preferredValue", one("Preferred-Value")),
			...optional("suppressScript", one("Suppress-Script")),
			...optional("macrolanguage", one("Macrolanguage")),
			...optional("scope", one("Scope")),
			...(prefixes.length ? { prefixes } : {}),
		}
	})

	const order = (type: SubtagType): number => SUBTAG_TYPES.indexOf(type)

	records.sort((left, right) => order(left.type) - order(right.type) || compareCodeUnits(left.subtag, right.subtag))

	return { profile, source, normalizationVersion: SUBTAG_NORMALIZATION_VERSION, fileDate, records }
}

const KNOWN_FIELDS = new Set([
	"Type",
	"Subtag",
	"Tag",
	"Description",
	"Added",
	"Deprecated",
	"Preferred-Value",
	"Suppress-Script",
	"Macrolanguage",
	"Scope",
	"Prefix",
	// Comments are the registry's prose for human readers, and no lookup answers from them.
	"Comments",
])

function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
	return value ? ({ [key]: value } as Partial<Record<K, string>>) : {}
}

function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0
}

/**
 * The table modules the generator writes under `lib/artifacts/bcp47/`, each holding the subtag types listed.
 *
 * Each subtag type gets its own module, so a bundle that validates scripts holds
 * the 225 script rows and none of the 8,276 language rows.
 */
export const SUBTAG_TABLES = {
	language: ["language"],
	extlang: ["extlang"],
	script: ["script"],
	region: ["region"],
	variant: ["variant"],
	grandfathered: ["grandfathered"],
	redundant: ["redundant"],
} as const satisfies Record<string, readonly SubtagType[]>

export type SubtagTable = keyof typeof SUBTAG_TABLES

/**
 * The rows of one table, in the normalized order.
 */
export function subtagTableRows(collection: NormalizedSubtags, table: SubtagTable): SubtagRow[] {
	const types = new Set<SubtagType>(SUBTAG_TABLES[table])

	return collection.records
		.filter((record) => types.has(record.type))
		.map(({ added: _added, type: _type, ...row }) => row)
}
