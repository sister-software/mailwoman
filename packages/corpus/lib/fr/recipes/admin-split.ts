/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generate French training rows that distinguish a département (`region`) from a commune
 *   (`locality`) in bare, comma-separated, and space-separated forms. Derive the département from
 *   each real BAN postcode. Input rows are tab-separated commune, postcode, longitude, and latitude.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import { departementForCodePostal } from "@mailwoman/codex/fr"
import { tempRootPath } from "@mailwoman/core/data-root"
import { stringifyJSON } from "@mailwoman/core/json"
import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"
import { CSVSpliterator, Delimiters } from "spliterator"

import { stableSourceID } from "#adapters/utils"
import type { CorpusRecipe } from "#recipes/scaffold"
import { SourceRegister } from "#registers"
import { SurfaceOrigin } from "#types"
import type { CanonicalRow } from "#types"
import { alignRow } from "#utils"

const DEFAULT_COMMUNES = tempRootPath("reg", "fr-communes.tsv")
const LICENSE = "BAN (Base Adresse Nationale) commune+postcode tuples, rendered admin-split — see ingest SOURCE"

/**
 * Commune tuple with its département derived from the postcode.
 */
interface CommuneRow {
	commune: string
	postcode: string
	departement: string
	lon: string | undefined
	lat: string | undefined
}

/**
 * Rendered admin-split address variant.
 */
interface AdminSplitVariant {
	raw: string
	components: Partial<Record<ComponentTag, string>>
	order: string
}

/**
 * Read commune tuples and derive the département from each postcode.
 */
async function readCommunes(path: string): Promise<CommuneRow[]> {
	const rows: CommuneRow[] = []

	// The TSV has no header row.
	for await (const [commune, postcode, lon, lat] of CSVSpliterator.fromAsync(path, {
		columnDelimiter: Delimiters.Tab,
		header: false,
	})) {
		if (!commune || !postcode) continue
		const dep = departementForCodePostal(postcode)

		if (!dep) continue // Skip postcodes without a mapped département.
		rows.push({ commune, postcode, departement: dep.name, lon, lat })
	}

	return rows
}

// Share of communes rendered in uppercase.
const UPPER_LOCALITY_SHARE = 0.1
// Cumulative cutoffs for the five address layouts.
const BARE_COMMA_CUTOFF = 0.25
const BARE_COMMA_PC_CUTOFF = 0.5
const SPACE_PC_CUTOFF = 0.7
const CANONICAL_PC_FIRST_CUTOFF = 0.85
// Share of rows with an explicit country component.
const APPEND_COUNTRY_SHARE = 0.2

/**
 * Render one address layout, splitting the département from the commune where present.
 */
function render(random: () => number, c: CommuneRow): AdminSplitVariant {
	const r = random()
	const loc = random() < UPPER_LOCALITY_SHARE ? c.commune.toUpperCase() : c.commune
	const dep = c.departement
	const pc = c.postcode
	let out: AdminSplitVariant

	if (r < BARE_COMMA_CUTOFF) {
		// Bare comma form without postcode.
		out = { raw: `${loc}, ${dep}`, components: { locality: loc, region: dep }, order: "bare-comma" }
	} else if (r < BARE_COMMA_PC_CUTOFF) {
		// Comma form with postcode.
		out = {
			raw: `${loc}, ${dep} ${pc}`,
			components: { locality: loc, region: dep, postcode: pc },
			order: "bare-comma-pc",
		}
	} else if (r < SPACE_PC_CUTOFF) {
		// Space-delimited region with postcode.
		out = { raw: `${loc} ${dep} ${pc}`, components: { locality: loc, region: dep, postcode: pc }, order: "space-pc" }
	} else if (r < CANONICAL_PC_FIRST_CUTOFF) {
		// Canonical postcode-first form without département.
		out = { raw: `${pc} ${loc}`, components: { postcode: pc, locality: loc }, order: "canonical-pc-first" }
	} else {
		// Commune and postcode without département.
		out = { raw: `${loc} ${pc}`, components: { locality: loc, postcode: pc }, order: "commune-pc" }
	}

	// Add an explicit France suffix to a subset of rows to retain country-token examples.
	if (random() < APPEND_COUNTRY_SHARE) {
		out = {
			raw: `${out.raw}, France`,
			components: { ...out.components, country: "France" },
			order: `${out.order}+fr`,
		}
	}

	return out
}

/**
 * Recipe registered with the corpus builder.
 */
export const frAdminSplitRecipe: CorpusRecipe = {
	name: "fr-admin-split",
	description: "FR admin-split rows: BAN communes → split département into `region` (+ canonical-FR preservation)",
	mode: "generate",
	options: [
		{ flag: "--communes <tsv>", description: "BAN commune+postcode+coord TSV. Default /tmp/reg/fr-communes.tsv" },
	],
	async run(opts, write) {
		// Preserve the legacy generator and seed behavior.
		const random = makeMulberry32(opts.seed)
		const count = opts.count ?? 60_000
		const source = opts.sourceName ?? "synth-fr-admin-split"
		const communesPath = opts.communes ?? DEFAULT_COMMUNES

		const pool = await readCommunes(communesPath)

		console.error(`  ${communesPath}: ${pool.length} communes with derived département`)

		if (!pool.length) {
			throw new Error("No communes — build the TSV from BAN first (see the recipe header).")
		}

		let emitted = 0
		let skipped = 0
		let guard = 0
		const orderCounts: Record<string, number> = {}
		const N = pool.length

		while (emitted < count && guard++ < count * 12) {
			const base = pool[Math.floor(random() * N)]!
			const { raw, components, order } = render(random, base)

			// Ensure every component appears verbatim in the rendered address.
			const values = Object.values(components).filter((v): v is string => Boolean(v))

			if (!values.every((v) => raw.includes(v))) {
				skipped++

				continue
			}

			if (opts.golden) {
				// Golden rows include the source coordinates.
				write(stringifyJSON({ raw, components, country: "FR", lat: Number(base.lat), lon: Number(base.lon) }))

				emitted++
				orderCounts[order] = (orderCounts[order] ?? 0) + 1

				continue
			}

			const sourceID = stableSourceID(source, {
				locality: components.locality,
				region: components.region,
				postcode: components.postcode,
			})

			const canonical: CanonicalRow = {
				raw,
				components,
				country: "FR",
				locale: "fr-FR",
				source,
				source_id: sourceID,
				corpus_version: "0.5.0",
				license: LICENSE,
			}

			const aligned = alignRow(canonical)

			if (aligned.kind !== "labeled" || !aligned.row) {
				skipped++

				continue
			}

			write(
				stringifyJSON({
					...aligned.row,
					recipe: "fr-admin-split",
					order,
					base_source_id: null,
					register: SourceRegister.BaseAdresseNationale,
					surface: SurfaceOrigin.Composed,
				})
			)

			emitted++
			orderCounts[order] = (orderCounts[order] ?? 0) + 1
		}

		console.error(`  emitted=${emitted} skipped=${skipped} order-mix=${stringifyJSON(orderCounts)}`)

		return { emitted, skipped }
	},
}
