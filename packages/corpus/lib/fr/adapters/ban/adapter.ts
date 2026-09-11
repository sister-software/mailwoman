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
 *   The adapter is streaming-aware: `CSVSpliterator.fromAsync` reads the `;`-delimited dump row by
 *   row, so a 25M-row file never sits in memory. Honors `opts.limit` for fixture / smoke runs,
 *   `opts.signal` for cancellation, and `opts.country` for a self-consistency check (errors if
 *   country !== FR).
 */

import { formatAddressRow } from "@mailwoman/codex/address-format"
import { CSVSpliterator } from "spliterator"

import { stableSourceID } from "#adapters/utils"
import { decomposeFrStreet } from "#fr/adapters/ban/street-decompose"
import type { AdapterOptions, CanonicalRow, CorpusAdapter } from "#types"

/**
 * Registry id for this adapter. Stamped into every row it emits, so a corpus record can be traced back to the dataset
 * it came from.
 */
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

export function createBanAdapter(): CorpusAdapter {
	return {
		id: BAN_ADAPTER_ID,
		defaultLicense: "Licence Ouverte 2.0",
		description: "Base Adresse Nationale (FR): house-number-level street addresses (~25M rows).",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && opts.country !== "FR") {
				throw new Error(`ban adapter: only FR supported, got country=${opts.country}`)
			}

			const rows = CSVSpliterator.fromAsync(opts.inputPath, {
				normalizeKeys: false,
				columnDelimiter: ";",
			})

			let emitted = 0

			for await (const record of rows as AsyncIterable<BanRow>) {
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

				if (house) {
					components.house_number = house
				}

				if (decomposed.prefix) {
					components.street_prefix = decomposed.prefix
				}

				if (decomposed.street) {
					components.street = decomposed.street
				}

				if (postcode) {
					components.postcode = postcode
				}

				if (locality) {
					components.locality = locality
				}

				const rendered = formatAddressRow(components, "FR", { singleLine: true })

				if (!rendered) continue

				const { raw, components: aligned } = rendered

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
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const banAdapter = createBanAdapter()
