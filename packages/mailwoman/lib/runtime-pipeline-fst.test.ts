/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   FST-distribution arc (2026-07-25): the runtime pipeline's weights-FST auto-load. The classifier
 *   exposes the sibling path (`fstPath`); `createRuntimePipeline` deserializes + wires it as the
 *   default gazetteer on the first call (lazy), with `fst: false` as the byte-stable opt-out.
 */

import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { NUMBERED_MORPHOLOGY_OPTS, ZEROED_MORPHOLOGY_OPTS } from "@mailwoman/core/pipeline"
import { buildFSTFromWOF, serializeFST } from "@mailwoman/resolver-wof-sqlite/fst"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilder } from "path-ts"
import { describe, expect, it } from "vitest"

import { createRuntimePipeline } from "#runtime-pipeline"

/**
 * Build a minimal but real FST binary (one locality entry, "testville") via the
 * actual builder + serializer — no hand-rolled bytes.
 *
 * @returns The written file path.
 */
async function writeTinyFST(dir: PathBuilder): Promise<PathBuilder> {
	const dbPath = dir("tiny-wof.db")
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
	const fstPath = dir("fst-en-us.bin")
	await writeLocalFile(serializeFST(matcher, provenance), fstPath)

	return fstPath
}

/**
 * Minimal classifier stand-in: records the opts it was called with, returns an empty tree.
 */
function fakeClassifier(fstPath?: PathBuilder) {
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

		// A locale whose country has no street-type table in the codex, so the test reads the FST and no table.
		await pipeline("1 Testville Road", { locale: "en-JM" })
		expect(calls.length).toBeGreaterThan(0)
		expect(calls[0]!.fst).toBeDefined()
		// The morphology matcher is wired beside the FST, with the numbered-segment prior the geocode
		// session runs by default, and the locale's venue-head lexicon with the country's street-type test.
		expect(calls[0]!.fstStreetMorphology).toBeDefined()
		expect(calls[0]!.fstStreetMorphologyOpts).toEqual(NUMBERED_MORPHOLOGY_OPTS)
		expect(calls[0]!.venueHead).toBeDefined()

		const venueHeadOpts = calls[0]!.venueHeadOpts as { isStreetAffix(word: string): boolean }

		expect(venueHeadOpts.isStreetAffix("st")).toBe(true)
		expect(venueHeadOpts.isStreetAffix("street")).toBe(true)
		expect(venueHeadOpts.isStreetAffix("nw")).toBe(false)
	})

	it("streetMorphologyPrior: false keeps the matcher at the zeroed weights, and venueHead: none drops the lexicon", async () => {
		await using dirDirectory = await temporaryDirectory("mw-fst-prior-off-")
		const dir = dirDirectory.path
		const { classifier, calls } = fakeClassifier(await writeTinyFST(dir))
		const pipeline = createRuntimePipeline({ classifier, streetMorphologyPrior: false, venueHead: "none" })

		await pipeline("1 Testville Road")
		expect(calls[0]!.fstStreetMorphologyOpts).toEqual(ZEROED_MORPHOLOGY_OPTS)
		expect("venueHead" in calls[0]!).toBe(false)
	})

	it("venueHead: auto reads the lexicon and the street-type test of the locale's country", async () => {
		await using dirDirectory = await temporaryDirectory("mw-fst-venue-head-")
		const dir = dirDirectory.path
		const { classifier, calls } = fakeClassifier(await writeTinyFST(dir))
		const pipeline = createRuntimePipeline({ classifier })

		await pipeline("1 Testville Road", { locale: "en-US" })

		const venueHeadOpts = calls[0]!.venueHeadOpts as {
			isStreetAffix(word: string): boolean
			isCountryName(segment: string): boolean
		}

		expect((calls[0]!.venueHead as { first(word: string): number | null }).first("st")).toBeTypeOf("number")
		expect(venueHeadOpts.isStreetAffix("st")).toBe(true)
		expect(venueHeadOpts.isStreetAffix("nw")).toBe(true)
		expect(venueHeadOpts.isCountryName("united states of america")).toBe(true)
	})

	it("fst: none suppresses the auto-load (byte-stable override)", async () => {
		await using dirDirectory = await temporaryDirectory("mw-fst-optout-")
		const dir = dirDirectory.path
		const { classifier, calls } = fakeClassifier(await writeTinyFST(dir))
		const pipeline = createRuntimePipeline({ classifier, fst: "none" })

		await pipeline("1 Testville Road")
		expect(calls.length).toBeGreaterThan(0)
		expect(calls[0]!.fst).toBeNull()
		expect(calls[0]!.fstStreetMorphology).toBeUndefined()
	})

	it("a classifier without fstPath parses without the gazetteer (byte-stable)", async () => {
		const { classifier, calls } = fakeClassifier()
		const pipeline = createRuntimePipeline({ classifier })

		await pipeline("1 Anywhere Road")
		expect(calls.length).toBeGreaterThan(0)
		expect(calls[0]!.fst).toBeNull()
	})

	it("an explicit caller-supplied FST wins over the auto-load", async () => {
		await using dirDirectory = await temporaryDirectory("mw-fst-explicit-")
		const dir = dirDirectory.path
		const explicitPath = await writeTinyFST(dir)
		const { classifier, calls } = fakeClassifier(explicitPath)
		const { deserializeFST } = await import("@mailwoman/resolver-wof-sqlite/fst")

		const explicit = deserializeFST(await readLocalBuffer(explicitPath))
		const pipeline = createRuntimePipeline({ classifier, fst: explicit })

		await pipeline("1 Testville Road")
		expect(calls[0]!.fst).toBe(explicit)
	})
})
