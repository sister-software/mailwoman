/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runAdapter } from "../../runner.js"
import type { CanonicalRow } from "../../types.js"
import { OPENADDRESSES_ADAPTER_ID, OPENADDRESSES_DEFAULT_LICENSE, createOpenaddressesAdapter } from "./adapter.js"

const here = dirname(fileURLToPath(import.meta.url))
const fixtureGeojsonl = resolve(here, "../../../fixtures/openaddresses/sample-us.geojson")

let scratch: string
beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "mailwoman-oa-"))
})
afterEach(async () => {
	await rm(scratch, { recursive: true, force: true }).catch(() => {})
})

async function loadRows(): Promise<CanonicalRow[]> {
	const jsonl = await readFile(join(scratch, OPENADDRESSES_ADAPTER_ID, "canonical.jsonl"), "utf8")
	return jsonl
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as CanonicalRow)
}

describe("openaddresses adapter against fixture sample-us.geojson", () => {
	it("emits a row per Feature with the country stamped from --country", async () => {
		const manifest = await runAdapter({
			adapter: createOpenaddressesAdapter(),
			adapterOptions: { inputPath: fixtureGeojsonl, country: "US" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		// Default-include (2026-06-19 flip): the CC-BY-SA-4.0 row is KEPT — exclusion is a deliberate
		// build-level act now (`--exclude-share-alike`), not a silent adapter default (#26) → 6 rows.
		expect(manifest.yielded).toBe(6)
		const rows = await loadRows()
		expect(rows).toHaveLength(6)
		expect(rows.every((r) => r.country === "US")).toBe(true)
		expect(rows.every((r) => r.source === OPENADDRESSES_ADAPTER_ID)).toBe(true)
	})

	it("propagates per-row LICENSE and falls back to defaultLicense when absent", async () => {
		await runAdapter({
			adapter: createOpenaddressesAdapter({ allowShareAlike: true }),
			adapterOptions: { inputPath: fixtureGeojsonl, country: "US" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()

		// Per-row licenses from the fixture
		const byHash = new Map(rows.map((r) => [r.source_id, r] as const))
		expect(byHash.get("openaddresses-a1b2c3d4e5f60718")?.license).toBe("CC-BY-4.0")
		expect(byHash.get("openaddresses-c3d4e5f607182930")?.license).toBe("PDDL-1.0")
		expect(byHash.get("openaddresses-d4e5f60718293041")?.license).toBe("CC0-1.0")
		expect(byHash.get("openaddresses-e5f6071829304152")?.license).toBe("CC-BY-SA-4.0")

		// The Austin fixture row has no LICENSE property → default fallback
		expect(byHash.get("openaddresses-f60718293041526a")?.license).toBe(OPENADDRESSES_DEFAULT_LICENSE)
	})

	it("honors a non-default `defaultLicense` for license-less rows", async () => {
		await runAdapter({
			adapter: createOpenaddressesAdapter({ defaultLicense: "ODbL-1.0", allowShareAlike: true }),
			adapterOptions: { inputPath: fixtureGeojsonl, country: "US" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		const austin = rows.find((r) => r.source_id === "openaddresses-f60718293041526a")
		expect(austin?.license).toBe("ODbL-1.0")
	})

	it("composes a US-idiomatic raw line with house_number + street + locality + region + postcode", async () => {
		await runAdapter({
			adapter: createOpenaddressesAdapter({ allowShareAlike: true }),
			adapterOptions: { inputPath: fixtureGeojsonl, country: "US" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		const fifth = rows.find((r) => r.source_id === "openaddresses-a1b2c3d4e5f60718")
		expect(fifth?.raw).toMatch(/^350 5th Avenue/)
		expect(fifth?.raw).toContain("New York")
		expect(fifth?.raw).toMatch(/\bNY\b/)
		expect(fifth?.raw).toContain("10118")
		expect(fifth?.components).toMatchObject({
			house_number: "350",
			street: "5th Avenue",
			locality: "New York",
			region: "NY",
			postcode: "10118",
		})
	})

	it("includes unit on the road line when present", async () => {
		await runAdapter({
			adapter: createOpenaddressesAdapter({ allowShareAlike: true }),
			adapterOptions: { inputPath: fixtureGeojsonl, country: "US" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		const wThirtyFourth = rows.find((r) => r.source_id === "openaddresses-b2c3d4e5f6071829")
		expect(wThirtyFourth?.raw).toContain("Apt 12B")
		expect(wThirtyFourth?.components.unit).toBe("Apt 12B")
	})

	it("rejects an invocation without --country", async () => {
		await expect(
			runAdapter({
				adapter: createOpenaddressesAdapter(),
				adapterOptions: { inputPath: fixtureGeojsonl },
				outputDir: scratch,
				corpusVersion: "0.1.0",
			})
		).rejects.toThrow(/--country is required/)
	})

	it("honors --limit", async () => {
		const manifest = await runAdapter({
			adapter: createOpenaddressesAdapter(),
			adapterOptions: { inputPath: fixtureGeojsonl, country: "US", limit: 3 },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		expect(manifest.yielded).toBe(3)
		expect(manifest.written).toBe(3)
	})

	it("source_id prefers `hash`; falls back to `id`; then to a content hash", async () => {
		// Build a tiny fixture with one of each shape inline.
		const inline = join(scratch, "edge.geojsonl")
		const lines = [
			JSON.stringify({
				type: "Feature",
				geometry: { type: "Point", coordinates: [0, 0] },
				properties: {
					hash: "deadbeefcafef00d",
					number: "100",
					street: "Hash Street",
					city: "Hashville",
					region: "NV",
					postcode: "89001",
				},
			}),
			JSON.stringify({
				type: "Feature",
				geometry: { type: "Point", coordinates: [0, 0] },
				properties: {
					id: "us-fallback-id",
					number: "200",
					street: "Id Street",
					city: "Idville",
					region: "NV",
					postcode: "89002",
				},
			}),
			JSON.stringify({
				type: "Feature",
				geometry: { type: "Point", coordinates: [0, 0] },
				properties: {
					number: "300",
					street: "Anonymous Street",
					city: "Anonville",
					region: "NV",
					postcode: "89003",
				},
			}),
		]
		await writeFile(inline, `${lines.join("\n")}\n`, "utf8")

		await runAdapter({
			adapter: createOpenaddressesAdapter(),
			adapterOptions: { inputPath: inline, country: "US" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		expect(rows).toHaveLength(3)
		expect(rows[0]!.source_id).toBe("openaddresses-deadbeefcafef00d")
		expect(rows[1]!.source_id).toBe("openaddresses-us-fallback-id")
		// Content-hashed fallback: 12-hex prefix of sha256 from stableSourceId. Stable across runs.
		expect(rows[2]!.source_id).toMatch(/^openaddresses-[0-9a-f]{12}$/)
	})

	it("skips blank lines, comments, and non-Feature objects without crashing", async () => {
		const messy = join(scratch, "messy.geojsonl")
		const lines = [
			"",
			"# this is a comment",
			"{not even json}",
			JSON.stringify({ type: "FeatureCollection", features: [] }),
			JSON.stringify({
				type: "Feature",
				geometry: { type: "Point", coordinates: [0, 0] },
				properties: {
					hash: "f00",
					number: "1",
					street: "Only Real Street",
					city: "Only Real City",
					region: "VT",
					postcode: "05401",
				},
			}),
			"",
		]
		await writeFile(messy, `${lines.join("\n")}\n`, "utf8")

		const manifest = await runAdapter({
			adapter: createOpenaddressesAdapter(),
			adapterOptions: { inputPath: messy, country: "US" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		expect(manifest.yielded).toBe(1)
		const rows = await loadRows()
		expect(rows[0]?.components.street).toBe("Only Real Street")
	})

	it("two runs over the same dump produce identical sha256", async () => {
		const a = await runAdapter({
			adapter: createOpenaddressesAdapter(),
			adapterOptions: { inputPath: fixtureGeojsonl, country: "US" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		await rm(join(scratch, OPENADDRESSES_ADAPTER_ID), { recursive: true, force: true })
		const b = await runAdapter({
			adapter: createOpenaddressesAdapter(),
			adapterOptions: { inputPath: fixtureGeojsonl, country: "US" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		expect(a.sha256).toBe(b.sha256)
	})

	it("INCLUDES share-alike by default; drops only on explicit allowShareAlike:false (#26 exclusion is deliberate)", async () => {
		// Default-include (2026-06-19 flip): the CC-BY-SA-4.0 row (e5f6…) is PRESENT — no silent drop.
		// Exclusion is now a deliberate BUILD-level act (`--exclude-share-alike`), not an adapter default.
		await runAdapter({
			adapter: createOpenaddressesAdapter(),
			adapterOptions: { inputPath: fixtureGeojsonl, country: "US" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		expect((await loadRows()).find((r) => r.source_id === "openaddresses-e5f6071829304152")).toBeDefined()
		// The explicit adapter-scoped drop still works (vestigial fallback; build-level is the norm).
		await runAdapter({
			adapter: createOpenaddressesAdapter({ allowShareAlike: false }),
			adapterOptions: { inputPath: fixtureGeojsonl, country: "US" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const dropped = await loadRows()
		expect(dropped.find((r) => r.source_id === "openaddresses-e5f6071829304152")).toBeUndefined()
		for (const r of dropped) expect(r.license).not.toMatch(/^ODbL|^CC-BY-SA|^CC-SA/i)
	})

	it("passes share-alike rows through when allowShareAlike is set", async () => {
		await runAdapter({
			adapter: createOpenaddressesAdapter({ allowShareAlike: true }),
			adapterOptions: { inputPath: fixtureGeojsonl, country: "US" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		expect(rows).toHaveLength(6)
		expect(rows.find((r) => r.source_id === "openaddresses-e5f6071829304152")?.license).toBe("CC-BY-SA-4.0")
	})

	it("accepts UPPERCASE property names (legacy OA dumps)", async () => {
		const upper = join(scratch, "upper.geojsonl")
		const line = JSON.stringify({
			type: "Feature",
			geometry: { type: "Point", coordinates: [0, 0] },
			properties: {
				HASH: "upper1234",
				NUMBER: "500",
				STREET: "Capitol Way",
				CITY: "Olympia",
				REGION: "WA",
				POSTCODE: "98501",
				LICENSE: "CC-BY-3.0",
			},
		})
		await writeFile(upper, `${line}\n`, "utf8")

		await runAdapter({
			adapter: createOpenaddressesAdapter(),
			adapterOptions: { inputPath: upper, country: "US" },
			outputDir: scratch,
			corpusVersion: "0.1.0",
		})
		const rows = await loadRows()
		expect(rows).toHaveLength(1)
		expect(rows[0]?.source_id).toBe("openaddresses-upper1234")
		expect(rows[0]?.license).toBe("CC-BY-3.0")
		expect(rows[0]?.components.street).toBe("Capitol Way")
	})
})
