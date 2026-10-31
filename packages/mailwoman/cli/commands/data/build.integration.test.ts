/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `mailwoman data build osm-address-points` on the compiled CLI, against a local PBF served as a mirror.
 *
 *   An empty data root runs a dry run. The dry run makes no request and writes no selection. The test then builds
 *   Germany from `europe/dach`, which clips Germany to its outline, installs the database and activates it.
 *   A repeated build transfers neither file again. Run `yarn compile` before this suite.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { md5Hex } from "@mailwoman/core/hash"
import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/json"
import { runFile } from "@mailwoman/core/process"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { writePBF } from "@mailwoman/osm/tools/pbf-writer"
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest"

import { mailwomanCLIPath } from "#metadata"
import { withCLISpawnLockAsync } from "#test-kit/cli-spawn-lock"
import { FixtureRegistry } from "#test-kit/fixture-registry"

const CLI_SPAWN_TIMEOUT_MS = 120_000

vi.setConfig({ testTimeout: 600_000 })

const cliBin = await mailwomanCLIPath()
const registry = new FixtureRegistry()
let root: TemporaryDirectory

beforeAll(async () => {
	root = await temporaryDirectory("mw-cli-build-root-")

	const pbf = writePBF([
		{
			id: 1,
			lat: 52.5163,
			lon: 13.3807,
			tags: { "addr:housenumber": "77", "addr:street": "Unter den Linden", "addr:postcode": "10117" },
		},
		{ id: 2, lat: 48.2085, lon: 16.3731, tags: { "addr:housenumber": "1", "addr:street": "Stephansplatz" } },
	])

	const ring = [
		[12.9, 52],
		[13.9, 52],
		[13.9, 53],
		[12.9, 53],
		[12.9, 52],
	]

	registry.put("geofabrik/europe/dach-latest.osm.pbf", pbf)
	registry.put("geofabrik/europe/dach-latest.osm.pbf.md5", Buffer.from(`${md5Hex(pbf)}  dach-latest.osm.pbf\n`))

	await registry.start()

	registry.put(
		"geoboundaries/api/current/gbOpen/DEU/ADM0/",
		Buffer.from(stringifyJSON({ gjDownloadURL: `${registry.baseURL}outlines/DEU-ADM0.geojson` }))
	)

	registry.put(
		"outlines/DEU-ADM0.geojson",
		Buffer.from(
			stringifyJSON({
				type: "FeatureCollection",
				features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } }],
			})
		)
	)
})

afterAll(async () => {
	await registry[Symbol.asyncDispose]()
	await root[Symbol.asyncDispose]()
})

async function cli(...args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
	return withCLISpawnLockAsync(() =>
		runFile(process.execPath, [cliBin, ...args], {
			env: childEnv({ NODE_NO_WARNINGS: "1", MAILWOMAN_DATA_ROOT: root.path.toString() }),
			maxBuffer: 16 * 1024 * 1024,
			timeout: CLI_SPAWN_TIMEOUT_MS,
		}).then(
			({ stdout, stderr }) => ({ status: 0, stdout, stderr }),
			(error: { code?: number; stdout?: string; stderr?: string }) => ({
				status: typeof error.code === "number" ? error.code : 1,
				stdout: error.stdout ?? "",
				stderr: error.stderr ?? "",
			})
		)
	)
}

describe("mailwoman data build osm-address-points", () => {
	test("plans without a request, builds and activates Germany from a regional extract, and reuses it", async () => {
		const hosts = [
			"--geofabrik-host",
			`${registry.baseURL}geofabrik/`,
			"--geoboundaries-host",
			`${registry.baseURL}geoboundaries/`,
		]

		const request = ["data", "build", "osm-address-points", "--countries", "DE", "--region", "europe/dach", ...hosts]
		const dry = await cli(...request, "--dry-run")

		expect(dry.status, dry.stderr).toBe(0)
		expect(dry.stdout).toContain("prerequisite ogr2ogr")
		expect(dry.stdout).toMatch(/output DE/u)
		expect(registry.requests).toEqual([])
		await expect(pathExists(root.path("active.json"))).resolves.toBe(false)

		const built = await cli(...request, "--activate", "--json")

		expect(built.status, built.stderr).toBe(0)

		const report = parseJSONStrict<{
			ok: boolean
			result: {
				activatedGeneration: number
				outputs: Array<{ manifest: { recipe: string; derivation: { counts: Record<string, number> } } }>
			}
		}>(built.stdout)

		expect(report.ok).toBe(true)
		expect(report.result.activatedGeneration).toBe(1)
		expect(report.result.outputs[0]?.manifest.recipe).toBe("osm-address-points")
		// Vienna lies outside Germany's outline.
		expect(report.result.outputs[0]?.manifest.derivation.counts).toMatchObject({ total: 2, written: 1, outside: 1 })

		const transfers = registry.requests.filter((line) => line.startsWith("GET") && !line.endsWith(".md5")).length
		const again = await cli(...request, "--activate")

		expect(again.status, again.stderr).toBe(0)
		expect(again.stdout).toContain("reused")

		expect(registry.requests.filter((line) => line.startsWith("GET") && !line.endsWith(".md5"))).toHaveLength(
			// The outline's metadata is read again to learn its download URL.
			transfers + 1
		)

		const missing = await cli("data", "build", "osm-address-points", "--countries", "AT", "--dry-run", ...hosts)

		expect(missing.status).toBe(1)
		expect(missing.stdout).toContain("AT has no OpenStreetMap extraction policy")
	})
})
