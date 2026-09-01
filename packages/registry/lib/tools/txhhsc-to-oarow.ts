/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #619: convert the TX HHSC nursing-facilities source (which ships an authoritative `Geo Location`
 *   = `lat,lon` per facility) into the OaRow JSONL the resolver eval consumes — so our geocoder can
 *   be graded against the provided coordinates on real facility addresses (great-circle delta, tier
 *   breakdown via `oa-resolver-eval --address-points`).
 *
 *   Neutral scope: this measures GEOCODER ACCURACY on real public addresses; it makes no claim about
 *   the facilities themselves.
 *
 *   Run: `mailwoman registry convert tx-hhsc [--src <tsv>] [--out /tmp/txhhsc-oarow.jsonl]`
 */

import { dataRootPath, tempRootPath } from "@mailwoman/core/data-root"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { TSVSpliterator } from "spliterator"

import { inTXBBOX } from "#tools/shared"

/**
 * Options for {@linkcode convertTXHHSC}.
 */
export interface TXHHSCConvertOptions {
	/**
	 * The TX HHSC nursing-facilities TSV. Default `$MAILWOMAN_DATA_ROOT/record-matcher/sources/…`.
	 */
	src?: string
	/**
	 * Output OaRow JSONL path. Default `/tmp/txhhsc-oarow.jsonl`.
	 */
	out?: string
}

const GEO = /^\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*$/

/**
 * Convert the TX HHSC nursing-facilities TSV into OaRow JSONL for `oa-resolver-eval`.
 */
export async function convertTXHHSC(
	options: TXHHSCConvertOptions = {},
	report?: (line: string) => void
): Promise<{ written: number; skipped: number; out: string }> {
	const src = options.src || String(dataRootPath("record-matcher", "sources", "txhhsc_nursing-facilities_20260611.tsv"))
	const out = options.out || tempRootPath("txhhsc-oarow.jsonl")

	const records: string[] = []
	let skipped = 0

	// Column indices, captured from the first non-blank row. `header: false` keeps that row in the stream so the
	// blank-row guard below applies to it too.
	let cAddr = -1
	let cCity = -1
	let cZip = -1
	let cGeo = -1
	let sawHeader = false

	for (const f of TSVSpliterator.from(await readLocalTextFile(src), { header: false })) {
		if (f.every((value) => !value.trim())) continue

		if (!sawHeader) {
			sawHeader = true
			const col = (name: string) => f.indexOf(name)
			cAddr = col("Physical Address")
			cCity = col("Physical Address CITY")
			cZip = col("Physical Address Zipcode")
			cGeo = col("Geo Location")

			continue
		}

		const addr = (f[cAddr] ?? "").trim()
		const city = (f[cCity] ?? "").trim()
		const zip = (f[cZip] ?? "").trim()
		const m = GEO.exec(f[cGeo] ?? "")

		if (!addr || !city || !m) {
			skipped++

			continue
		}

		const lat = Number(m[1])
		const lon = Number(m[2])

		// Sanity: TX bounding box (rejects swapped/garbage coords).
		if (!inTXBBOX(lat, lon)) {
			skipped++

			continue
		}

		records.push(
			JSON.stringify({
				input: `${addr}, ${city}, TX ${zip}`,
				lat,
				lon,
				expected: { locality: city, region: "TX", postcode: zip },
				state: "TX",
				source: "txhhsc:nursing-facilities",
			})
		)
	}

	await writeLocalTextFile(records.join("\n") + "\n", out)
	report?.(`wrote ${records.length} rows (skipped ${skipped}) → ${out}`)

	return { written: records.length, skipped, out }
}
