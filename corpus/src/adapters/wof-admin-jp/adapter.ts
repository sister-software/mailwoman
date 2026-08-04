/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `wof-admin-jp`: Japanese admin-hierarchy adapter.
 *
 *   PROTOTYPE — not yet wired into the Stage 3 training corpus. Demonstrates the JP address shape and
 *   synthesizes BIO-labeled training rows from the global WOF SQLite.
 *
 *   JP addresses differ from US/EU in three ways:
 *
 *   1. **Reversed ordering** — region → county → locality → block → house_number "東京都世田谷区南町1-2-3" not
 *        "1-2-3 Minamicho, Setagaya, Tokyo"
 *   2. **No street names** — most JP addresses use a block/sub-block grid system. The "neighbourhood"
 *        placetype (丁目) is the closest analog to a street but is actually a grid cell.
 *   3. **Postcode-first convention** — addresses are often prefixed with `〒NNN-NNNN`.
 *
 *   Schema mapping to ComponentTags (subset of Stage 3 + JP-specific Phase 6 tags):
 *
 *   | JP concept | WOF placetype | ComponentTag (Phase 6) |
 *   |-----------------|--------------------|-----------------------| | 都道府県 (prefecture) | region |
 *   region (or prefecture) | | 市区町村 (city/ward) | county/locality | locality (or municipality) | |
 *   丁目 (chome) | neighbourhood | block (Phase 6 tag) | | 番地 (banchi) | (synth) | sub_block | | 号
 *   (gō) | (synth) | house_number | | 〒 (postcode prefix) | — | postcode |
 *
 *   This adapter currently emits only the admin chain (region → locality → block). House numbers and
 *   sub-blocks require a different data source (JP postcode database or real-world address dumps
 *   from MLIT/JapanPost).
 */

import { DatabaseSync } from "node:sqlite"

import type { AdapterOptions, CanonicalRow, CorpusAdapter } from "../../types.ts"

/**
 * Ancestry hops walked upward from a WOF record before giving up — deeper than any real JP admin chain.
 */
const MAX_ANCESTRY_DEPTH = 6

/**
 * Registry id for this adapter. Stamped into every row it emits, so a corpus record can be traced back to the dataset
 * it came from.
 */
export const WOF_ADMIN_JP_ADAPTER_ID = "wof-admin-jp"

interface PlaceRow {
	id: number
	name: string
	placetype: string
	parent_id: number
	country: string
}

interface NameRow {
	id: number
	name: string
	language: string
}

/**
 * Walk parent chain up to 6 levels, over a place table already resident in memory.
 *
 * `resolve` is the escape hatch for a parent outside the preloaded set (a chain that leaves the country); it is a point
 * query, so keeping the common case out of it is the whole point.
 */
function chainOf(
	byID: Map<number, PlaceRow>,
	resolve: (id: number) => PlaceRow | undefined,
	startID: number
): PlaceRow[] {
	const out: PlaceRow[] = []
	let id = startID

	for (let i = 0; i < MAX_ANCESTRY_DEPTH && id > 0; i++) {
		const row = byID.get(id) ?? resolve(id)

		if (!row) break
		out.push(row)
		id = row.parent_id
	}

	return out
}

/**
 * Pick the best display name for a place: prefer Japanese variant, fall back to English.
 */
function pickName(row: PlaceRow, jpnNames: Map<number, string>): string {
	return jpnNames.get(row.id) ?? row.name
}

/**
 * Synthesize a JP address from a hierarchy chain.
 *
 * Format: `〒<postcode>? <region><locality><neighbourhood>?`
 *
 * No house numbers yet — needs MLIT data.
 */
export function synthesizeJpAddress(
	chain: PlaceRow[],
	jpnNames: Map<number, string>
): {
	raw: string
	components: CanonicalRow["components"]
} | null {
	const region = chain.find((r) => r.placetype === "region")
	const locality = chain.find((r) => r.placetype === "locality" || r.placetype === "county")

	if (!region || !locality) return null

	const neighbourhood = chain.find((r) => r.placetype === "neighbourhood")

	const regionName = pickName(region, jpnNames)
	const localityName = pickName(locality, jpnNames)
	const neighbourhoodName = neighbourhood ? pickName(neighbourhood, jpnNames) : null

	const components: CanonicalRow["components"] = {
		region: regionName,
		locality: localityName,
		country: "JP",
	}

	if (neighbourhoodName) {
		components.dependent_locality = neighbourhoodName
	}

	const raw = [regionName, localityName, neighbourhoodName].filter(Boolean).join("")

	return { raw, components }
}

/**
 * Build the JP adapter. Reads from the unified global WOF SQLite, walks admin chains starting from neighbourhoods, and
 * yields canonical rows.
 */
export function createWOFAdminJpAdapter(): CorpusAdapter {
	return {
		id: WOF_ADMIN_JP_ADAPTER_ID,
		defaultLicense: "CC-BY-4.0",
		description: "Japanese admin hierarchy from WOF (synthesized addresses without house numbers).",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && opts.country !== "JP") {
				throw new Error(`wof-admin-jp adapter: only JP supported, got country=${opts.country}`)
			}

			const db = new DatabaseSync(opts.inputPath, { readOnly: true })

			try {
				const jpnNamesStmt = db.prepare(`SELECT id, name FROM names WHERE language = 'jpn'`)
				const jpnNames = new Map<number, string>()

				for (const row of jpnNamesStmt.all() as { id: number; name: string }[]) {
					if (!jpnNames.has(row.id)) {
						jpnNames.set(row.id, row.name)
					}
				}

				// One read of the JP place table instead of a fresh `prepare` + up to six point queries per
				// seed; there are tens of thousands of neighbourhood seeds.
				const byID = new Map<number, PlaceRow>()

				for (const row of db
					.prepare(`SELECT id, name, placetype, parent_id, country FROM spr WHERE country='JP'`)
					.all() as unknown as PlaceRow[]) {
					byID.set(row.id, row)
				}

				const outsideStmt = db.prepare(`SELECT id, name, placetype, parent_id, country FROM spr WHERE id = ?`)

				const resolveOutside = (id: number): PlaceRow | undefined => {
					const row = outsideStmt.get(id) as unknown as PlaceRow | undefined

					if (row) {
						byID.set(id, row)
					}

					return row
				}

				const seeds = [...byID.values()].filter((row) => row.placetype === "neighbourhood")

				let emitted = 0

				for (const seed of seeds) {
					if (opts.signal?.aborted) break

					if (opts.limit !== undefined && emitted >= opts.limit) break

					const chain = chainOf(byID, resolveOutside, seed.id)
					const synth = synthesizeJpAddress(chain, jpnNames)

					if (!synth) continue

					yield {
						raw: synth.raw,
						components: synth.components,
						country: "JP",
						locale: "ja-JP",
						source: WOF_ADMIN_JP_ADAPTER_ID,
						source_id: `${WOF_ADMIN_JP_ADAPTER_ID}-${seed.id}`,
						corpus_version: "",
						license: "CC-BY-4.0",
					}

					emitted++
				}
			} finally {
				db.close()
			}
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const wofAdminJpAdapter = createWOFAdminJpAdapter()
