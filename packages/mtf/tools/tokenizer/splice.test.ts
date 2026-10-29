/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The splice code point overlap check. "Identical by construction" holds for ASCII text only: French, German
 *   and Spanish share code points with spliced pieces, so the check must report each locale's overlap, refuse an
 *   overlap nobody accepted, and pass when the overlap is absent or accepted.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalBuffer, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { describe, expect, it } from "vitest"

import { checkCodepointOverlap, collectSampleCodepoints, type OverlapReport } from "./splice.ts"

async function samples(directory: { path: (...segments: string[]) => { toString(): string } }) {
	const fr = directory.path("fr.jsonl").toString()
	const us = directory.path("us.jsonl").toString()

	await writeLocalTextFile('{"raw": "12 Rue de la Lozère, Paris"}\n', fr)
	await writeLocalTextFile('{"raw": "350 Fifth Avenue, New York, NY 10118"}\n', us)

	return { fr, us }
}

describe("collectSampleCodepoints", () => {
	it("keeps only code points outside ASCII", async () => {
		await using scratch = await temporaryDirectory("splice-")
		const { fr, us } = await samples(scratch)

		expect(await collectSampleCodepoints(us)).toEqual(new Set())
		expect(await collectSampleCodepoints(fr)).toContain("è")
	})

	it("drops a character split by the byte cap", async () => {
		await using scratch = await temporaryDirectory("splice-")
		const path = scratch.path("split.txt").toString()

		await writeLocalBuffer(Buffer.from("aé", "utf8"), path)

		expect(await collectSampleCodepoints(path, 2)).toEqual(new Set())
	})
})

describe("checkCodepointOverlap", () => {
	it("passes and reports empty overlaps when the pieces are disjoint", async () => {
		await using scratch = await temporaryDirectory("splice-")
		const report = scratch.path("report.json").toString()

		expect(await checkCodepointOverlap(["▁Grudzi", "ądz", "ż"], await samples(scratch), report)).toEqual({
			fr: [],
			us: [],
		})

		expect((await readLocalJSONFile<OverlapReport>(report)).per_locale_overlap).toEqual({ fr: [], us: [] })
	})

	it("refuses an overlap no locale accepted, after writing the report", async () => {
		await using scratch = await temporaryDirectory("splice-")
		const report = scratch.path("report.json").toString()

		await expect(checkCodepointOverlap(["▁Lozère", "è"], await samples(scratch), report)).rejects.toThrow(/\bfr\b/)
		expect((await readLocalJSONFile<OverlapReport>(report)).per_locale_overlap["fr"]).toEqual(["è"])
	})

	it("passes an accepted overlap and records the acceptance", async () => {
		await using scratch = await temporaryDirectory("splice-")
		const report = scratch.path("report.json").toString()
		const result = await checkCodepointOverlap(["▁Lozère", "è"], await samples(scratch), report, new Set(["fr"]))

		expect(result["fr"]).toEqual(["è"])
		expect((await readLocalJSONFile<OverlapReport>(report)).accepted_overlap).toEqual(["fr"])
	})
})
