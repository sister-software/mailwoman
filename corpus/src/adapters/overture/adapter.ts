/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `overture`: Overture Maps Addresses adapter (epic #470 — the gated corpus adapter, realized
 *   2026-06-20). Overture's global Addresses theme is the single-schema, well-normalized address
 *   dataset that fixes OpenAddresses' per-country patchiness (OA dropped Spain; OA-DE omits the
 *   Bundesland) — it even re-hosts the OA Spain data the standalone OA bucket no longer serves.
 *
 *   This adapter consumes a per-country LINE-DELIMITED JSON dump of the corpus-relevant fields (`{
 *   street, number, unit, postcode, locality }`), produced by `scripts/ingest-overture-addresses.ts
 *   --corpus-jsonl` (which does the DuckDB / S3 heavy lifting and flattens `address_levels` → the
 *   municipality locality). The split keeps `@mailwoman/corpus` — a RUNTIME dep of the `mailwoman`
 *   CLI — free of the heavy native `@duckdb/node-api`; the adapter just streams JSONL line-by-line,
 *   exactly like `openaddresses`.
 *
 *   The `street` surface carries the locale's street keyword verbatim (`"CALLE JULAN"`, `"VIA
 *   ROMA"`). We map it to `street` whole and let the downstream affix-relabel split `street_prefix`
 *   — the same path every other source rides. This shard exists because the model was
 *   en-us/fr-trained and never saw non-en/fr street formats (the 2026-06-19 EU parse-blocker
 *   measured loc-correct ES 21% / IT 59% / NL 64% vs FR/US ~98%).
 *
 *   `--country` is REQUIRED (the JSONL is per-country and the rows omit a country field), matching
 *   `openaddresses`. License is Overture's CDLA-Permissive-2.0 (attribution; not share-alike).
 *
 *   | Field | ComponentTag | | --------- | ---------------------------------------------- | |
 *   `street` | `street` (keyword incl.; affix-relabel splits prefix) | | `number` | `house_number`
 *   (skipped when "S-N"/"S/N" = sin número) | | `unit` | `unit` (if non-empty) | | `postcode`|
 *   `postcode` | | `locality`| `locality` (Overture address_levels municipality, or postal_city) |
 */

import { TextSpliterator } from "spliterator"

import { stableSourceID } from "../../adapter.ts"
import { formatAddress, reconcileComponents } from "../../format.ts"
import type { AdapterOptions, CanonicalRow, CorpusAdapter } from "../../types.ts"

export const OVERTURE_ADAPTER_ID = "overture"
export const OVERTURE_DEFAULT_LICENSE = "CDLA-Permissive-2.0"

/** The flattened per-row shape emitted by `ingest-overture-addresses.ts --corpus-jsonl`. */
interface OvertureCorpusRow {
	street?: string
	number?: string
	unit?: string
	postcode?: string
	locality?: string
}

function parseLine(line: string): OvertureCorpusRow | null {
	const t = line.trim()

	if (!t || t.startsWith("#")) return null

	try {
		const o = JSON.parse(t)

		return o && typeof o === "object" ? (o as OvertureCorpusRow) : null
	} catch {
		return null
	}
}

export function createOvertureAdapter(): CorpusAdapter {
	return {
		id: OVERTURE_ADAPTER_ID,
		defaultLicense: OVERTURE_DEFAULT_LICENSE,
		description: "Overture Maps Addresses (global): per-country JSONL of street/number/postcode/locality.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (!opts.country) {
				throw new Error(
					"overture adapter: --country is required (the Overture JSONL is per-country and rows omit a country field)"
				)
			}
			const country = opts.country

			// TextSpliterator streams string lines (parseLine keeps tolerating blank/`#`/malformed
			// lines by returning null); the path string lets the lib own + dispose the file handle,
			// including on an early `break`.
			const lines = TextSpliterator.fromAsync(opts.inputPath)

			let emitted = 0

			for await (const line of lines) {
				if (opts.signal?.aborted) break

				if (opts.limit !== undefined && emitted >= opts.limit) break

				const r = parseLine(line)

				if (!r) continue

				const street = r.street?.trim() ?? ""
				const number = r.number?.trim() ?? ""
				const unit = r.unit?.trim() ?? ""
				const postcode = r.postcode?.trim() ?? ""
				const locality = r.locality?.trim() ?? ""

				// Only useful with a street + (postcode OR locality); point-only rows quarantine anyway.
				if (!street) continue

				if (!postcode && !locality) continue

				const components: CanonicalRow["components"] = {}

				// Overture "S-N" / "S/N" = sin número; only keep a real numeric house number.
				if (/^\d/.test(number)) {
					components.house_number = number
				}
				components.street = street

				if (unit) {
					components.unit = unit
				}

				if (postcode) {
					components.postcode = postcode
				}

				if (locality) {
					components.locality = locality
				}

				const raw = formatAddress(components, country, { separator: ", " })

				if (!raw) continue

				const aligned = reconcileComponents(components, raw)

				if (Object.keys(aligned).length === 0) continue

				yield {
					raw,
					components: aligned,
					country,
					source: OVERTURE_ADAPTER_ID,
					source_id: stableSourceID(OVERTURE_ADAPTER_ID, aligned),
					corpus_version: "",
					license: OVERTURE_DEFAULT_LICENSE,
				}
				emitted++
			}
		},
	}
}

export const overtureAdapter = createOvertureAdapter()
