/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Checks the Who's On First clones for records the forks remove and for references the remaining records cannot
 *   resolve.
 *
 *   The forks remove superseded records and deprecated records without a successor. Each removed ID has a file in
 *   `whosonfirst-data-deprecated` that lists its successors, one per line, or is empty. Upstream keeps every
 *   record, so a merge can bring a retired record back, and a kept record can still name a removed record as its
 *   parent or in its hierarchy. This module reads every record's properties once and reports both.
 *
 *   A WOF record stores its properties before its geometry, and the geometry is most of the file's bytes. The
 *   reader stops at the top-level `"geometry"` key and parses the record without it. A record laid out in some
 *   other order is parsed whole, and the report counts those records.
 */

import { readFileRange, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { streamTrackedFiles } from "@mailwoman/core/git"
import { parseJSONStrict } from "@mailwoman/core/json"
import type { PathBuilderLike } from "path-ts"
import { parallelMap, TextSpliterator } from "spliterator"

import { isDeprecatedWithoutSuccessor, isSupersededRecord } from "#tools/pipeline/wof/slim"
import { hierarchyAncestorsInAnyBranch } from "#whosonfirst/hierarchy"

/**
 * The bytes the reader asks for at a time while it looks for the geometry.
 */
const READ_CHUNK_BYTES = 64 * 1024

/**
 * The text that opens a record's top-level geometry member in the WOF exporter's layout.
 */
const GEOMETRY_MARKER = '\n  "geometry"'

/**
 * The most referring records the report keeps for each dangling ID,
 * enough to open one and see the reference.
 */
const REFERRER_SAMPLE_LIMIT = 3

/**
 * The most examples each finding keeps for the report.
 */
const SAMPLE_LIMIT = 20

/**
 * The references a record makes and the facts that retire it.
 */
export interface RecordReferences {
	id: number
	/**
	 * Each referenced ID with where it was read: `parent` for `wof:parent_id`,
	 * or the placetype of the `wof:hierarchy` key that holds it, such as `region`.
	 */
	references: Array<{ key: string; id: number }>
	superseded: boolean
	deprecated: boolean
}

/**
 * The references and retirement facts of one record's properties, or `null`
 * when the properties hold no numeric `wof:id`.
 *
 * IDs at or below zero are WOF's placeholders for an unknown or ambiguous parent, so they are left out.
 */
export function recordReferences(properties: Record<string, unknown>): RecordReferences | null {
	const id = properties["wof:id"]

	if (typeof id !== "number") return null

	const references: Array<{ key: string; id: number }> = []
	const parent = properties["wof:parent_id"]

	if (typeof parent === "number" && parent > 0 && parent !== id) {
		references.push({ key: "parent", id: parent })
	}

	for (const [ancestor, placetype] of hierarchyAncestorsInAnyBranch(id, properties["wof:hierarchy"])) {
		references.push({ key: placetype, id: ancestor })
	}

	const record = { properties }

	return {
		id,
		references,
		superseded: isSupersededRecord(record),
		deprecated: isDeprecatedWithoutSuccessor(record),
	}
}

/**
 * A record's properties, read up to the geometry when the file follows the WOF exporter's layout.
 *
 * `wholeFile` reports a record that had to be parsed whole.
 *
 * @throws When the file cannot be read or does not parse as a GeoJSON feature with properties.
 */
export async function readRecordProperties(
	path: PathBuilderLike
): Promise<{ properties: Record<string, unknown>; wholeFile: boolean }> {
	let bytes: Buffer = Buffer.alloc(0)

	for (;;) {
		const chunk = await readFileRange(path, bytes.length, READ_CHUNK_BYTES)

		// A UTF-8 sequence can straddle two chunks, so the text is decoded from all the bytes read so far.
		bytes = bytes.length ? Buffer.concat([bytes, chunk]) : chunk

		const head = bytes.toString("utf8")
		const marker = head.indexOf(GEOMETRY_MARKER)

		if (marker !== -1) {
			const withoutGeometry = `${head.slice(0, marker).replace(/,\s*$/, "")}\n}`

			try {
				const feature = parseJSONStrict<{ properties?: Record<string, unknown> }>(withoutGeometry)

				if (feature.properties) return { properties: feature.properties, wholeFile: false }
			} catch {
				// The text before the marker is not a feature without its geometry, so the file is parsed whole.
			}

			break
		}

		if (chunk.length < READ_CHUNK_BYTES) break
	}

	const feature = parseJSONStrict<{ properties?: Record<string, unknown> }>(await readLocalTextFile(path))

	if (!feature.properties) throw new Error("the feature has no properties")

	return { properties: feature.properties, wholeFile: true }
}

/**
 * One clone to scan: its directory name and its path.
 */
export interface DoctorClone {
	repo: string
	directory: PathBuilderLike
}

/**
 * What {@linkcode diagnoseClones} found.
 */
export interface WOFDoctorReport {
	clones: number
	records: number
	/**
	 * Records the reader parsed whole because their layout put the geometry elsewhere.
	 */
	wholeFileParses: number
	unreadable: { count: number; sample: Array<{ repo: string; path: string; error: string }> }
	retired: {
		superseded: number
		deprecated: number
		byRepo: Record<string, { superseded: number; deprecated: number }>
		sample: Array<{ repo: string; id: number; kind: "superseded" | "deprecated" }>
	}
	dangling: {
		/**
		 * Distinct IDs that some record refers to and no clone holds.
		 */
		ids: number
		/**
		 * Record references to those IDs.
		 */
		references: number
		/**
		 * Distinct dangling IDs that `whosonfirst-data-deprecated` lists.
		 */
		listed: number
		/**
		 * Listed dangling IDs whose every final successor is a record a clone holds.
		 */
		resolvable: number
		byKey: Record<string, number>
		sample: Array<{
			id: number
			keys: string[]
			referencedBy: number[]
			references: number
			successors: number[] | null
		}>
	}
	mapping: {
		/**
		 * Whether the deprecated repository was read.
		 */
		read: boolean
		entries: number
		/**
		 * Listed IDs whose chain of successors ends at an ID no clone holds.
		 */
		successorMissing: number
		sample: Array<{ id: number; successors: number[] }>
	}
}

interface DanglingCandidate {
	references: number
	keys: Set<string>
	referencedBy: number[]
}

/**
 * The repository-relative path of each record file a clone tracks, leaving out alternate geometries.
 */
export async function* trackedRecordPaths(directory: PathBuilderLike): AsyncGenerator<string> {
	for await (const path of streamTrackedFiles(directory, ["data"])) {
		if (path.endsWith(".geojson") && !path.includes("-alt-")) {
			yield path
		}
	}
}

/**
 * The final IDs reached by following `id`'s successors through `mapping` until an ID has no entry.
 *
 * An empty result means the chain ends at a deprecated ID with no successor.
 * A cycle stops at the IDs already visited.
 */
export function finalSuccessors(id: number, mapping: ReadonlyMap<number, readonly number[]>): number[] {
	const finals = new Set<number>()
	const visited = new Set<number>([id])
	const queue = [...(mapping.get(id) ?? [])]

	while (queue.length) {
		const next = queue.shift()!

		if (visited.has(next)) continue

		visited.add(next)

		const successors = mapping.get(next)

		if (successors) {
			queue.push(...successors)
		} else {
			finals.add(next)
		}
	}

	return [...finals]
}

/**
 * Reads every record the clones track and reports retired records still present,
 * references to IDs no clone holds, and listed successors no clone holds.
 *
 * `mapping` is the content of `whosonfirst-data-deprecated`, or `null` when it could not be read.
 * With `null`, the report's `mapping.read` is false and every dangling ID's `successors` is `null`.
 */
export async function diagnoseClones(
	clones: readonly DoctorClone[],
	mapping: ReadonlyMap<number, readonly number[]> | null,
	opts: {
		concurrency?: number
		listRecords?: (directory: PathBuilderLike) => Iterable<string> | AsyncIterable<string>
		onClone?: (repo: string, records: number) => void
	} = {}
): Promise<WOFDoctorReport> {
	const listRecords = opts.listRecords ?? trackedRecordPaths
	const present = new Set<number>()
	const candidates = new Map<number, DanglingCandidate>()

	const report: WOFDoctorReport = {
		clones: clones.length,
		records: 0,
		wholeFileParses: 0,
		unreadable: { count: 0, sample: [] },
		retired: { superseded: 0, deprecated: 0, byRepo: {}, sample: [] },
		dangling: { ids: 0, references: 0, listed: 0, resolvable: 0, byKey: {}, sample: [] },
		mapping: { read: mapping !== null, entries: mapping?.size ?? 0, successorMissing: 0, sample: [] },
	}

	for (const { repo, directory } of clones) {
		const read = parallelMap(
			listRecords(directory),
			async (
				path
			): Promise<
				{ path: string; properties: Record<string, unknown>; wholeFile: boolean } | { path: string; error: string }
			> => {
				try {
					return { path, ...(await readRecordProperties(`${directory.toString()}/${path}`)) }
				} catch (error) {
					return { path, error: error instanceof Error ? error.message : String(error) }
				}
			},
			{ concurrency: opts.concurrency ?? 32 }
		)

		let records = 0

		for await (const result of read) {
			const refs = "properties" in result ? recordReferences(result.properties) : null

			if (!refs) {
				report.unreadable.count++

				if (report.unreadable.sample.length < SAMPLE_LIMIT) {
					report.unreadable.sample.push({
						repo,
						path: result.path,
						error: "error" in result ? result.error : "the properties hold no numeric wof:id",
					})
				}

				continue
			}

			records++

			if ("properties" in result && result.wholeFile) {
				report.wholeFileParses++
			}

			present.add(refs.id)

			if (refs.superseded || refs.deprecated) {
				const kind = refs.superseded ? "superseded" : "deprecated"
				const counts = (report.retired.byRepo[repo] ??= { superseded: 0, deprecated: 0 })

				counts[kind]++

				report.retired[kind]++

				if (report.retired.sample.length < SAMPLE_LIMIT) {
					report.retired.sample.push({ repo, id: refs.id, kind })
				}
			}

			for (const { key, id } of refs.references) {
				let candidate = candidates.get(id)

				if (!candidate) {
					candidate = { references: 0, keys: new Set(), referencedBy: [] }
					candidates.set(id, candidate)
				}

				candidate.references++
				candidate.keys.add(key)

				// A record that gives the same ancestor as its parent and in its hierarchy is one referrer.
				if (candidate.referencedBy.length < REFERRER_SAMPLE_LIMIT && candidate.referencedBy.at(-1) !== refs.id) {
					candidate.referencedBy.push(refs.id)
				}
			}
		}

		report.records += records
		opts.onClone?.(repo, records)
	}

	for (const [id, candidate] of candidates) {
		if (present.has(id)) continue

		report.dangling.ids++
		report.dangling.references += candidate.references

		for (const key of candidate.keys) {
			report.dangling.byKey[key] = (report.dangling.byKey[key] ?? 0) + 1
		}

		const successors = mapping?.has(id) ? finalSuccessors(id, mapping) : null

		if (successors) {
			report.dangling.listed++

			if (successors.length && successors.every((successor) => present.has(successor))) {
				report.dangling.resolvable++
			}
		}

		if (report.dangling.sample.length < SAMPLE_LIMIT) {
			report.dangling.sample.push({
				id,
				keys: [...candidate.keys],
				referencedBy: candidate.referencedBy,
				references: candidate.references,
				successors,
			})
		}
	}

	if (mapping) {
		for (const id of mapping.keys()) {
			const finals = finalSuccessors(id, mapping)

			if (finals.some((successor) => !present.has(successor))) {
				report.mapping.successorMissing++

				if (report.mapping.sample.length < SAMPLE_LIMIT) {
					report.mapping.sample.push({ id, successors: finals })
				}
			}
		}
	}

	return report
}

/**
 * The content of a `whosonfirst-data-deprecated` checkout: each listed ID with its successors.
 *
 * Each file under `data/` takes its file name from an ID and holds one successor ID per line.
 * The file is empty for an ID deprecated without a successor.
 *
 * @throws When a file name or line is not a positive integer.
 */
export async function readDeprecatedMapping(
	directory: PathBuilderLike,
	listFiles: (directory: PathBuilderLike) => Iterable<string> | AsyncIterable<string> = (dir) =>
		streamTrackedFiles(dir, ["data"])
): Promise<Map<number, number[]>> {
	const mapping = new Map<number, number[]>()

	async function* idFiles(): AsyncGenerator<string> {
		for await (const path of listFiles(directory)) {
			if (/\/\d+$/.test(path)) {
				yield path
			}
		}
	}

	const read = parallelMap(
		idFiles(),
		async (path) => ({ path, text: await readLocalTextFile(`${directory.toString()}/${path}`) }),
		{ concurrency: 32 }
	)

	for await (const { path, text } of read) {
		const id = Number(path.slice(path.lastIndexOf("/") + 1))
		const successors: number[] = []

		for (const line of TextSpliterator.from(text)) {
			if (!line.trim()) continue

			const successor = Number(line.trim())

			if (!Number.isInteger(successor) || successor <= 0) throw new Error(`${path}: "${line}" is not an ID`)

			successors.push(successor)
		}

		mapping.set(id, successors)
	}

	return mapping
}
