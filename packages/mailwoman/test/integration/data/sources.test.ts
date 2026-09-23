/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `mailwoman data sources` over planted databases: the four answers it has to keep apart, and the one it must
 *   never give.
 *
 *   The one it must never give is an empty census presented as a result. A bundle whose artifacts carry no publisher
 *   column, a bundle nobody has downloaded, and a bundle whose every stamp matches the record all print nothing under
 *   a naive reader, and only the last is a clean check. Each has its own status here.
 *
 *   The live case this was written for is the `us` bundle, whose record named the Census Bureau and OpenAddresses
 *   while 68.2% of its 125,276,536 rows carried `overture:NAD`.
 */

import { databaseRootPath } from "@mailwoman/core/data-root"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { type DataBundle, censusBundleSources, renderSourceCensus } from "mailwoman/data"
import { dirname } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

/**
 * A bundle declaring one artifact per given local path, with a census over `address_point.source`.
 *
 * The rights declaration is required to compile, and an empty one states nothing
 * rather than describing a bundle with no obligations.
 * The same fixture convention `bundles.test.ts` uses.
 */
function bundleOver(localPaths: readonly string[], census: DataBundle["sourceCensus"]): DataBundle {
	return {
		name: "fixture",
		description: "a fixture",
		rights: { publishers: ["A Publisher"], terms: [], conditions: [], unresolved: [] },
		artifacts: localPaths.map((localPath) => ({
			remotePath: localPath,
			localPath,
			md5Sidecar: false,
			approxBytes: 0,
		})),
		...(census ? { sourceCensus: census } : {}),
	}
}

/**
 * Plant a database at `localPath` under a fresh data root, carrying one `address_point` row per stamp.
 */
async function plant(rowsBySource: Record<string, number>, localPath = "points.db") {
	const scratch = fixtures.use(await temporaryDirectory("mw-data-sources-"))
	const dataRoot = String(scratch.path)
	// Plant through the same builder the census resolves with, so a change to the data
	// root's database group moves the fixture and the reader together.
	const path = String(databaseRootPath(dataRoot, localPath))

	await makeDirectories(dirname(path))

	using database = new DatabaseClient<{ address_point: { source: string } }>(path)

	database.exec("CREATE TABLE address_point (source TEXT)")

	for (const [source, rows] of Object.entries(rowsBySource)) {
		for (let index = 0; index < rows; index += 1) {
			database.prepare("INSERT INTO address_point (source) VALUES (?)").run(source)
		}
	}

	return dataRoot
}

const perRow = { table: "address_point", column: "source", shape: "per-row" } as const

describe("censusBundleSources", () => {
	it("tallies each stamp and sorts the largest contributor first", async () => {
		const dataRoot = await plant({ "overture:NAD": 7, "overture:OpenAddresses/MA/MassGIS": 3 })
		const result = await censusBundleSources(bundleOver(["points.db"], perRow), dataRoot)

		expect(result.status).toBe("censused")
		expect(result.totalRows).toBe(10)

		expect(result.tallies).toStrictEqual([
			{ source: "overture:NAD", rows: 7 },
			{ source: "overture:OpenAddresses/MA/MassGIS", rows: 3 },
		])
	})

	it("says a bundle's artifacts carry no publisher column rather than censusing it to nothing", async () => {
		const dataRoot = await plant({ "a-source": 1 })
		const result = await censusBundleSources(bundleOver(["points.db"], undefined), dataRoot)

		expect(result.status).toBe("none-recorded-in-the-artifacts")
		expect(result.tallies).toEqual([])

		// The distinction the status carries: this prints differently from a census that read rows and found none.
		expect(renderSourceCensus(result, ["A Publisher"]).join("\n")).toContain("carry no publisher column")
	})

	it("reports nothing downloaded rather than zero rows", async () => {
		const empty = fixtures.use(await temporaryDirectory("mw-data-sources-empty-"))
		const dataRoot = String(empty.path)
		const result = await censusBundleSources(bundleOver(["points.db"], perRow), dataRoot)

		expect(result.status).toBe("nothing-on-disk")
		expect(result.artifactsAbsent).toBe(1)
		expect(result.totalRows).toBe(0)
		expect(renderSourceCensus(result, ["A Publisher"]).join("\n")).toContain("mailwoman data pull")
	})

	it("withholds the shares when only part of a bundle is on disk", async () => {
		const dataRoot = await plant({ "overture:NAD": 4 })
		const result = await censusBundleSources(bundleOver(["points.db", "absent.db"], perRow), dataRoot)

		expect(result.artifactsRead).toBe(1)
		expect(result.artifactsAbsent).toBe(1)

		const rendered = renderSourceCensus(result, ["A Publisher"]).join("\n")

		// A percentage over part of a bundle describes the part.
		// Printing `100.0%` here would say the bundle carries one publisher,
		// which a partial copy cannot establish.
		expect(rendered).toContain("the shares below are withheld")
		expect(rendered).not.toContain("%")
	})

	it("names an artifact it could not read rather than counting it as absent", async () => {
		const dataRoot = await plant({ "overture:NAD": 2 })
		const wrongTable = { table: "layer_manifest", column: "source", shape: "manifest" } as const
		const result = await censusBundleSources(bundleOver(["points.db"], wrongTable), dataRoot)

		expect(result.artifactsAbsent).toBe(0)
		expect(result.problems).toHaveLength(1)
		expect(result.problems[0]).toContain("no such table: layer_manifest")
	})

	it("leaves an artifact outside the census's family out of the denominator", async () => {
		const dataRoot = await plant({ "overture:NAD": 5 })
		const bundle = bundleOver(["points.db"], { ...perRow, family: "address-points" })

		bundle.artifacts[0]!.family = "address-points"

		bundle.artifacts.push({
			remotePath: "ranges.db",
			localPath: "ranges.db",
			md5Sidecar: false,
			approxBytes: 0,
			family: "interpolation",
		})

		const result = await censusBundleSources(bundle, dataRoot)

		// The interpolation artifact is a different shape rather than a missing or broken one,
		// so it is neither absent nor a problem, and the shares stay printable.
		expect(result.artifactsOutOfScope).toBe(1)
		expect(result.artifactsAbsent).toBe(0)
		expect(result.problems).toEqual([])
		expect(renderSourceCensus(result, ["A Publisher"]).join("\n")).toContain("100.0%")
	})
})
