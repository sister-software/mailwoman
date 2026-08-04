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

import { CSVSpliterator } from "spliterator"

import { splitStreetLine, stableSourceID } from "../../adapter.ts"
import { reconcileComponents } from "../../format.ts"
import type { AdapterOptions, CanonicalRow, CorpusAdapter } from "../../types.ts"

/**
 * Registry id for this adapter. Stamped into every row it emits, so a corpus record can be traced back to the dataset
 * it came from.
 */
export const USGOV_IRS_BMF_ADAPTER_ID = "usgov-irs-bmf"
/**
 * License carried by this source (Public Domain), attached to each row so downstream consumers inherit the terms rather
 * than having to look them up.
 */
export const USGOV_IRS_BMF_DEFAULT_LICENSE = "Public Domain"

/**
 * PO box in its many written forms: "PO BOX 12", "P.O. BOX 12", "P O BOX 12", "POB 12", "BOX 12".
 */
const PO_BOX = /^\s*(?:P\.?\s?O\.?\s*BOX|POB|BOX)\s+\w/i

interface IrsBmfRow {
	EIN: string
	NAME: string
	STREET: string
	CITY: string
	STATE: string
	ZIP: string
}

/**
 * Classify the street line into a `po_box` or a `{house_number?, street}` split.
 *
 * BMF mixes street addresses and PO boxes in one `STREET` column, so the PO-box shapes have to be claimed BEFORE the
 * shared house-number split runs — otherwise `splitStreetLine` would hand back `"PO Box 1234"` as a plain street, which
 * is correct for every other US adapter and wrong here.
 */
function splitStreetLineOrPOBox(street: string): { po_box: string } | { house_number?: string; street: string } | null {
	const trimmed = street.trim()

	if (PO_BOX.test(trimmed)) return { po_box: trimmed }

	return splitStreetLine(trimmed)
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

			const rows = CSVSpliterator.fromAsync(opts.inputPath, {
				mode: "object",
				normalizeKeys: false,
				enableQuoteHandling: true,
			})

			let emitted = 0

			for await (const record of rows as AsyncIterable<IrsBmfRow>) {
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

				const split = splitStreetLineOrPOBox(street)

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

				const sourceID = ein ? `${USGOV_IRS_BMF_ADAPTER_ID}-${ein}` : stableSourceID(USGOV_IRS_BMF_ADAPTER_ID, aligned)

				yield {
					raw,
					components: aligned,
					country: "US",
					locale: "en-US",
					source: USGOV_IRS_BMF_ADAPTER_ID,
					source_id: sourceID,
					corpus_version: "",
					license: USGOV_IRS_BMF_DEFAULT_LICENSE,
				}

				emitted++
			}
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const usgovIrsBmfAdapter = createUsgovIrsBmfAdapter()
