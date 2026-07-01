/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `ban`: Base Adresse Nationale CSV adapter (FR street-level).
 *
 *   Input: a CSV dump from `adresse.data.gouv.fr` (semicolon-separated, ~25M rows nationally). The
 *   adapter only reads the small set of columns needed for the corpus:
 *
 *   - `numero` → `house_number`
 *   - `rep` → repetition index ("bis", "ter") appended to house_number
 *   - `nom_voie` → `street` (full road name; includes the prefix "Rue", "Avenue", etc.)
 *   - `code_postal` → `postcode`
 *   - `nom_commune` → `locality`
 *
 *   `region` and `country` are not in BAN. The adapter stamps `country: "FR"` on every row; region is
 *   left for the wof-postalcode + wof-admin cross-reference at corpus build time (a future pass;
 *   for Phase 1 the row's region is simply absent).
 *
 *   License: the official BAN (adresse.data.gouv.fr) is DUAL-licensed — Licence Ouverte 2.0 (Etalab,
 *   attribution-only) OR ODbL (share-alike). We ELECT Licence Ouverte 2.0 (issue #26 Tier B:
 *   allowed for training with attribution; the ODbL option's share-alike obligation would defeat
 *   the proprietary-weights goal). Stamped onto every row as `Licence Ouverte 2.0` — NOT the older
 *   conservative `ODbL-1.0` label, which wrongly read as Tier-C-denied in the corpus license audit.
 *   The model card MUST carry the BAN attribution (Tier B obligation).
 *
 *   The adapter is streaming-aware: it uses `csv-parse` in streaming mode so a 25M-row dump never
 *   sits in memory. Honors `opts.limit` for fixture / smoke runs, `opts.signal` for cancellation,
 *   and `opts.country` for a self-consistency check (errors if country !== FR).
 */

import { createReadStream } from "node:fs"

import { parse as csvParse } from "csv-parse"

import { stableSourceID } from "../../adapter.js"
import { reconcileComponents } from "../../format.js"
import type { AdapterOptions, CanonicalRow, CorpusAdapter } from "../../types.js"
import { decomposeFrStreet } from "./street-decompose.js"

export const BAN_ADAPTER_ID = "ban"

/**
 * Subset of BAN CSV columns the adapter consults. Everything else is ignored; declaring the shape explicitly catches
 * column-name drift early if BAN evolves its schema.
 */
interface BanRow {
	id: string
	numero: string
	rep: string
	nom_voie: string
	code_postal: string
	nom_commune: string
}

/**
 * Compose `house_number` from `numero` + `rep`. BAN uses `rep` for repetition indices ("bis", "ter", "quater") that
 * follow the house number. Result: `"10 bis"`, `"45"`, etc.
 */
function composeHouseNumber(numero: string, rep: string): string {
	const n = numero.trim()
	const r = rep.trim()

	if (!n) return ""

	return r ? `${n} ${r}` : n
}

/**
 * Compose the raw FR-style address line. Two common BAN-derived shapes:
 *
 * "10 bis Avenue des Champs-Élysées, 75008 Paris" "45 Cours Lafayette, 69003 Lyon"
 *
 * FR convention puts postcode on the same line as the locality, comma-separated from the street. The adapter renders
 * that directly rather than relying on OpenCage's template — BAN already gives us the canonical FR strings; the
 * template would round-trip identically.
 */
function composeRaw(house: string, street: string, postcode: string, locality: string): string {
	const parts: string[] = []
	const streetPart = [house, street].filter(Boolean).join(" ").trim()

	if (streetPart) parts.push(streetPart)
	const cityPart = [postcode, locality].filter(Boolean).join(" ").trim()

	if (cityPart) parts.push(cityPart)

	return parts.join(", ").replace(/\s+/g, " ").trim()
}

export function createBanAdapter(): CorpusAdapter {
	return {
		id: BAN_ADAPTER_ID,
		defaultLicense: "Licence Ouverte 2.0",
		description: "Base Adresse Nationale (FR): house-number-level street addresses (~25M rows).",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && opts.country !== "FR") {
				throw new Error(`ban adapter: only FR supported, got country=${opts.country}`)
			}

			const stream = createReadStream(opts.inputPath, { encoding: "utf8" })
			const parser = stream.pipe(
				csvParse({
					delimiter: ";",
					columns: true,
					skip_empty_lines: true,
					relax_quotes: true,
					relax_column_count: true,
				})
			)

			let emitted = 0

			try {
				for await (const record of parser as AsyncIterable<BanRow>) {
					if (opts.signal?.aborted) break

					if (opts.limit !== undefined && emitted >= opts.limit) break

					const house = composeHouseNumber(record.numero ?? "", record.rep ?? "")
					const street = (record.nom_voie ?? "").trim()
					const postcode = (record.code_postal ?? "").trim()
					const locality = (record.nom_commune ?? "").trim()

					if (!street || !locality) continue

					if (!house && !postcode) continue

					const decomposed = decomposeFrStreet(street)

					const components: CanonicalRow["components"] = {}

					if (house) components.house_number = house

					if (decomposed.prefix) components.street_prefix = decomposed.prefix

					if (decomposed.street) components.street = decomposed.street

					if (postcode) components.postcode = postcode

					if (locality) components.locality = locality

					const raw = composeRaw(house, street, postcode, locality)

					if (!raw) continue

					const aligned = reconcileComponents(components, raw)

					if (Object.keys(aligned).length === 0) continue

					const sourceID = record.id?.trim()
						? `${BAN_ADAPTER_ID}-${record.id.trim()}`
						: stableSourceID(BAN_ADAPTER_ID, aligned)

					yield {
						raw,
						components: aligned,
						country: "FR",
						locale: "fr-FR",
						source: BAN_ADAPTER_ID,
						source_id: sourceID,
						corpus_version: "",
						license: "Licence Ouverte 2.0",
					}
					emitted++
				}
			} finally {
				stream.destroy()
			}
		},
	}
}

export const banAdapter = createBanAdapter()
