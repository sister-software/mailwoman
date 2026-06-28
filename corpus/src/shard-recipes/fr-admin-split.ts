/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `fr-admin-split` shard recipe — the FR admin-split coverage shard (night 2026-06-19,
 *   surpass-v1.5.0). Teaches the model to SPLIT the département out of the locality on
 *   bare/space/comma-delimited French place rows — the admin-deciding failure class the pre-GPU
 *   self-validation proved moves the resolved coordinate (collision communes −61%; see
 *   docs/articles/evals/2026-06-19-fr-admin-split-prevalidation.md). Ported from
 *   scripts/build-fr-admin-split-shard.mjs.
 *
 *   Failure shapes (the model currently mis-handles all of these):
 *
 *   - `Thauron, Creuse` → région dropped to null (the comma+full-name miss)
 *   - `Montredon, Lozère` → région = "ère" (the diacritic subword split, #727)
 *   - (AU analog) `CANBERRA ACT` → the space-delimited admin fuse
 *
 *   The département is the essential admin unit for FR postal geography and maps to the `region`
 *   component tag in our schema. We derive it DETERMINISTICALLY from the real postcode via codex
 *   `departementForCodePostal` (first two digits = département) — salvage-first, no re-derived
 *   table.
 *
 *   Data (`--communes`, opts.communes): REAL BAN (Base Adresse Nationale) commune+postcode+coord
 *   tuples, one per line, TAB-separated `commune <TAB> postcode <TAB> lon <TAB> lat`. Build the
 *   input TSV once from the BAN staging CSV (see the legacy script header). Anchor-ON by
 *   construction: rows carry a REAL postcode token in `raw` + a `postcode` component, so the
 *   training loader paints the anchor feature onto that span automatically. The trailing-postcode
 *   anchor REINFORCES the FR split (FR postcode is trailing, unlike German PLZ-leading — the v0.9.2
 *   scar is positional, not universal).
 */

import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"

import { departementForCodePostal } from "@mailwoman/codex/fr"
import type { ComponentTag } from "@mailwoman/core/types"

import { stableSourceId } from "../adapter.js"
import { alignRow } from "../align.js"
import type { CanonicalRow } from "../types.js"
import { makeMulberry32, type ShardRecipe } from "./scaffold.js"

const DEFAULT_COMMUNES = "/tmp/reg/fr-communes.tsv"
const LICENSE = "BAN (Base Adresse Nationale) commune+postcode tuples, rendered admin-split — see ingest SOURCE"

/** One distinct commune row from the TSV, with the département derived from its postcode. */
interface CommuneRow {
	commune: string
	postcode: string
	departement: string
	lon: string | undefined
	lat: string | undefined
}

/** One rendered admin-split variant. */
interface AdminSplitVariant {
	raw: string
	components: Partial<Record<ComponentTag, string>>
	order: string
}

/** Read the distinct commune TSV (commune, postcode, lon, lat); derive the département name. */
async function readCommunes(path: string): Promise<CommuneRow[]> {
	const rows: CommuneRow[] = []
	const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity })

	for await (const line of rl) {
		if (!line) continue
		const [commune, postcode, lon, lat] = line.split("\t")

		if (!commune || !postcode) continue
		const dep = departementForCodePostal(postcode)

		if (!dep) continue // bad/unmappable postcode — skip (CEDEX, etc.)
		// Substring invariant: a département whose name isn't a clean token (none are) or a commune
		// containing the département name would confuse alignment — both are vanishingly rare here.
		rows.push({ commune, postcode, departement: dep.name, lon, lat })
	}

	return rows
}

/**
 * Render one admin-split variant. The CORE teaching signal: the département, even as a full word after a comma or a
 * space, is `region` — never folded into `locality`. Variants 1-3 are the failure class; 4-5 are canonical-FR
 * preservation so the model doesn't over-fire region on every trailing token (and the bare commune still resolves).
 */
function render(random: () => number, c: CommuneRow): AdminSplitVariant {
	const r = random()
	const loc = random() < 0.1 ? c.commune.toUpperCase() : c.commune
	const dep = c.departement
	const pc = c.postcode
	let out: AdminSplitVariant

	if (r < 0.25) {
		// 1. bare comma, NO postcode — the Thauron/#727 shape (anchor off)
		out = { raw: `${loc}, ${dep}`, components: { locality: loc, region: dep }, order: "bare-comma" }
	} else if (r < 0.5) {
		// 2. bare comma + postcode — anchor ON
		out = {
			raw: `${loc}, ${dep} ${pc}`,
			components: { locality: loc, region: dep, postcode: pc },
			order: "bare-comma-pc",
		}
	} else if (r < 0.7) {
		// 3. space-delimited admin (the AU `CANBERRA ACT` fuse applied to FR) — anchor ON
		out = { raw: `${loc} ${dep} ${pc}`, components: { locality: loc, region: dep, postcode: pc }, order: "space-pc" }
	} else if (r < 0.85) {
		// 4. canonical FR postcode-first (NO département) — preservation, anchor ON
		out = { raw: `${pc} ${loc}`, components: { postcode: pc, locality: loc }, order: "canonical-pc-first" }
	} else {
		// 5. commune + postcode (NO département) — preservation, anchor ON
		out = { raw: `${loc} ${pc}`, components: { locality: loc, postcode: pc }, order: "commune-pc" }
	}

	// fr.country preservation (the v1.8.0 #728 finding): the v1.8.0 shard's bare rows carried NO country
	// token, so the model under-emitted country on FR (fr.country −3.5pp). ~20% of rows now append an
	// explicit "France" + a `country` component — the model relearns to emit country WHEN the token is
	// present without over-firing it on the (still-majority) country-less rows. Substring invariant holds.
	if (random() < 0.2) {
		out = {
			raw: `${out.raw}, France`,
			components: { ...out.components, country: "France" },
			order: `${out.order}+fr`,
		}
	}

	return out
}

export const frAdminSplitRecipe: ShardRecipe = {
	name: "fr-admin-split",
	description: "FR admin-split rows: BAN communes → split département into `region` (+ canonical-FR preservation)",
	mode: "generate",
	options: [
		{ flag: "--communes <tsv>", description: "BAN commune+postcode+coord TSV. Default /tmp/reg/fr-communes.tsv" },
	],
	async run(opts, write) {
		// Legacy build-fr-admin-split-shard.mjs seeded `mulberry32(opts.seed)`.
		const random = makeMulberry32(opts.seed)
		const count = opts.count ?? 60000
		const source = opts.sourceName ?? "synth-fr-admin-split"
		const communesPath = opts.communes ?? DEFAULT_COMMUNES

		const pool = await readCommunes(communesPath)
		console.error(`  ${communesPath}: ${pool.length} communes with derived département`)

		if (pool.length === 0) {
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

			// Alignment precondition: every component surface appears verbatim in raw.
			const values = Object.values(components).filter((v): v is string => Boolean(v))

			if (!values.every((v) => raw.includes(v))) {
				skipped++
				continue
			}

			if (opts.golden) {
				// Held-out eval slice for the centroid gate — carries the truth coordinate.
				write(JSON.stringify({ raw, components, country: "FR", lat: Number(base.lat), lon: Number(base.lon) }) + "\n")
				emitted++
				orderCounts[order] = (orderCounts[order] ?? 0) + 1
				continue
			}

			const sourceId = stableSourceId(source, {
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
				source_id: sourceId,
				corpus_version: "0.5.0",
				license: LICENSE,
			}
			const aligned = alignRow(canonical)

			if (aligned.kind !== "labeled" || !aligned.row) {
				skipped++
				continue
			}
			write(
				JSON.stringify({ ...aligned.row, synth_method: "fr-admin-split", synth_order: order, synth_base_id: null }) +
					"\n"
			)
			emitted++
			orderCounts[order] = (orderCounts[order] ?? 0) + 1
		}

		console.error(`  emitted=${emitted} skipped=${skipped} order-mix=${JSON.stringify(orderCounts)}`)

		return { emitted, skipped }
	},
}
