/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Every fetch source declares the storage class of each directory it writes, and a snapshot fetch replaces a
 *   vintage on disk only when the command states that vintage and passes `--force`.
 */

import { assertVintage, currentSourcePath, snapshotSourcePath } from "@mailwoman/core/data-root"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { SnapshotExistsError } from "@mailwoman/core/fs/snapshot"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import type { PathBuilder } from "path-ts"
import { describe, expect, it } from "vitest"

import { FETCH_SOURCES } from "#tools/fetch"
import type { FetchSummary } from "#tools/fetch/download"
import {
	FETCH_SOURCE_DIRECTORIES,
	fetchSnapshot,
	resolveFetchDestinations,
	SOURCE_STORAGE_CLASSES,
	type SourceSlug,
	UNFETCHED_SNAPSHOT_VINTAGES,
} from "#tools/fetch/storage"

const FETCHED: FetchSummary = { fetched: 1, skipped: 0, failed: 0, failedCodes: [] }

/**
 * A fill that writes `text` as `data.txt`, standing for a download.
 */
function writes(text: string, summary: FetchSummary = FETCHED) {
	return async (directory: PathBuilder) => {
		await writeLocalFile(text, directory("data.txt"))

		return summary
	}
}

describe("the storage class table", () => {
	it("names the directories of every fetch source, and gives each directory a class", () => {
		expect(Object.keys(FETCH_SOURCE_DIRECTORIES).toSorted()).toEqual(Object.keys(FETCH_SOURCES).toSorted())

		const unclassified = Object.entries(FETCH_SOURCE_DIRECTORIES).flatMap(([source, slugs]) =>
			slugs.filter((slug) => !(slug in SOURCE_STORAGE_CLASSES)).map((slug) => `${source} → ${slug}`)
		)

		expect(unclassified).toEqual([])
	})

	it("dates every snapshot that no fetcher writes, because a cleared copy could not be fetched again", () => {
		const fetched = new Set<string>(Object.values(FETCH_SOURCE_DIRECTORIES).flat())

		const unfetchedSnapshots = (Object.keys(SOURCE_STORAGE_CLASSES) as SourceSlug[]).filter(
			(slug) => !fetched.has(slug)
		)

		expect(unfetchedSnapshots.filter((slug) => SOURCE_STORAGE_CLASSES[slug] !== "snapshot")).toEqual([])
		expect(Object.keys(UNFETCHED_SNAPSHOT_VINTAGES).toSorted()).toEqual(unfetchedSnapshots.toSorted())

		for (const vintage of Object.values(UNFETCHED_SNAPSHOT_VINTAGES)) {
			expect(() => assertVintage(vintage)).not.toThrow()
		}
	})
})

describe("resolveFetchDestinations", () => {
	it("writes a current source under the cache root and a snapshot under the data root's snapshots", () => {
		const current = resolveFetchDestinations("ban", {})
		const snapshot = resolveFetchDestinations("nppes", {})

		expect(String(current.outRoot("ban"))).toBe(String(currentSourcePath("ban")))

		expect(String(snapshot.snapshots.root("usgov-nppes", "2026-05"))).toBe(
			String(snapshotSourcePath("usgov-nppes", "2026-05"))
		)
	})

	it("refuses --vintage and --force for a current source, which has no vintage to name", () => {
		expect(() => resolveFetchDestinations("ban", { vintage: "2026-05" })).toThrow(/ban is a current source/)
		expect(() => resolveFetchDestinations("acra-sg", { force: true })).toThrow(/acra-sg is a current source/)
	})

	it("accepts --vintage for NAD, whose release Parquet is a snapshot beside its current archive", () => {
		expect(resolveFetchDestinations("nad", { vintage: "r24" }).snapshots.vintage).toBe("r24")
	})
})

describe("a snapshot fetch through the command's options", () => {
	it("refuses to replace a vintage on disk unless --vintage names it and --force is passed", async () => {
		await using scratch = await temporaryDirectory("mailwoman-fetch-storage-")
		const outRoot = scratch.path.toString()

		const run = (options: { vintage?: string; force?: boolean }, fill: ReturnType<typeof writes>) =>
			fetchSnapshot(
				resolveFetchDestinations("nppes", { outRoot, ...options }).snapshots,
				"usgov-nppes",
				"2026-05",
				fill
			)

		const vintage = scratch.path("usgov-nppes", "2026-05", "data.txt")

		await expect(run({}, writes("may"))).resolves.toEqual(FETCHED)

		// A re-run resolves the same vintage, and the publisher's own vintage is never replaced.
		await expect(run({}, writes("again"))).rejects.toThrow(SnapshotExistsError)
		await expect(run({ force: true }, writes("again"))).rejects.toThrow(/state the vintage with --vintage/)
		await expect(run({ vintage: "2026-05" }, writes("again"))).rejects.toThrow(/pass --force/)

		// A stated vintage the publisher doesn't serve would misdate the download.
		await expect(run({ vintage: "2026-04", force: true }, writes("april"))).rejects.toThrow(
			/serves vintage 2026-05, not the --vintage 2026-04/
		)

		expect(await readLocalTextFile(vintage)).toBe("may")

		// A forced fetch that reports a failure leaves the vintage as it was.
		const failed: FetchSummary = { fetched: 0, skipped: 0, failed: 1, failedCodes: ["npidata"] }

		await expect(run({ vintage: "2026-05", force: true }, writes("partial", failed))).resolves.toEqual(failed)
		expect(await readLocalTextFile(vintage)).toBe("may")

		await expect(run({ vintage: "2026-05", force: true }, writes("corrected"))).resolves.toEqual(FETCHED)
		expect(await readLocalTextFile(vintage)).toBe("corrected")
	})
})
