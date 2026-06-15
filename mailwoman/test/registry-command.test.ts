/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit tests for the `registry` command's pure pieces (#613). The full cascade is
 *   operator-verifiable (it needs the weights + shards), so here we only pin the column-mapping
 *   resolution — the one bit of command-specific logic that doesn't touch the heavy runtime.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, test } from "vitest"

import { DEFAULT_MAPPING, loadMapping, loadSources } from "../commands/registry.js"

const dirs: string[] = []
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "mw-registry-"))
	dirs.push(d)
	return d
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

describe("registry command — loadMapping", () => {
	test("no --mapping returns the built-in default", () => {
		expect(loadMapping(undefined, undefined)).toEqual(DEFAULT_MAPPING)
	})

	test("inline JSON merges over the default (override just one field)", () => {
		const m = loadMapping('{ "address": ["addr"], "name": "contact_name" }', undefined)
		expect(m.address).toEqual(["addr"])
		expect(m.name).toBe("contact_name")
		// untouched fields keep the default
		expect(m.email).toBe(DEFAULT_MAPPING.email)
		expect(m.organization).toEqual(DEFAULT_MAPPING.organization)
	})

	test("a file path is read + parsed", () => {
		const dir = tmp()
		const file = join(dir, "mapping.json")
		writeFileSync(file, JSON.stringify({ id: "npi", organization: "legal_name" }))
		const m = loadMapping(file, undefined)
		expect(m.id).toBe("npi")
		expect(m.organization).toBe("legal_name")
		expect(m.address).toEqual(DEFAULT_MAPPING.address)
	})

	test("--source stamps a provenance label (not a column)", () => {
		const m = loadMapping(undefined, "clinics-2026")
		expect(m.source).toBe("clinics-2026")
	})

	test("invalid JSON (and not a file) throws a clear error", () => {
		expect(() => loadMapping("{ not json", undefined)).toThrow(/mapping/)
	})
})

describe("registry command — loadSources (--sources)", () => {
	test("inline JSON array parses into specs", () => {
		const specs = loadSources(
			'[{ "path": "a.tsv", "source": "a", "mapping": { "id": "id" } }, { "path": "b.csv", "mapping": {} }]'
		)
		expect(specs).toHaveLength(2)
		expect(specs[0]).toMatchObject({ path: "a.tsv", source: "a" })
		expect(specs[1]!.path).toBe("b.csv")
	})

	test("a file path is read + parsed", () => {
		const dir = tmp()
		const file = join(dir, "sources.json")
		writeFileSync(file, JSON.stringify([{ path: "x.tsv", mapping: { id: "NPI" }, limit: 100 }]))
		const specs = loadSources(file)
		expect(specs[0]).toMatchObject({ path: "x.tsv", limit: 100 })
	})

	test("a non-array throws", () => {
		expect(() => loadSources('{ "path": "a.tsv" }')).toThrow(/array/)
	})

	test("an entry missing `path` throws", () => {
		expect(() => loadSources('[{ "mapping": {} }]')).toThrow(/path/)
	})

	test("invalid JSON (and not a file) throws a clear error", () => {
		expect(() => loadSources("[ not json")).toThrow(/sources/)
	})
})
