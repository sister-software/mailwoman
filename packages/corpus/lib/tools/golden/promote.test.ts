/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { promoteGolden } from "@mailwoman/corpus/tools"
import { expect, it } from "vitest"

it("counts streamed candidates while filtering them", async () => {
	await using scratch = await temporaryDirectory("mw-golden-promote-")
	const input = scratch.path("candidates.jsonl")
	const report: string[] = []

	await writeLocalTextFile(
		[
			'{"raw":"1 Main Street, Paris","components":{"house_number":"1","street":"Main Street","locality":"Paris"},"country":"FR","source":"golden"}',
			'{"raw":"2 High Street, London","components":{"house_number":"2","street":"High Street","locality":"London"},"country":"GB","source":"golden"}',
			'{"raw":"1 MAIN STREET, PARIS","components":{"house_number":"1","street":"Main Street","locality":"Paris"},"country":"FR","source":"golden"}',
			"",
		].join("\n"),
		input
	)

	const stats = await promoteGolden(
		{ input: input.toString(), bumpTo: "v0.1.1", prior: "none", goldenRoot: scratch.path.toString(), dryRun: true },
		(line) => report.push(line)
	)

	expect(stats).toMatchObject({ candidatesIn: 3, kept: 2, filteredOut: { duplicate: 1 } })
	expect(report).toContain("  3 candidates loaded")
})
