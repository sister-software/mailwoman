/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   FST-distribution arc (2026-07-25): the runtime pipeline's weights-FST auto-load. The classifier
 *   exposes the sibling PATH (`fstPath`); `createRuntimePipeline` deserializes + wires it as the
 *   default gazetteer on the first call (lazy), with `fst: false` as the byte-stable opt-out.
 */

import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { join } from "@mailwoman/platform/path"
import { buildFSTFromWOF } from "@mailwoman/resolver-wof-sqlite/fst-builder"
import { serializeFST } from "@mailwoman/resolver-wof-sqlite/fst-serialize"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { createRuntimePipeline } from "mailwoman/runtime-pipeline"
import { describe, expect, it } from "vitest"

/**
 * Build a minimal but REAL FST binary (one locality entry, "testville") via the actual builder + serializer — no
 * hand-rolled bytes. Returns the written file path.
 */
async function writeTinyFST(dir: string): Promise<string> {
	const dbPath = join(dir, "tiny-wof.db")
	using db = new DatabaseClient<WOFDatabase>(dbPath)

	db.exec(
		"CREATE TABLE spr (id INTEGER PRIMARY KEY, name TEXT, placetype TEXT, country TEXT, parent_id INTEGER, latitude REAL, longitude REAL, is_current INTEGER)"
	)

	db.exec("CREATE TABLE names (id INTEGER, name TEXT, language TEXT, privateuse TEXT)")
	db.exec("CREATE TABLE place_importance (id INTEGER PRIMARY KEY, importance REAL)")

	db.prepare(
		"INSERT INTO spr (id, name, placetype, country, latitude, longitude, is_current) VALUES (1, 'Testville', 'locality', 'US', 40.0, -75.0, 1)"
	).run()

	db.prepare("INSERT INTO names (id, name, language) VALUES (1, 'testville', 'eng')").run()
	db.prepare("INSERT INTO place_importance (id, importance) VALUES (1, 0.5)").run()

	const { matcher, provenance } = await buildFSTFromWOF({ dbPath, countries: ["US"], languages: ["*"] })
	const fstPath = join(dir, "fst-en-us.bin")
	await writeLocalFile(serializeFST(matcher, provenance), fstPath)

	return fstPath
}

/**
 * Minimal classifier stand-in: records the opts it was called with, returns an empty tree.
 */
function fakeClassifier(fstPath?: string) {
	const calls: Array<Record<string, unknown>> = []

	return {
		calls,
		classifier: {
			...(fstPath ? { fstPath } : {}),
			parse: async (text: string, opts: Record<string, unknown>) => {
				calls.push(opts)

				return { raw: text, roots: [] }
			},
		},
	}
}

describe("createRuntimePipeline — weights-FST auto-load (FST-distribution arc)", () => {
	it("auto-loads the classifier's fstPath gazetteer and passes it to parse on the first call", async () => {
		await using dirDirectory = await temporaryDirectory("mw-fst-autoload-")
		const dir = dirDirectory.path
		const { classifier, calls } = fakeClassifier(await writeTinyFST(dir))
		const pipeline = createRuntimePipeline({ classifier })

		await pipeline("1 Testville Road")
		expect(calls.length).toBeGreaterThan(0)
		expect(calls[0]!.fst).toBeDefined()
		// The gate's morphology matcher is wired with the emission prior ZEROED (the measured-sweet
		// F config — the emission prior stays off on production paths).
		expect(calls[0]!.fstStreetMorphology).toBeDefined()
		expect(calls[0]!.fstStreetMorphologyOpts).toEqual({ biasScale: 0, dependentLocalityPenalty: 0 })
	})

	it("fst: false suppresses the auto-load (byte-stable override)", async () => {
		await using dirDirectory = await temporaryDirectory("mw-fst-optout-")
		const dir = dirDirectory.path
		const { classifier, calls } = fakeClassifier(await writeTinyFST(dir))
		const pipeline = createRuntimePipeline({ classifier, fst: false })

		await pipeline("1 Testville Road")
		expect(calls.length).toBeGreaterThan(0)
		expect(calls[0]!.fst).toBeUndefined()
		expect(calls[0]!.fstStreetMorphology).toBeUndefined()
	})

	it("a classifier without fstPath parses without the gazetteer (byte-stable)", async () => {
		const { classifier, calls } = fakeClassifier()
		const pipeline = createRuntimePipeline({ classifier })

		await pipeline("1 Anywhere Road")
		expect(calls.length).toBeGreaterThan(0)
		expect(calls[0]!.fst).toBeUndefined()
	})

	it("an explicit caller-supplied FST wins over the auto-load", async () => {
		await using dirDirectory = await temporaryDirectory("mw-fst-explicit-")
		const dir = dirDirectory.path
		const explicitPath = await writeTinyFST(dir)
		const { classifier, calls } = fakeClassifier(explicitPath)
		const { deserializeFST } = await import("@mailwoman/resolver-wof-sqlite/fst-serialize")

		const explicit = deserializeFST(await readLocalBuffer(explicitPath))
		const pipeline = createRuntimePipeline({ classifier, fst: explicit })

		await pipeline("1 Testville Road")
		expect(calls[0]!.fst).toBe(explicit)
	})
})
