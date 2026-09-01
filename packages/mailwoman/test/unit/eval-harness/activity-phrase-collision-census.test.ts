/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the activity-phrase collision census (#1962): the probe enumeration, the venue-name
 *   classification, and the committed report's agreement with the committed lexicon.
 *
 *   No database. The census takes its POI reader injected, so the `Somewhere` collision is reproduced from a
 *   synthetic one — the case matters enough to be pinned somewhere a run without `poi.db` still executes it.
 */

import { readActivityLexicon } from "@mailwoman/activity-lexicon"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { removePathIfPresent, makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { repoRootPath } from "@mailwoman/core/utils"
import {
	candidateSubjects,
	type CensusVenue,
	classifyVenueName,
	type PhraseCollisionCensus,
	runPhraseCollisionCensus,
} from "mailwoman/eval-harness/activity-lexicon/phrase-collision-census"
import { resolvePath } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

const COMMITTED_CENSUS = "packages/mailwoman/lib/eval-harness/activity-lexicon/collision-census.json"

const lexicon = await readActivityLexicon()

const committedCensusPath = resolvePath(String(repoRootPath()), COMMITTED_CENSUS)
const committed = await readLocalJSONFile<PhraseCollisionCensus>(committedCensusPath)

/**
 * A repository root carrying one committed query, so the carrier-prefix family is exercised without reading the real
 * 17k-input corpus on every run.
 */
const scratchRoot = await temporaryDirectory("collision-census-")

afterAll(() => scratchRoot[Symbol.asyncDispose]())

await makeDirectories(scratchRoot.resolve("packages/mailwoman/lib/eval-harness/fixtures"))

await writeLocalTextFile(
	`${JSON.stringify({ id: "sem-act-fr-01", query: "somewhere to fill a prescription near Toulouse" })}\n` +
		`${JSON.stringify({ id: "cat-fr-03", query: "pharmacy near Toulouse" })}\n`,
	scratchRoot.resolve("packages/mailwoman/lib/eval-harness/fixtures/rows.jsonl")
)

afterAll(async () => {
	await removePathIfPresent(scratchRoot.path)
})

function census(venues: CensusVenue[]): Promise<PhraseCollisionCensus> {
	return runPhraseCollisionCensus({
		databasePath: scratchRoot.resolve("absent.db"),
		repositoryRoot: scratchRoot.path,
		reader: {
			candidates: () => venues,
			claimedByShippedRung: () => true,
		},
	})
}

describe("the probe enumeration", () => {
	it("mirrors what `matchPOISubject` probes, prefixes included", async () => {
		const subjects = candidateSubjects("somewhere to fill a prescription near Toulouse")

		expect(subjects).toContain("somewhere to fill a prescription near Toulouse")
		expect(subjects).toContain("somewhere")
		expect(subjects).toContain("somewhere to fill a prescription")
	})

	it("reaches the carrier prefixes of a committed query the lexicon can claim", async () => {
		const report = await census([])
		const probes = report.probes.strings.map((row) => row.probe)

		expect(probes).toContain("somewhere")
		expect(report.committedInputs.routeClaimable).toBe(1)
	})

	it("declares every committed surface form as a probe", () => {
		const probes = new Set(committed.probes.strings.map((row) => row.probe))

		for (const entry of lexicon.phrases) {
			expect(probes.has(entry.phrase.toLowerCase())).toBe(true)
		}
	})
})

describe("the venue-name classification", () => {
	it("calls a name made of function words query-shaped", () => {
		expect(classifyVenueName("Somewhere", "somewhere")).toEqual({ class: "query-shaped", tell: "function-word" })
	})

	it("calls a name carrying query syntax query-shaped, however long", () => {
		expect(classifyVenueName("Pharmacy Near Me", "pharmacy")).toEqual({ class: "query-shaped", tell: "query-syntax" })
	})

	it("calls the bare query fragment itself query-shaped", () => {
		expect(classifyVenueName("Prescription", "prescription")).toEqual({
			class: "query-shaped",
			tell: "bare-query-fragment",
		})
	})

	it("calls a name with a distinguishing element beside the fragment legitimate", () => {
		expect(classifyVenueName("London Pharmacy", "pharmacy")).toEqual({
			class: "legitimate",
			tell: "distinguishing-element",
		})

		expect(classifyVenueName("Prescription Shoppe", "prescription")).toEqual({
			class: "legitimate",
			tell: "distinguishing-element",
		})
	})
})

describe("the census over a synthetic reader", async () => {
	const report = await census([
		{ name: "Somewhere", categoryID: "clothing_store", country: "FR" },
		{ name: "Somewhere Else Pub & Grill", categoryID: "bar", country: "GB" },
		{ name: "Prescription Shoppe", categoryID: "pharmacy", country: "US" },
	])

	it("reports the exact collision that takes the query, and says the shipped rung claims it", () => {
		expect(report.nameLexicon.exactCollisions).toHaveLength(1)
		expect(report.nameLexicon.exactCollisions[0]!.name).toBe("Somewhere")
		expect(report.nameLexicon.exactCollisions[0]!.verdict.class).toBe("query-shaped")
		expect(report.nameLexicon.exactCollisions[0]!.reachedByShippedRung).toBe(true)
	})

	it("keeps names that merely contain a probe out of the collision count", () => {
		expect(report.nameLexicon.counts.exactQueryShaped).toBe(1)
		expect(report.nameLexicon.counts.exactLegitimate).toBe(0)

		// Probe order, which is code-point ascending — `prescription` before `somewhere`.
		expect(report.nameLexicon.containment.map((row) => row.name)).toEqual([
			"Prescription Shoppe",
			"Somewhere Else Pub & Grill",
		])

		expect(report.nameLexicon.counts.containmentLegitimate).toBe(2)
	})
})

describe("the committed report", () => {
	it("was taken against the committed lexicon", () => {
		expect(committed.lexicon.lexiconID).toBe(lexicon.lexiconID)
		expect(committed.lexicon.version).toBe(lexicon.version)
		expect(committed.lexicon.declaredPhrases).toBe(lexicon.phrases.length)
	})

	it("names the database it was taken against, so the numbers are reproducible", () => {
		expect(committed.poiDatabase.layerManifest ?? committed.poiDatabase.layerManifestNote).toBeTruthy()
	})
})
