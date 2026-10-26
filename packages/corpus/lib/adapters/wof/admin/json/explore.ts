/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman wof explore`: render every row the `wof-admin` adapter would emit for one Who's On First record.
 *
 *   The build indexes the whole 121 GB tree before it renders anything.
 *   This reads only the record and the ancestors its `wof:hierarchy` and `wof:parent_id` chain name,
 *   builds the index from those alone, and calls the adapter's own functions on it,
 *   so the rows are what a build would emit for the record.
 */

import { wofReposPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import {
	nameSlotsFor,
	placetypeToTag as adapterTag,
	variantsFor,
	WOF_ADMIN_ADAPTER_ID,
} from "#adapters/wof/admin/json/adapter"
import { emitWOFJSONRows, LOCALE_BY_COUNTRY, type NameSlot } from "#adapters/wof/json-rows"
import { AUGMENTATIONS } from "#synthesizers/utils"
import type { CanonicalRow } from "#types"
import { buildAncestorRecordIndex, readFeatureRecord, type WOFRecord } from "#utils"

/**
 * The deepest `wof:parent_id` chain read, a guard against a corrupt cycle.
 */
const PARENT_CHAIN_LIMIT = 16

/**
 * The relative path of a feature inside a WOF repo.
 *
 * `421205765` is at `data/421/205/765/421205765.geojson`.
 * WOF splits the decimal id into groups of three digits from the left.
 * `1021` is at `data/102/1/1021.geojson`.
 */
export function wofFeatureRelativePath(id: number): string {
	const groups = String(id).match(/\d{1,3}/g) ?? []

	return ["data", ...groups, `${id}.geojson`].join("/")
}

/**
 * The repos under `reposRoot`, as paths relative to it, per-country admin repos first, then the rest.
 *
 * A repo is a directory holding `data/`.
 * The data root keeps some one level down, such as `whosonfirst-data/whosonfirst-data-admin-fr`.
 */
export async function listWOFRepos(reposRoot: PathBuilderLike = wofReposPath): Promise<string[]> {
	const root = PathBuilder.from(reposRoot)
	const cwd = root.toString()

	// A pattern ending in `data` matches only a repo's data directory, so a stray file beside it is never probed.
	const dataDirectories = [
		...(await Globerator.from("*/data", { cwd, absolute: false, onlyFiles: false }).toSorted()),
		...(await Globerator.from("*/*/data", { cwd, absolute: false, onlyFiles: false }).toSorted()),
	]

	const repos = dataDirectories.map((directory) => directory.slice(0, -"/data".length))

	const isAdmin = (name: string): boolean => name.includes("-admin-")

	return [...repos.filter(isAdmin), ...repos.filter((name) => !isAdmin(name))]
}

/**
 * The file holding a feature, searched across every repo, or `null` when none holds it.
 *
 * A caller looking up several features passes the {@linkcode listWOFRepos} result once.
 */
export async function findWOFFeaturePath(
	id: number,
	reposRoot: PathBuilderLike = wofReposPath,
	repos?: readonly string[]
): Promise<string | null> {
	const root = PathBuilder.from(reposRoot)
	const relative = wofFeatureRelativePath(id)

	for (const repo of repos ?? (await listWOFRepos(root))) {
		const candidate = root(repo, relative).toString()

		if (await pathExists(candidate)) return candidate
	}

	return null
}

/**
 * One rendered row of an explored record.
 */
export interface ExploredRow {
	/**
	 * The variant suffix of the `source_id`: `locality`, `localized-jpn-country`, …
	 */
	suffix: string
	raw: string
	components: CanonicalRow["components"]
	source_id: string
	/**
	 * The country whose order and join rendered the row, when it is not the record's own.
	 */
	country: string
}

/**
 * The rows rendered from one name slot.
 */
export interface ExploredSlot {
	slot: NameSlot
	rows: ExploredRow[]
}

/**
 * Everything one record renders, with what was read to render it.
 */
export interface WOFExploration {
	record: WOFRecord
	/**
	 * The file the record was read from.
	 */
	path: string
	/**
	 * Ancestors read, nearest first.
	 */
	ancestors: WOFRecord[]
	/**
	 * Ancestor ids the record names whose file was not found or was skipped.
	 *
	 * Listing them keeps a missing ancestor visible.
	 */
	unresolvedAncestors: number[]
	slots: ExploredSlot[]
}

export interface ExploreOptions {
	/**
	 * Directory holding the `whosonfirst-data-*` repos.
	 *
	 * @defaultValue `$MAILWOMAN_DATA_ROOT/src/wof-repos`
	 */
	reposRoot?: PathBuilderLike
}

/**
 * Render every row the `wof-admin` adapter emits for one record.
 *
 * @throws When no repo holds the record, or its file is not a record the adapter reads.
 */
export async function exploreWOFRecord(id: number, options: ExploreOptions = {}): Promise<WOFExploration> {
	const reposRoot = options.reposRoot ?? wofReposPath
	const repos = await listWOFRepos(reposRoot)
	const path = await findWOFFeaturePath(id, reposRoot, repos)

	if (!path) {
		throw new Error(`WOF ${id}: no repo under ${PathBuilder.from(reposRoot)} holds ${wofFeatureRelativePath(id)}`)
	}

	const record = await readFeatureRecord(path)

	if (!record) {
		throw new Error(`WOF ${id}: ${path} is unreadable, superseded or lacks a name, placetype or country`)
	}

	if (!adapterTag(record.placetype)) {
		throw new Error(`WOF ${id}: placetype "${record.placetype}" is not one the wof-admin adapter renders`)
	}

	const byID = new Map<number, WOFRecord>([[record.id, record]])
	const ancestors: WOFRecord[] = []
	const unresolvedAncestors: number[] = []

	// The build indexes by `wof:hierarchy` and walks `wof:parent_id` upward, so this reads the same two sets.
	const load = async (ancestorID: number): Promise<WOFRecord | null> => {
		const known = byID.get(ancestorID)

		if (known) return known

		const file = await findWOFFeaturePath(ancestorID, reposRoot, repos)
		const ancestor = file ? await readFeatureRecord(file) : null

		// A record the build does not index never enters its `byID`, so the parent walk stops there.
		if (!ancestor || !adapterTag(ancestor.placetype)) {
			if (!unresolvedAncestors.includes(ancestorID)) {
				unresolvedAncestors.push(ancestorID)
			}

			return null
		}

		byID.set(ancestor.id, ancestor)
		ancestors.push(ancestor)

		return ancestor
	}

	for (const ancestorID of record.ancestors) {
		await load(ancestorID)
	}

	let parent = record.parent_id

	for (let step = 0; parent !== null && parent > 0 && step < PARENT_CHAIN_LIMIT; step++) {
		const next = await load(parent)

		parent = next ? next.parent_id : null
	}

	const ancestry = buildAncestorRecordIndex(byID, adapterTag)

	const slots = new Map<string, ExploredSlot>()

	for (const slot of nameSlotsFor(record)) {
		slots.set(slot.key, { slot, rows: [] })
	}

	const prefix = `${WOF_ADMIN_ADAPTER_ID}-${record.id}-`
	const byLongestKey = [...slots.keys()].toSorted((a, b) => b.length - a.length)

	for (const row of emitWOFJSONRows({
		records: new Map([[record.id, record]]),
		ancestry,
		adapterOptions: { inputPath: path },
		adapterID: WOF_ADMIN_ADAPTER_ID,
		localeByCountry: LOCALE_BY_COUNTRY,
		nameSlotsFor,
		variantsFor,
	})) {
		const rest = row.source_id.slice(prefix.length)
		const key = byLongestKey.find((candidate) => rest.startsWith(`${candidate}-`))

		if (!key) throw new Error(`WOF ${id}: row ${row.source_id} matches none of the record's name slots`)

		slots.get(key)!.rows.push({
			suffix: rest.slice(key.length + 1),
			raw: row.raw,
			components: row.components,
			source_id: row.source_id,
			country: row.country,
		})
	}

	return { record, path, ancestors, unresolvedAncestors, slots: [...slots.values()] }
}

/**
 * One augmentation's output for an explored row.
 */
export interface AugmentedExploredRow {
	/**
	 * The `AUGMENTATIONS` id: `drop-commas`, `case-upper`, …
	 */
	augmentation: string
	raw: string
	components: CanonicalRow["components"]
	source_id: string
}

/**
 * Apply every registered augmentation to a row, keeping those that produce a row different from it.
 *
 * An augmentation that does not apply to the row returns `null` and is left out.
 */
export function augmentExploredRow(row: ExploredRow): AugmentedExploredRow[] {
	const canonical: CanonicalRow = {
		raw: row.raw,
		components: row.components,
		country: row.country,
		source: WOF_ADMIN_ADAPTER_ID,
		source_id: row.source_id,
		license: "CC0-1.0",
	}

	const out: AugmentedExploredRow[] = []

	for (const [augmentation, apply] of Object.entries(AUGMENTATIONS)) {
		const augmented = apply(canonical)

		if (!augmented || augmented.raw === row.raw) continue

		out.push({
			augmentation,
			raw: augmented.raw,
			components: augmented.components,
			source_id: augmented.source_id,
		})
	}

	return out
}
