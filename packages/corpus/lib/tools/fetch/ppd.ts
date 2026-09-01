import { openReadStream, openWriteStream } from "@mailwoman/core/fs/streams"
import { runIfScript } from "@mailwoman/core/scripting"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { dataRootPath } from "@mailwoman/core/utils"
import { resolvePath } from "path-ts"
import { CSVSpliterator } from "spliterator"

import { titleCaseGB } from "#tools/gb-title-case"

const HOUSE_NUMBER_PATTERN = /^\d+[A-Za-z]?(\s*-\s*\d+[A-Za-z]?)?$/

export interface PPDExtractStats {
	kept: number
	skippedSAON: number
	skippedPAON: number
	skippedNoStreet: number
	skippedNoPostcode: number
}

const quote = (value: string): string => (value ? `"${value.replaceAll('"', '""')}"` : "")

/**
 * Convert PPD rows (`id,price,date,postcode,type,new,tenure,PAON,SAON,street,locality,town,district,county,cat,status`
 * — headerless) into OA-shaped tuple lines via `write`, applying the skip rules + title-casing. Accepts a plain array
 * of rows (tests) or a streamed async source (the real 31M-row extraction).
 */
export async function extractPPDTuples(
	input: AsyncIterable<string[]> | Iterable<string[]>,
	write: (line: string) => void
): Promise<PPDExtractStats> {
	const stats: PPDExtractStats = { kept: 0, skippedSAON: 0, skippedPAON: 0, skippedNoStreet: 0, skippedNoPostcode: 0 }
	write("NUMBER,STREET,CITY,DISTRICT,REGION,POSTCODE")

	for await (const cells of input) {
		// HM Land Registry Price Paid Data column order (see the PPD FAQ for the full field list).
		const postcode = cells[3]
		const paon = cells[7]
		const saon = cells[8]
		const street = cells[9]
		const locality = cells[10]
		const town = cells[11]
		const county = cells[13]

		if (saon) {
			stats.skippedSAON++

			continue
		}

		if (!paon || !HOUSE_NUMBER_PATTERN.test(paon)) {
			stats.skippedPAON++

			continue
		}

		if (!street) {
			stats.skippedNoStreet++

			continue
		}

		if (!postcode) {
			stats.skippedNoPostcode++

			continue
		}

		const number = paon.replace(/\s*-\s*/, "-")
		const city = locality && locality !== town ? titleCaseGB(locality) : ""

		write(
			[
				number,
				quote(titleCaseGB(street)),
				quote(city),
				quote(titleCaseGB(town ?? "")),
				quote(titleCaseGB(county ?? "")),
				postcode,
			].join(",")
		)

		stats.kept++
	}

	return stats
}

/**
 * Stream `inputPath` (PPD CSV) → `outputPath` (OA-shaped tuples CSV), returning the row-count stats.
 */
async function runPPDExtract(inputPath: string, outputPath: string): Promise<PPDExtractStats> {
	// No `encoding` — CSVSpliterator delimits raw bytes and decodes utf-8 itself (see readTuples in
	// shard-recipes/locale.ts). `header: false` yields every row as data — PPD ships no header row.
	const rows = CSVSpliterator.fromAsync<string[]>(openReadStream(inputPath), {
		mode: "array",
		header: false,
		enableQuoteHandling: true,
	})

	const out = openWriteStream(outputPath, { encoding: "utf8" })
	const stats = await extractPPDTuples(rows, (line) => out.write(line + "\n"))

	await new Promise<void>((res) => {
		out.end(res)
	})

	return stats
}

runIfScript(import.meta, async () => {
	const { values } = parseArguments({
		options: {
			input: { type: "string", default: resolvePath(dataRootPath("ppd", "2026-07-22", "pp-complete.csv")) },
			output: { type: "string", default: resolvePath(dataRootPath("ppd", "2026-07-22", "gb-tuples.csv")) },
		},
	})

	const stats = await runPPDExtract(values.input!, values.output!)

	console.log(`[ppd] ${JSON.stringify(stats)}`)
})
