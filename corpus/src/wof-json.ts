/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared utilities for the `wof-admin` / `wof-postalcode` GeoJSON-bundle adapters.
 *
 *   The Phase 1.5.1 pivot moved both adapters off the SpatiaLite distribution (dead mirror, empty
 *   `names` table) and onto the per-record GeoJSON bundles published as
 *   `github.com/whosonfirst-data/whosonfirst-data-{admin,postalcode}-<cc>` repos. Each repo carries
 *   a tree of `data/<3>/<3>/<3>/<wof-id>.geojson` files plus alternate-geometry siblings like
 *   `<id>-alt-quattroshapes.geojson`. The adapter only consumes the canonical record (no `-alt-`
 *   files); the alternate geometries are irrelevant to the name/hierarchy concerns Phase 1 cares
 *   about.
 *
 *   This module provides:
 *
 *   - `WofRecord`: the lightweight per-feature shape both adapters carry in their ancestry index.
 *   - `walkFeatures`: streaming directory walk → parsed `WofRecord`s (skips alt files, bad JSON,
 *       deprecated records).
 *   - `buildAncestryIndex`: in-memory ancestry chain construction (`Map<id, ancestors[]>`).
 *   - `extractNameVariants`: pulls `name:*` localized name lists off a feature's properties.
 *   - `normalizeNameKey`: turns `"name:eng_x_colloquial"` into `"name-eng-x-colloquial"` for safe use
 *       in `source_id` suffixes.
 *
 *   `is_current` semantics follow WOF + Pelias: `mz:is_current` ∈ {`1`, `-1`} are live; `0` is
 *   superseded. WOF's official postalcode distribution stamps every row with `-1` ("unknown but
 *   treated as active"), which is why the previous SpatiaLite adapter's `is_current = 1` filter
 *   silently emitted zero rows from the real corpus.
 */

import FastGlob from "fast-glob"
import { readFile } from "node:fs/promises"

/** A WOF GeoJSON feature, as published by the per-record bundles. */
export interface WofFeature {
	type?: string
	id?: number | string
	properties?: Record<string, unknown> | null
}

/**
 * Lightweight in-memory shape both adapters keep per record. Geometry is intentionally dropped —
 * it's 95% of the file weight and the adapters never consult it.
 */
export interface WofRecord {
	id: number
	parent_id: number | null
	/** Canonical `wof:name` of the record. */
	name: string
	placetype: string
	/** ISO 3166-1 alpha-2 from `wof:country`. */
	country: string
	/**
	 * Localized name variants from `name:*` properties.
	 *
	 * Keys are the raw `name:eng_x_preferred` form; values are the first non-empty string from the
	 * underlying array (WOF stores variants as arrays even when only one form is present). The
	 * canonical `wof:name` is NOT included here — adapters add a synthetic `"default"` slot for it.
	 */
	nameVariants: Map<string, string>
}

/**
 * `mz:is_current` ∈ {`1`, `-1`} → keep. `0` → drop.
 *
 * Real WOF postalcode distros tag every row `-1` ("unknown but treated as active"); the Pelias
 * importer accepts `-1` alongside `1`. The previous SpatiaLite-backed adapters filtered on `= 1`
 * only and silently emitted zero rows from the corpus — this loosened predicate is the critical
 * fix.
 */
export function isCurrentFeature(props: Record<string, unknown>): boolean {
	const raw = props["mz:is_current"]
	const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : 1
	return n !== 0
}

/**
 * Pull `name:*` localized variants off a WOF feature's properties. WOF stores variants as arrays
 * (`["Saint Petersburg"]`); we lift the first non-empty string. Multiple-value variants (rare;
 * usually historical aliases) are not split into separate rows by this helper — adapters can opt in
 * by iterating the underlying array if they need it.
 */
export function extractNameVariants(props: Record<string, unknown>): Map<string, string> {
	const out = new Map<string, string>()
	for (const [key, value] of Object.entries(props)) {
		if (!key.startsWith("name:")) continue
		const candidate = Array.isArray(value)
			? value.find((v): v is string => typeof v === "string" && v.trim().length > 0)
			: typeof value === "string" && value.trim().length > 0
				? value
				: undefined
		if (candidate) out.set(key, candidate.trim())
	}
	return out
}

/**
 * Turn a `name:*` property key into a hyphen-safe suffix fragment for `source_id`.
 *
 * `"name:eng_x_colloquial"` → `"name-eng-x-colloquial"`. `:` and `_` both become `-` because both
 * collide with the existing source_id separator vocabulary and downstream consumers split on `-`.
 */
export function normalizeNameKey(rawKey: string): string {
	return rawKey.replace(/[:_]/g, "-")
}

/** Result of parsing a single GeoJSON file. `null` means "skip this row" (any reason). */
function recordFromFeature(feature: WofFeature): WofRecord | null {
	if (!feature || feature.type !== "Feature" || !feature.properties) return null
	const props = feature.properties

	const rawId = typeof feature.id === "number" ? feature.id : props["wof:id"]
	const id = typeof rawId === "number" ? rawId : typeof rawId === "string" ? Number(rawId) : NaN
	if (!Number.isFinite(id)) return null

	const name = props["wof:name"]
	if (typeof name !== "string" || !name.trim()) return null

	const placetype = props["wof:placetype"]
	if (typeof placetype !== "string" || !placetype) return null

	const country = props["wof:country"]
	if (typeof country !== "string" || !country) return null

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
 * Stream every canonical GeoJSON file under `repoDir` and yield parsed `WofRecord`s.
 *
 * `repoDir` may point at a single cloned `whosonfirst-data-*` repo OR at a parent directory holding
 * several such repos (the corpus pipeline clones all four into a shared `wof/repos/` root and runs
 * the adapter against that root). `**\/*.geojson` walks the whole tree; `-alt-` siblings are
 * skipped since they're alternate-geometry exports, not new records.
 *
 * Errors per-file (unreadable, malformed JSON, missing properties) are swallowed so one bad file
 * doesn't poison a 3 GB walk. Adapters can add stricter validation downstream if they need it.
 */
export async function* walkFeatures(repoDir: string, opts: { signal?: AbortSignal } = {}): AsyncIterable<WofRecord> {
	const stream = FastGlob.stream(["**/*.geojson"], {
		cwd: repoDir,
		absolute: true,
		onlyFiles: true,
		suppressErrors: true,
	})

	for await (const entry of stream) {
		if (opts.signal?.aborted) return
		const filePath = String(entry)
		if (filePath.includes("-alt-")) continue

		let text: string
		try {
			text = await readFile(filePath, "utf8")
		} catch {
			continue
		}

		let parsed: WofFeature
		try {
			parsed = JSON.parse(text) as WofFeature
		} catch {
			continue
		}

		const rec = recordFromFeature(parsed)
		if (rec) yield rec
	}
}

/**
 * Build an in-memory ancestry index: `Map<wof_id, [parent, grandparent, ...]>` walking `parent_id`
 * upward and stopping at the first missing link. A cycle guard halts at any re-visit (defensive —
 * WOF data is acyclic by construction but corrupt fixtures shouldn't infinite-loop the adapter).
 *
 * Records whose ancestors aren't in `byId` (e.g. an FR locality whose region wasn't included in the
 * cloned repo set) get a shorter chain; the variant emission gracefully degrades.
 */
export type AncestryIndex = Map<number, WofRecord[]>

export function buildAncestryIndex(byId: Map<number, WofRecord>): AncestryIndex {
	const index: AncestryIndex = new Map()
	for (const [id, rec] of byId) {
		const chain: WofRecord[] = []
		const guard = new Set<number>([id])
		let cur: number | null = rec.parent_id
		while (cur !== null && cur > 0) {
			const parent = byId.get(cur)
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
