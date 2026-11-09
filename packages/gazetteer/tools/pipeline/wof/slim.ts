/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Per-record transforms that shrink a Who's On First repository and keep every property of a record.
 *
 *   A WOF record stores its geometry on one line. An older exporter printed some coordinates with more digits than
 *   the value needs: `-90.18399100000001` parses to the same number as `-90.183991`. Some sources wrote 13 or 14
 *   decimal places. {@link roundRecordGeometry} rounds the geometry to six places. A coordinate moves by at most
 *   0.0000005 degrees (0.056 m north–south). It rewrites only the geometry line and the `wof:geomhash` value.
 */

import { md5Hex } from "@mailwoman/core/hash"
import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/json"
import { roundGeometryCoordinates } from "@mailwoman/spatial/geometries/round"
import { TextSpliterator } from "spliterator"

import { placetypeFromHierarchyKey } from "#whosonfirst/hierarchy"

/**
 * Decimal places a rounded coordinate keeps: about 0.11 m at the equator,
 * and the precision most WOF sources publish.
 */
export const DEFAULT_COORDINATE_DECIMALS = 6

/**
 * Why a record was left as it is.
 */
export const SlimSkip = {
	/**
	 * The record has a successor.
	 *
	 * The slimming step that removes superseded records deletes it instead.
	 */
	Superseded: "superseded",
	/**
	 * The record has no geometry member.
	 */
	NoGeometry: "no-geometry",
	/**
	 * The geometry spans more than one line, so a one-line rewrite would change the file's layout.
	 */
	MultiLineGeometry: "multi-line-geometry",
	/**
	 * A rounded ring would hold two equal neighboring vertices.
	 * The ring then has one vertex fewer than the source.
	 */
	CollapsedVertex: "collapsed-vertex",
} as const

export type SlimSkip = (typeof SlimSkip)[keyof typeof SlimSkip]

/**
 * What {@link roundRecordGeometry} decided for one record.
 */
export type GeometryRounding =
	| { kind: "unchanged" }
	| { kind: "rounded"; text: string; coordinates: number }
	| { kind: "skipped"; reason: SlimSkip }

interface WOFRecordShape {
	properties?: Record<string, unknown>
	geometry?: { type?: string; coordinates?: unknown }
}

/**
 * Whether a parsed record lists a successor in `wof:superseded_by`.
 *
 * This is the rule the admin ingest uses to drop a record.
 */
export function isSupersededRecord(record: WOFRecordShape): boolean {
	const successors = record.properties?.["wof:superseded_by"]

	return Array.isArray(successors) && successors.length > 0
}

/**
 * Whether a parsed record is deprecated and lists no successor.
 *
 * A deprecated record's `edtf:deprecated` holds a date.
 * The values `""` and `"uuuu"` mean the record is not deprecated.
 */
export function isDeprecatedWithoutSuccessor(record: WOFRecordShape): boolean {
	const deprecated = record.properties?.["edtf:deprecated"]

	return typeof deprecated === "string" && /^\d/.test(deprecated) && !isSupersededRecord(record)
}

/**
 * The `wof:geomhash` of a geometry: the MD5 of its compact JSON with `coordinates`
 * before `type`, the form the current WOF exporter writes.
 */
export function wofGeometryHash(geometry: { type?: string; coordinates?: unknown }): string {
	return md5Hex(stringifyJSON({ coordinates: geometry.coordinates, type: geometry.type }))
}

/**
 * The end index, exclusive, of the JSON object that starts at `start`.
 *
 * A geometry holds numbers, arrays and the `type` string, so braces inside strings do not occur.
 */
function objectEnd(text: string, start: number): number {
	let depth = 0

	for (let i = start; i < text.length; i++) {
		const char = text[i]

		if (char === "{") {
			depth++
		} else if (char === "}" && --depth === 0) return i + 1
	}

	return -1
}

/**
 * Round a WOF record's geometry to `decimals` places.
 *
 * Only the geometry's line and the `wof:geomhash` value change.
 * The geometry keeps its key order, and every property keeps its bytes.
 */
export function roundRecordGeometry(text: string, decimals = DEFAULT_COORDINATE_DECIMALS): GeometryRounding {
	const record = parseJSONStrict<WOFRecordShape>(text)

	if (isSupersededRecord(record)) return { kind: "skipped", reason: SlimSkip.Superseded }

	// The member is indented in the WOF layout.
	// The match keeps the indent, so the rewrite preserves it.
	const member = /^[ \t]*"geometry":[ \t]*/m.exec(text)

	if (!member || !record.geometry) return { kind: "skipped", reason: SlimSkip.NoGeometry }

	const start = member.index + member[0].length
	const end = objectEnd(text, start)

	if (end < 0 || text.slice(start, end).includes("\n")) {
		return { kind: "skipped", reason: SlimSkip.MultiLineGeometry }
	}

	const original = text.slice(start, end)
	const geometry = parseJSONStrict<Record<string, unknown>>(original)
	const { coordinates, collapsed } = roundGeometryCoordinates(geometry["coordinates"], decimals)
	const rounded = { ...geometry, coordinates }

	if (collapsed) return { kind: "skipped", reason: SlimSkip.CollapsedVertex }

	// A key overridden in a spread keeps its position, so `coordinates` stays where the file had it.
	const geometryText: string = stringifyJSON(rounded)

	if (geometryText === original) return { kind: "unchanged" }

	// The change is counted on the text.
	// An older exporter printed some values with more digits than they need, such as `-90.18399100000001`,
	// which parses to the same number as `-90.183991` and is rewritten in the short form.
	const before = original.match(NUMBER_TOKEN) ?? []
	const after = geometryText.match(NUMBER_TOKEN) ?? []

	if (before.length !== after.length) {
		throw new Error(`rounding changed the geometry's number count from ${before.length} to ${after.length}`)
	}

	const changed = before.filter((token, index) => token !== after[index]).length
	const hash = wofGeometryHash(rounded as { type?: string; coordinates?: unknown })

	// The current layout puts properties before the geometry, and older files put them
	// after it, so both sides are searched.
	const rehash = (part: string): string =>
		part.replace(/("wof:geomhash":\s*")[0-9a-f]{32}(")/, (_, open: string, close: string) => `${open}${hash}${close}`)

	return {
		kind: "rounded",
		text: `${rehash(text.slice(0, member.index))}${member[0]}${geometryText}${rehash(text.slice(end))}`,
		coordinates: changed,
	}
}

/**
 * One JSON number token.
 */
const NUMBER_TOKEN = /-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g

/**
 * The record that replaced a removed one: its ID and its placetype.
 */
export interface RecordSuccessor {
	readonly id: number
	readonly placetype: string
}

/**
 * What {@link repointRecordReferences} did to one record.
 *
 * `references` counts the values it replaced, and `kept` counts the hierarchy values it left
 * because the successor's placetype differs from the key's.
 */
export type ReferenceRepointing =
	| { kind: "unchanged"; kept: number }
	| { kind: "repointed"; text: string; references: number; kept: number }

/**
 * The `"wof:parent_id"` line, with the indent, the ID and the comma captured.
 */
const PARENT_LINE = /^([ \t]*"wof:parent_id":[ \t]*)(\d+)(,?)$/m

/**
 * A block-valued member printed one element per line: the opening line, the body
 * and the closing bracket at the opening line's indent.
 */
function memberBlock(text: string, key: string): { start: number; end: number; indent: string; body: string } | null {
	const open = new RegExp(`^([ \\t]*)"${key}":\\[\\n`, "m").exec(text)

	if (!open) return null

	const indent = open[1]!
	const bodyStart = open.index + open[0].length
	const close = text.indexOf(`\n${indent}]`, bodyStart)

	if (close === -1) return null

	return { start: bodyStart, end: close, indent, body: text.slice(bodyStart, close) }
}

/**
 * Replaces each removed ID a record refers to with its successor, in `wof:parent_id`,
 * `wof:hierarchy` and `wof:belongsto`, rewriting only those lines.
 *
 * `successorOf` answers the one successor of a removed ID, or `null` for an ID to leave as it is.
 * A `wof:hierarchy` value is replaced only by a successor of the placetype its
 * key gives, so a `region_id` stays a region.
 *
 * `wof:parent_id` takes the successor whatever its placetype.
 * When `wof:belongsto` already lists the successor, the removed ID's entry is dropped there.
 *
 * A removed ID whose successor is the record itself, such as a merged commune the new
 * commune supersedes, is never written as the record's own parent or ancestor.
 * Its parent and hierarchy values are kept and counted, and its `wof:belongsto` entry is dropped.
 */
export function repointRecordReferences(
	text: string,
	successorOf: (id: number) => RecordSuccessor | null
): ReferenceRepointing {
	let out = text
	let references = 0
	let kept = 0

	const ownID = Number(/^[ \t]*"wof:id":[ \t]*(\d+)/m.exec(text)?.[1])
	const isSelf = (successor: RecordSuccessor | null) => successor?.id === ownID

	const parent = PARENT_LINE.exec(out)
	const parentSuccessor = parent ? successorOf(Number(parent[2])) : null

	if (isSelf(parentSuccessor)) {
		kept++
	} else if (parent && parentSuccessor) {
		out = `${out.slice(0, parent.index)}${parent[1]}${parentSuccessor.id}${parent[3]}${out.slice(parent.index + parent[0].length)}`

		references++
	}

	const hierarchy = memberBlock(out, "wof:hierarchy")

	if (hierarchy) {
		const body = hierarchy.body.replaceAll(
			/^([ \t]*"([a-z_]+)":[ \t]*)(\d+)(,?)$/gm,
			(line, prefix: string, key: string, value: string, comma: string) => {
				const successor = successorOf(Number(value))

				if (!successor) return line

				if (isSelf(successor) || placetypeFromHierarchyKey(key) !== successor.placetype) {
					kept++

					return line
				}

				references++

				return `${prefix}${successor.id}${comma}`
			}
		)

		out = `${out.slice(0, hierarchy.start)}${body}${out.slice(hierarchy.end)}`
	}

	const belongsTo = memberBlock(out, "wof:belongsto")

	if (belongsTo) {
		// Untrimmed, so the first line keeps the indent each rewritten line takes.
		const lines = TextSpliterator.from(belongsTo.body, { trim: false }).toArray()
		const itemIndent = /^[ \t]*/.exec(lines[0] ?? "")?.[0] ?? ""
		const ids = lines.map((line) => Number(line.trim().replace(/,$/, "")))

		if (ids.every((id) => Number.isInteger(id))) {
			const seen = new Set<number>()
			const next: number[] = []
			let changed = false

			for (const id of ids) {
				const successor = successorOf(id)
				const value = successor ? successor.id : id

				if (successor) {
					changed = true

					references++
				}

				if (seen.has(value) || value === ownID) continue

				seen.add(value)
				next.push(value)
			}

			if (changed) {
				const body = next.map((id, index) => `${itemIndent}${id}${index < next.length - 1 ? "," : ""}`).join("\n")

				out = `${out.slice(0, belongsTo.start)}${body}${out.slice(belongsTo.end)}`
			}
		}
	}

	return references ? { kind: "repointed", text: out, references, kept } : { kind: "unchanged", kept }
}
