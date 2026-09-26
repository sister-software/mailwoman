/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Shared utilities for the `wof-admin` / `wof-postalcode` GeoJSON-bundle adapters, which read the
 * per-record bundles published as `github.com/whosonfirst-data/whosonfirst-data-{admin,postalcode}-<cc>`
 * repos: a tree of `data/<3>/<3>/<3>/<wof-id>.geojson` files plus alternate-geometry siblings like
 * `<id>-alt-quattroshapes.geojson`, of which only the canonical record is consumed.
 *
 * `is_current` semantics follow WOF + Pelias: `mz:is_current` ∈ {`1`, `-1`} are live and `0` is
 * superseded; WOF's official postalcode distribution stamps every row `-1` ("unknown but treated as
 * active"), so an `is_current = 1` filter silently emits zero rows from the real corpus.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { tryParsingJSON } from "@mailwoman/core/json"
import type { PathBuilderLike } from "path-ts"
import { Globerator } from "spliterator/node/fs"

/**
 * A WOF GeoJSON feature, as published by the per-record bundles.
 */
export interface WOFFeature {
	type?: string
	id?: number | string
	properties?: Record<string, unknown> | null
}

/**
 * Lightweight in-memory shape both adapters keep per record; geometry is intentionally
 * dropped because the adapters never consult it.
 */
export interface WOFRecord {
	id: number
	parent_id: number | null
	name: string
	placetype: string
	/**
	 * ISO 3166-1 alpha-2 from `wof:country`, upper-cased on read.
	 *
	 * The standard's codes are upper case and the publisher's spelling is not always,
	 * and a consumer such as the `--country NL` filter compares the two strings directly.
	 */
	country: string
	/**
	 * Localized name variants from `name:*` properties.
	 *
	 * Keys are the raw `name:eng_x_preferred` form; values are the first non-empty string from the
	 * underlying array, because WOF stores variants as arrays even when only one form is present.
	 * The canonical `wof:name` is not included — adapters add a synthetic `"default"` slot for it.
	 */
	nameVariants: Map<string, string>
}

/**
 * `mz:is_current` ∈ {`1`, `-1`} → keep, `0` → drop.
 *
 * Real WOF postalcode distros tag every row `-1` ("unknown but treated as active") and the
 * Pelias importer accepts `-1` alongside `1`; tightening the predicate to `= 1` makes the
 * postalcode distros contribute zero rows to the corpus, silently, with no error to notice it by.
 */
export function isCurrentFeature(props: Record<string, unknown>): boolean {
	const raw = props["mz:is_current"]
	const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : 1

	return n !== 0
}

/**
 * Pull `name:*` localized variants off a WOF feature's properties, lifting the first
 * non-empty string from the array WOF stores them in (`["Saint Petersburg"]`);
 * multiple-value variants (rare, usually historical aliases) are not split into separate rows,
 * and an adapter that needs them can iterate the underlying array.
 */
export function extractNameVariants(props: Record<string, unknown>): Map<string, string> {
	const out = new Map<string, string>()

	for (const [key, value] of Object.entries(props)) {
		if (!key.startsWith("name:")) continue

		const candidate = firstNonBlankString(value)

		if (candidate) {
			out.set(key, candidate)
		}
	}

	return out
}

function firstNonBlankString(value: unknown): string | undefined {
	for (const candidate of Array.isArray(value) ? value : [value]) {
		if (typeof candidate !== "string") continue

		const normalized = candidate.trim()

		if (normalized) return normalized
	}

	return undefined
}

/**
 * Turn a `name:*` property key into a hyphen-safe suffix fragment for `source_id`
 * (`"name:eng_x_colloquial"` → `"name-eng-x-colloquial"`); both `:` and `_` become `-`
 * because both collide with the separator vocabulary downstream consumers split on.
 */
export function normalizeNameKey(rawKey: string): string {
	return rawKey.replaceAll(/[:_]/g, "-")
}

/**
 * Parse a single GeoJSON feature; `null` means skip this row for any reason.
 */
function recordFromFeature(feature: WOFFeature): WOFRecord | null {
	if (!feature || feature.type !== "Feature" || !feature.properties) return null
	const props = feature.properties

	const rawID = typeof feature.id === "number" ? feature.id : props["wof:id"]
	const id = typeof rawID === "number" ? rawID : typeof rawID === "string" ? Number(rawID) : Number.NaN

	if (!Number.isFinite(id)) return null

	const name = props["wof:name"]

	if (typeof name !== "string" || !name.trim()) return null

	const placetype = props["wof:placetype"]

	if (typeof placetype !== "string" || !placetype) return null

	const rawCountry = props["wof:country"]

	if (typeof rawCountry !== "string" || !rawCountry) return null

	const country = rawCountry.toUpperCase()

	if (!isCurrentFeature(props)) return null

	const parentRaw = props["wof:parent_id"]

	const parent_id =
		typeof parentRaw === "number"
			? parentRaw
			: typeof parentRaw === "string" && parentRaw.trim()
				? Number(parentRaw)
				: null

	return {
		id,
		parent_id: Number.isFinite(parent_id as number) ? (parent_id as number) : null,
		name: name.trim(),
		placetype,
		country,
		nameVariants: extractNameVariants(props),
	}
}

/**
 * Stream every canonical GeoJSON file under `repoDir` and yield parsed `WOFRecord`s;
 * `repoDir` may be a single cloned `whosonfirst-data-*` repo or a parent holding several
 * (the corpus pipeline clones all four into a shared `wof/repos/` root).
 *
 * `-alt-` siblings are skipped as alternate-geometry exports rather than new records,
 * and per-file errors (unreadable, malformed JSON, missing properties) are swallowed
 * so one bad file does not poison a multi-gigabyte walk.
 */
export async function* walkFeatures(
	repoDir: PathBuilderLike,
	opts: { signal?: AbortSignal } = {}
): AsyncIterable<WOFRecord> {
	for await (const filePath of Globerator.from("**/*.geojson", {
		cwd: repoDir,
		absolute: true,
		exclude: ["**/*-alt-*.geojson"],
		// Bundle repositories can expose their data through a link.
		followSymlinks: true,
		signal: opts.signal,
	})) {
		let text: string

		try {
			text = await readLocalTextFile(filePath)
		} catch {
			continue
		}

		const parsed = tryParsingJSON<WOFFeature>(text)

		if (parsed === null) continue

		const rec = recordFromFeature(parsed)

		if (rec) {
			yield rec
		}
	}
}

/**
 * An in-memory ancestry index: `Map<wof_id, [parent, grandparent, ...]>`,
 * walking `parent_id` upward and stopping at the first missing link.
 *
 * A cycle guard halts at any re-visit — defensive, since WOF data is acyclic by construction
 * but a corrupt fixture should not infinite-loop the adapter — and records whose
 * ancestors are absent from `byID` get a shorter chain rather than failing.
 */
export type AncestryIndex = Map<number, WOFRecord[]>

export function buildAncestryIndex(byID: Map<number, WOFRecord>): AncestryIndex {
	const index: AncestryIndex = new Map()

	for (const [id, rec] of byID) {
		const chain: WOFRecord[] = []
		const guard = new Set<number>([id])
		let cur: number | null = rec.parent_id

		while (cur !== null && cur > 0) {
			const parent = byID.get(cur)

			if (!parent) break

			if (guard.has(parent.id)) break
			chain.push(parent)
			guard.add(parent.id)
			cur = parent.parent_id
		}

		index.set(id, chain)
	}

	return index
}
