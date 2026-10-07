/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the `registry` command's pure pieces. The full cascade needs the weights and the
 *   databases, so this file pins only the column-mapping resolution, the command-specific logic
 *   that avoids the heavy runtime.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { DEFAULT_MAPPING, loadMapping, loadSources } from "mailwoman/commands/registry/run"
import type { PathBuilder } from "path-ts"
import { afterAll, describe, expect, test } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

async function tmp(): Promise<PathBuilder> {
	return fixtures.use(await temporaryDirectory("mw-registry-")).path
}

describe("registry command — loadMapping", () => {
	test("no --mapping returns the built-in default", async () => {
		expect(await loadMapping(null, null)).toEqual(DEFAULT_MAPPING)
	})

	test("inline JSON merges over the default (override just one field)", async () => {
		const m = await loadMapping('{ "address": ["addr"], "name": "contact_name" }', null)
		expect(m.address).toEqual(["addr"])
		expect(m.name).toBe("contact_name")
		expect(m.email).toBe(DEFAULT_MAPPING.email)
		expect(m.organization).toEqual(DEFAULT_MAPPING.organization)
	})

	test("a file path is read + parsed", async () => {
		const file = (await tmp())("mapping.json")
		await writeLocalJSONFile({ id: "npi", organization: "legal_name" }, file)
		// The option is a string, because it holds either inline JSON or a file path.
		const m = await loadMapping(file.toString(), null)
		expect(m.id).toBe("npi")
		expect(m.organization).toBe("legal_name")
		expect(m.address).toEqual(DEFAULT_MAPPING.address)
	})

	test("--source stamps a provenance label (not a column)", async () => {
		const m = await loadMapping(null, "clinics-2026")
		expect(m.source).toBe("clinics-2026")
	})

	test("invalid JSON (and not a file) throws a clear error", async () => {
		await expect(loadMapping("{ not json", null)).rejects.toThrow(/mapping/)
	})
})

describe("registry command — loadSources (--sources)", () => {
	test("inline JSON array parses into specs", async () => {
		const specs = await loadSources(
			'[{ "path": "a.tsv", "source": "a", "mapping": { "id": "id" } }, { "path": "b.csv", "mapping": {} }]'
		)

		expect(specs).toHaveLength(2)
		expect(specs[0]).toMatchObject({ path: "a.tsv", source: "a" })
		expect(specs[1]!.path).toBe("b.csv")
	})

	test("a file path is read + parsed", async () => {
		const file = (await tmp())("sources.json")
		await writeLocalJSONFile([{ path: "x.tsv", mapping: { id: "NPI" }, limit: 100 }], file)
		const specs = await loadSources(file.toString())
		expect(specs[0]).toMatchObject({ path: "x.tsv", limit: 100 })
	})

	test("a non-array throws", async () => {
		await expect(loadSources('{ "path": "a.tsv" }')).rejects.toThrow(/array/)
	})

	test("an entry missing `path` throws", async () => {
		await expect(loadSources('[{ "mapping": {} }]')).rejects.toThrow(/path/)
	})

	test("invalid JSON (and not a file) throws a clear error", async () => {
		await expect(loadSources("[ not json")).rejects.toThrow(/sources/)
	})
})
