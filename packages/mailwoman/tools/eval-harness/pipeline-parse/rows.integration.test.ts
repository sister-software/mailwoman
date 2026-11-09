/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { walkNodes } from "@mailwoman/core/decoder"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { describe, expect, it } from "vitest"

import { createRuntimePipeline } from "#runtime-pipeline"
import { parsePipelineRows } from "#tools/eval-harness/pipeline-parse/rows"

const ROWS = [
	"206 Saint Clair Street, Fort Recovery, OH 45846",
	"1977 Terrier Avenue, Suite 100, Virginia Beach, VA 23461",
	"555 calle munoz rivera caguas pr 00725",
	"102 water street red cliff co 81649",
	"326 Roosevelt Trail\nSouth Casco, ME 04077",
	"Oberwiesen 8, FL-9485 Nendeln",
].map((raw, index) => ({ id: `row-${index}`, raw, localeHint: index % 2 ? "US" : null }))

describe("parsePipelineRows", () => {
	it("returns the parse one in-process pipeline returns for every row, in input order", async () => {
		const pooled = await parsePipelineRows(ROWS, { workers: 2 })

		const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
		const parse = createRuntimePipeline({ classifier })

		const direct = []

		for (const row of ROWS) {
			const result = await parse(row.raw, row.localeHint ? { localeHint: row.localeHint } : {})

			direct.push(
				[...walkNodes(result.tree?.roots ?? [])]
					.map((node) => [node.tag, node.start, node.end, node.value])
					.toSorted((a, b) => (a[1] as number) - (b[1] as number))
			)
		}

		expect(pooled.map((entry) => entry.id)).toEqual(ROWS.map((row) => row.id))
		expect(pooled.map((entry) => entry.spans)).toEqual(direct)
	}, 120_000)

	it("refuses a worker count whose memory exceeds half the host", async () => {
		await expect(parsePipelineRows(ROWS, { workers: 10_000 })).rejects.toThrow(/more than half of this host/)
	})
})
