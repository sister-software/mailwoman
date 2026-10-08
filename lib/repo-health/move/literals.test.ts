/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { realPath } from "@mailwoman/core/fs/readers/stat"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { createSymbolicLink, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { resolvePath } from "path-ts"
import { expect, test } from "vitest"

import { directoryMoves, planPathLiteralRewrites } from "#repo-health/move/literals"

test("plans a moved file's own literals before the move is applied, naming its destination", async () => {
	await using directory = await temporaryDirectory("move-literals-")
	const repoRoot = await realPath(directory.path)

	await writeLocalTextFile(
		"Usage: node packages/x/lib/probe.run.ts\n",
		resolvePath(repoRoot, "packages/x/lib/probe.run.ts")
	)

	const rewrites = await planPathLiteralRewrites(
		repoRoot,
		["packages/x/lib/probe.run.ts"],
		[{ from: "packages/x/lib/probe.run.ts", to: "packages/x/tools/probe.run.ts" }]
	)

	expect(rewrites.map((rewrite) => `${rewrite.file}: ${rewrite.path} -> ${rewrite.replacement}`)).toEqual([
		"packages/x/tools/probe.run.ts: packages/x/lib/probe.run.ts -> packages/x/tools/probe.run.ts",
	])
})

test("infers a directory rename only when every file under the directory moves with it", () => {
	const tracked = [
		"p/lib/gauntlet/ablation/expectation.ts",
		"p/lib/gauntlet/ablation/scoring.ts",
		"p/lib/gauntlet/cases/load.ts",
	]

	const single = [{ from: "p/lib/gauntlet/ablation/expectation.ts", to: "p/lib/ablation/expectation.ts" }]

	expect(directoryMoves(single, tracked)).toEqual([])

	const whole = [
		{ from: "p/lib/gauntlet/ablation/expectation.ts", to: "p/lib/eval/ablation/expectation.ts" },
		{ from: "p/lib/gauntlet/ablation/scoring.ts", to: "p/lib/eval/ablation/scoring.ts" },
		{ from: "p/lib/gauntlet/cases/load.ts", to: "p/lib/eval/cases/load.ts" },
	]

	expect(directoryMoves(whole, tracked).toSorted((a, b) => a.from.localeCompare(b.from))).toEqual([
		{ from: "p/lib/gauntlet", to: "p/lib/eval" },
		{ from: "p/lib/gauntlet/ablation", to: "p/lib/eval/ablation" },
		{ from: "p/lib/gauntlet/cases", to: "p/lib/eval/cases" },
	])
})

test("finds a nested directory that moved whole when its root did not", () => {
	const tracked = ["p/lib/eval/cases/a.jsonl", "p/lib/eval/load.ts", "p/lib/index.ts"]

	const moves = [
		{ from: "p/lib/eval/cases/a.jsonl", to: "p/tools/eval/cases/a.jsonl" },
		{ from: "p/lib/eval/load.ts", to: "p/tools/eval/load.ts" },
	]

	expect(directoryMoves(moves, tracked).toSorted((a, b) => a.from.localeCompare(b.from))).toEqual([
		{ from: "p/lib/eval", to: "p/tools/eval" },
		{ from: "p/lib/eval/cases", to: "p/tools/eval/cases" },
	])
})

test("plans edits for a symlinked file once, under the path of the file it points at", async () => {
	await using directory = await temporaryDirectory("move-literals-")
	const repoRoot = await realPath(directory.path)

	await writeLocalTextFile("Run `node packages/x/lib/geocode/index.ts`.\n", resolvePath(repoRoot, "launch/AGENTS.md"))
	await createSymbolicLink(resolvePath(repoRoot, "launch/AGENTS.md"), resolvePath(repoRoot, "launch/CLAUDE.md"))

	const rewrites = await planPathLiteralRewrites(
		repoRoot,
		["launch/AGENTS.md", "launch/CLAUDE.md"],
		[{ from: "packages/x/lib/geocode/index.ts", to: "packages/x/lib/geocode.ts" }]
	)

	expect(rewrites.map((rewrite) => `${rewrite.file}: ${rewrite.path} -> ${rewrite.replacement}`)).toEqual([
		"launch/AGENTS.md: packages/x/lib/geocode/index.ts -> packages/x/lib/geocode.ts",
	])
})
