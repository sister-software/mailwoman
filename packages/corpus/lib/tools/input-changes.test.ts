/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The input-change listing reports each WOF record committed or edited since the recorded commit.
 */

import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { gitSync } from "@mailwoman/core/git"
import type { PathBuilderLike } from "path-ts"
import { describe, expect, it } from "vitest"

import { rowToParquet } from "#parquet/schema"
import { writeParquetFile } from "#parquet/writers"
import { useScratchDir } from "#test-kit"
import { BaseCommitOrigin, listInputChanges, geojsonFileWOFID } from "#tools/input-changes"
import { type LabeledRow, SurfaceOrigin } from "#types"

const scratch = useScratchDir("input-changes")
const identity = ["-c", "user.name=t", "-c", "user.email=t@example.com"]

const row: LabeledRow = {
	raw: "Place 1",
	components: { locality: "Place 1" },
	country: "US",
	source: "wof-admin",
	source_id: "wof-admin-1",
	license: "CC0-1.0",
	register: "whos-on-first",
	surface: SurfaceOrigin.Rendered,
	tokens: ["Place", "1"],
	labels: ["B-locality", "I-locality"],
	span_starts: [0],
	span_ends: [7],
	span_tags: ["locality"],
}

const commit = (cwd: PathBuilderLike, message: string) => {
	gitSync(["add", "."], { cwd })
	gitSync([...identity, "commit", "--quiet", "--no-gpg-sign", "-m", message], { cwd })

	return gitSync(["rev-parse", "HEAD"], { cwd })
}

/**
 * A checkout with two WOF records, a corpus file whose record stores the
 * checkout's first commit, and its manifest.
 */
async function fixture(recordCommits: boolean) {
	const root = scratch.path("wof-repos")
	const cwd = scratch.path("wof-repos", "whosonfirst-data-admin-us")

	await writeLocalJSONFile({ id: 85_633_793 }, cwd, "data/856/337/93/85633793.geojson")
	await writeLocalJSONFile({ id: 85_688_637 }, cwd, "data/856/886/37/85688637.geojson")
	gitSync(["init", "--quiet"], { cwd })

	const base = commit(cwd, "fixture")
	const parquet = scratch.path("corpus", "wof-admin-00000.parquet")

	await writeParquetFile([rowToParquet(row)], parquet, {
		extractHash: "fixture",
		codeHash: "fixture",
		config: {},
		...(recordCommits
			? {
					inputRevisions: { "whosonfirst-data-admin-us": base },
					inputUncommittedFiles: { "whosonfirst-data-admin-us": 0 },
				}
			: {}),
	})

	const manifestPath = scratch.path("corpus", "MANIFEST.json")

	await writeLocalJSONFile({ files: [{ path: parquet.toString(), source: "wof-admin" }] }, manifestPath)

	await writeLocalJSONFile({ id: 85_633_793, edited: true }, cwd, "data/856/337/93/85633793.geojson")

	const head = commit(cwd, "edit 85633793")

	await writeLocalJSONFile({ id: 85_688_637, edited: true }, cwd, "data/856/886/37/85688637.geojson")

	return { root, manifestPath, base, head }
}

describe("listInputChanges", () => {
	it("lists the records committed since the recorded commit and those edited since", async () => {
		const { root, manifestPath, base, head } = await fixture(true)

		const result = await listInputChanges({ manifestPath, source: "wof-admin", inputRoot: root })

		expect(result.origin).toBe(BaseCommitOrigin.Recorded)

		expect(result.checkouts).toEqual([
			{
				checkout: "whosonfirst-data-admin-us",
				base,
				origin: BaseCommitOrigin.Recorded,
				head,
				uncommittedAtBuild: 0,
				changed: [
					{
						checkout: "whosonfirst-data-admin-us",
						path: "data/856/337/93/85633793.geojson",
						change: "committed",
						wofID: 85_633_793,
					},
					{
						checkout: "whosonfirst-data-admin-us",
						path: "data/856/886/37/85688637.geojson",
						change: "uncommitted",
						wofID: 85_688_637,
					},
				],
			},
		])
	})

	it("refuses records that store no commits unless the read time is given", async () => {
		const { root, manifestPath } = await fixture(false)

		await expect(listInputChanges({ manifestPath, source: "wof-admin", inputRoot: root })).rejects.toThrow(
			/store no commits; pass the time/u
		)

		const result = await listInputChanges({
			manifestPath,
			source: "wof-admin",
			inputRoot: root,
			at: "2999-01-01",
		})

		expect(result.origin).toBe(BaseCommitOrigin.LastBeforeAt)
		expect(result.checkouts[0]!.changed.map((file) => file.change)).toEqual(["uncommitted"])
	})

	it("refuses a source the manifest lists no file of", async () => {
		const { root, manifestPath } = await fixture(true)

		await expect(listInputChanges({ manifestPath, source: "ban", inputRoot: root })).rejects.toThrow(/lists no ban/u)
	})
})

describe("geojsonFileWOFID", () => {
	it("reads the id of a record and of its alternate geometry, and returns null for other files", () => {
		expect(geojsonFileWOFID("data/856/333/45/85633345.geojson")).toBe(85_633_345)
		expect(geojsonFileWOFID("data/856/333/45/85633345-alt-quattroshapes.geojson")).toBe(85_633_345)
		expect(geojsonFileWOFID("LICENSE.md")).toBeNull()
	})
})
