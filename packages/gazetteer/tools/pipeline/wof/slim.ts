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
 * What a record's reference to a removed ID becomes.
 *
 * `replace` names the one successor and its placetype.
 * `remove` drops the reference, for an ID with no successor or none the caller can choose.
 */
export type ReferenceResolution = { kind: "replace"; id: number; placetype: string } | { kind: "remove" }

/**
 * What {@link repointRecordReferences} did to one record.
 *
 * `replaced` counts the references it pointed at a successor, `moved` counts the hierarchy values
 * it moved to the successor's placetype key, and `removed` counts the references it dropped.
 */
export type ReferenceRepointing =
	| { kind: "unchanged" }
	| { kind: "repointed"; text: string; replaced: number; moved: number; removed: number }

/**
 * The `wof:parent_id` WOF writes for a record whose parent is unknown.
 */
const UNKNOWN_PARENT = -1

/**
 * The indent one nesting level adds in the WOF exporter's layout.
 */
const LEVEL_INDENT = "    "

/**
 * The `"wof:parent_id"` line, with the indent, the ID and the comma captured.
 */
const PARENT_LINE = /^([ \t]*"wof:parent_id":[ \t]*)(-?\d+)(,?)$/m

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
 * Renders `wof:hierarchy` branches in the WOF exporter's layout: one branch object
 * per block, one key per line, keys in sorted order.
 */
function printHierarchyBranches(branches: ReadonlyArray<Record<string, number>>, indent: string): string {
	const branchIndent = `${indent}${LEVEL_INDENT}`
	const keyIndent = `${branchIndent}${LEVEL_INDENT}`

	return branches
		.map((branch) => {
			const keys = Object.keys(branch).toSorted()

			if (!keys.length) return `${branchIndent}{}`

			const lines = keys.map((key, index) => `${keyIndent}"${key}":${branch[key]}${index < keys.length - 1 ? "," : ""}`)

			return `${branchIndent}{\n${lines.join("\n")}\n${branchIndent}}`
		})
		.join(",\n")
}

/**
 * Points each reference a record makes to a removed ID at what `resolve` answers for it,
 * in `wof:parent_id`, `wof:hierarchy` and `wof:belongsto`, and changes no other member.
 *
 * `resolve` answers `null` for an ID to leave as it is.
 * A replacement whose successor is the record itself, such as the new commune a merged
 * commune became, is removed, because a record is never its own parent or ancestor.
 *
 * `wof:parent_id` takes a replacement whatever its placetype, and becomes `-1`,
 * WOF's unknown parent, on removal.
 * A `wof:hierarchy` value moves to the key of the successor's placetype,
 * so a county superseded by a region becomes a `region_id`.
 *
 * When the branch already holds that key, the branch's value stands and the old key is dropped.
 * `wof:belongsto` lists each ancestor once.
 */
export function repointRecordReferences(
	text: string,
	resolve: (id: number) => ReferenceResolution | null
): ReferenceRepointing {
	let out = text
	let replaced = 0
	let moved = 0
	let removed = 0

	const ownID = Number(/^[ \t]*"wof:id":[ \t]*(\d+)/m.exec(text)?.[1])

	const resolveFor = (id: number): ReferenceResolution | null => {
		const resolution = resolve(id)

		return resolution?.kind === "replace" && resolution.id === ownID ? { kind: "remove" } : resolution
	}

	const parent = PARENT_LINE.exec(out)
	const parentResolution = parent ? resolveFor(Number(parent[2])) : null

	if (parent && parentResolution) {
		const value = parentResolution.kind === "replace" ? parentResolution.id : UNKNOWN_PARENT

		out = `${out.slice(0, parent.index)}${parent[1]}${value}${parent[3]}${out.slice(parent.index + parent[0].length)}`

		if (parentResolution.kind === "replace") {
			replaced++
		} else {
			removed++
		}
	}

	const hierarchy = memberBlock(out, "wof:hierarchy")

	if (hierarchy) {
		const branches = parseJSONStrict<Array<Record<string, number>>>(`[${hierarchy.body}]`)
		let changed = false

		const next = branches.map((branch) => {
			const result: Record<string, number> = {}

			for (const [key, value] of Object.entries(branch)) {
				const resolution = typeof value === "number" ? resolveFor(value) : null

				if (!resolution) {
					result[key] = value

					continue
				}

				changed = true

				if (resolution.kind === "remove") {
					removed++

					continue
				}

				const target = `${resolution.placetype}_id`

				if (target === key) {
					result[key] = resolution.id

					replaced++
				} else if (target in branch) {
					// The branch already states this level, so its own value is kept.
					removed++
				} else {
					result[target] = resolution.id

					moved++
				}
			}

			return result
		})

		if (changed) {
			out = `${out.slice(0, hierarchy.start)}${printHierarchyBranches(next, hierarchy.indent)}${out.slice(hierarchy.end)}`
		}
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
				const resolution = resolveFor(id)

				if (resolution) {
					changed = true
				}

				if (resolution?.kind === "remove") {
					removed++

					continue
				}

				if (resolution) {
					replaced++
				}

				const value = resolution ? resolution.id : id

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

	return replaced + moved + removed ? { kind: "repointed", text: out, replaced, moved, removed } : { kind: "unchanged" }
}
