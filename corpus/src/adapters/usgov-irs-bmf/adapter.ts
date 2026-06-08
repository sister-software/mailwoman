/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `usgov-irs-bmf`: IRS Exempt Organizations Business Master File (EO BMF) CSV consumer.
 *
 *   The EO BMF is the IRS's authoritative registry of US tax-exempt organizations (charities,
 *   churches, foundations, ...), published as per-region CSVs at
 *   `https://www.irs.gov/charities-non-profits/exempt-organizations-business-master-file-extract-eo-bmf`
 *   (`eo1.csv`..`eo4.csv`, `eo_pr.csv`, `eo_xx.csv`). Each row carries an organization NAME plus
 *   its mailing address. It complements `usgov-nppes` with a DIFFERENT venue population
 *   (non-profits vs healthcare providers) and, notably, a high share of PO-box addresses — useful
 *   `po_box`-tag signal (a tag with historically low recall).
 *
 *   Output: one row per record with a usable city + postcode. NAME → `venue`; the street line becomes
 *   `po_box` when it's a PO-box, else `house_number` + `street`; CITY/STATE/ZIP fill the locality
 *   line. STATE is already a USPS abbreviation in the source. License: `"Public Domain"` (US
 *   federal).
 */

import { parse as csvParse } from "csv-parse"
import { createReadStream } from "node:fs"
import { stableSourceId } from "../../adapter.js"
import { reconcileComponents } from "../../format.js"
import type { AdapterOptions, CanonicalRow, CorpusAdapter } from "../../types.js"

export const USGOV_IRS_BMF_ADAPTER_ID = "usgov-irs-bmf"
export const USGOV_IRS_BMF_DEFAULT_LICENSE = "Public Domain"

const HOUSE_NUMBER_PREFIX = /^(\d+(?:-\d+)?[A-Za-z]?)\s+(.+)$/
// PO box in its many written forms: "PO BOX 12", "P.O. BOX 12", "P O BOX 12", "POB 12", "BOX 12".
const PO_BOX = /^\s*(?:P\.?\s?O\.?\s*BOX|POB|BOX)\s+\w/i

interface IrsBmfRow {
	EIN: string
	NAME: string
	STREET: string
	CITY: string
	STATE: string
	ZIP: string
}

/** Classify the street line into a `po_box` or a `{house_number?, street}` split. */
function splitStreetLine(street: string): { po_box: string } | { house_number?: string; street: string } | null {
	const trimmed = street.trim()
	if (!trimmed) return null
	if (PO_BOX.test(trimmed)) return { po_box: trimmed }
	const m = HOUSE_NUMBER_PREFIX.exec(trimmed)
	if (m) return { house_number: m[1], street: m[2]!.trim() }
	return { street: trimmed }
}

function composeRaw(
	venue: string | undefined,
	streetPart: string,
	city: string,
	state: string,
	postcode: string
): string {
	const cityPart = [city.trim(), [state, postcode].filter(Boolean).join(" ").trim()].filter(Boolean).join(", ")
	return [venue, streetPart, cityPart].filter(Boolean).join(", ")
}

export function createUsgovIrsBmfAdapter(): CorpusAdapter {
	return {
		id: USGOV_IRS_BMF_ADAPTER_ID,
		defaultLicense: USGOV_IRS_BMF_DEFAULT_LICENSE,
		description:
			"IRS Exempt Organizations Business Master File — US non-profit venue+address (public-domain), with strong PO-box coverage.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && opts.country !== "US") {
				throw new Error(`usgov-irs-bmf adapter: only US supported, got country=${opts.country}`)
			}

			const stream = createReadStream(opts.inputPath, { encoding: "utf8" })
			const parser = stream.pipe(
				csvParse({ columns: true, skip_empty_lines: true, relax_quotes: true, relax_column_count: true, trim: true })
			)

			let emitted = 0
			try {
				for await (const record of parser as AsyncIterable<IrsBmfRow>) {
					if (opts.signal?.aborted) break
					if (opts.limit !== undefined && emitted >= opts.limit) break

					const ein = (record.EIN ?? "").trim()
					const venue = (record.NAME ?? "").trim() || undefined
					const street = (record.STREET ?? "").trim()
					const city = (record.CITY ?? "").trim()
					const state = (record.STATE ?? "").trim()
					const zipRaw = (record.ZIP ?? "").trim()
					if (!city || !zipRaw) continue
					const postcode = zipRaw.split("-")[0]!.trim() // 5-digit; drop the optional +4

					const split = splitStreetLine(street)
					if (!split) continue

					const streetPart =
						"po_box" in split ? split.po_box : [split.house_number, split.street].filter(Boolean).join(" ")

					const components: CanonicalRow["components"] = {
						...(venue ? { venue } : {}),
						...("po_box" in split
							? { po_box: split.po_box }
							: { ...(split.house_number ? { house_number: split.house_number } : {}), street: split.street }),
						locality: city,
						...(state ? { region: state } : {}),
						postcode,
					}

					const raw = composeRaw(venue, streetPart, city, state, postcode)
					if (!raw) continue

					const aligned = reconcileComponents(components, raw)
					if (Object.keys(aligned).length <= 2) continue

					const sourceId = ein
						? `${USGOV_IRS_BMF_ADAPTER_ID}-${ein}`
						: stableSourceId(USGOV_IRS_BMF_ADAPTER_ID, aligned)

					yield {
						raw,
						components: aligned,
						country: "US",
						locale: "en-US",
						source: USGOV_IRS_BMF_ADAPTER_ID,
						source_id: sourceId,
						corpus_version: "",
						license: USGOV_IRS_BMF_DEFAULT_LICENSE,
					}
					emitted++
				}
			} finally {
				stream.destroy()
			}
		},
	}
}

export const usgovIrsBmfAdapter = createUsgovIrsBmfAdapter()
