/**
 * Threshold-free, report-only C4 boundary-feature census over the committed Gauntlet board. This command changes no
 * runtime behavior and is not a release gate.
 */

/* oxlint-disable sister-software/multiline-statement-padding -- each row's evidence assembly reads as one operation */

import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { findFSTAcceptedMatches } from "@mailwoman/neural/fst-prior"
import { groupPhrasesSync } from "@mailwoman/phrase-grouper/group"
import { computeQueryShape } from "@mailwoman/query-shape"
import { loadStreetMorphologyFST } from "@mailwoman/resolver-wof-sqlite/street"

import { loadRegressionCases } from "#eval-harness/gauntlet/cases/load"
import { buildGauntletDeps } from "#eval-harness/gauntlet/harness"
import { gradeBoundaryTruth, locateUniqueComponentTruth, spansFromBIO } from "#eval-harness/grammar-census"
import {
	type ClassifiedC4BoundaryReceipt,
	type C4TruthPosition,
	observeC4Boundaries,
	summarizeC4FeatureVectors,
} from "#eval-harness/grammar-census-c4"

const { values } = parseArguments({ options: { "out-json": { type: "string" } } })
const cases = await loadRegressionCases()
const deps = await buildGauntletDeps()
const rows: Array<{
	id: string
	input: string
	decodedText: string
	registryFSTAvailable: boolean
	streetAffixAvailable: boolean
	boundaries: ClassifiedC4BoundaryReceipt[]
}> = []

let streetMorphology: Awaited<ReturnType<typeof loadStreetMorphologyFST>> | null = null
let streetMorphologyUnavailable: string | null = null

try {
	streetMorphology = await loadStreetMorphologyFST()
} catch (error) {
	streetMorphologyUnavailable = (error as Error).message
}

try {
	for (const row of cases) {
		const overlayCountry = row.locale?.split("-")[1] ?? row.country
		const diagnostic = await deps.diagnoseParse(row.input, { caseCountry: overlayCountry })
		const decodedText = diagnostic.trace.text
		const shape = computeQueryShape(decodedText)
		const proposals = groupPhrasesSync({ raw: decodedText, normalized: decodedText }, shape)
		const registryMatches = diagnostic.fst ? findFSTAcceptedMatches(diagnostic.fst, diagnostic.trace.pieces) : undefined
		const streetAffixMatches = streetMorphology
			? findFSTAcceptedMatches(streetMorphology.matcher, diagnostic.trace.pieces).filter((match) =>
					match.entries.some((entry) => entry.placetype === "street_affix")
				)
			: undefined
		const truth = locateUniqueComponentTruth(decodedText, row.expectComponents ?? {})
		const boundaries = observeC4Boundaries(
			spansFromBIO(diagnostic.trace.tokens),
			diagnostic.trace.pieces,
			proposals,
			shape,
			registryMatches,
			streetAffixMatches
		).map((boundary) => {
			const c6Grade = gradeBoundaryTruth(boundary.boundaryCharacter, truth)
			const truthPosition: C4TruthPosition =
				c6Grade === "true_positive"
					? "inside_expected_component"
					: c6Grade === "false_positive"
						? "expected_component_edge"
						: "unclassified"

			return { ...boundary, rowID: row.id, input: row.input, truthPosition }
		})

		rows.push({
			id: row.id,
			input: row.input,
			decodedText,
			registryFSTAvailable: registryMatches !== undefined,
			streetAffixAvailable: streetAffixMatches !== undefined,
			boundaries,
		})
	}
} finally {
	deps[Symbol.dispose]()
}

const boundaries = rows.flatMap((row) => row.boundaries)
const featureVectors = summarizeC4FeatureVectors(boundaries)
const summary = {
	rows: rows.length,
	boundaries: boundaries.length,
	boundariesInsidePhraseProposal: boundaries.filter((boundary) => boundary.insidePhraseProposals.length).length,
	insideExpectedComponent: boundaries.filter((boundary) => boundary.truthPosition === "inside_expected_component")
		.length,
	expectedComponentEdge: boundaries.filter((boundary) => boundary.truthPosition === "expected_component_edge").length,
	unclassified: boundaries.filter((boundary) => boundary.truthPosition === "unclassified").length,
	registryFSTAvailableRows: rows.filter((row) => row.registryFSTAvailable).length,
	streetAffixAvailableRows: rows.filter((row) => row.streetAffixAvailable).length,
}

console.log(
	`C4 boundary features: ${summary.rows} board rows; ${summary.boundaries} adjacent decoded boundaries; ` +
		`${summary.boundariesInsidePhraseProposal}/${summary.boundaries} strictly inside at least one phrase proposal; ` +
		`truth positions ${summary.insideExpectedComponent} inside a unique expected component, ` +
		`${summary.expectedComponentEdge} on a unique ` +
		`expected component edge, ${summary.unclassified} unclassified.`
)
console.log(
	`License availability: registry FST ${summary.registryFSTAvailableRows}/${summary.rows} rows; ` +
		`street-affix FST ${summary.streetAffixAvailableRows}/${summary.rows} rows` +
		(streetMorphologyUnavailable ? ` (unavailable: ${streetMorphologyUnavailable})` : ".")
)

for (const vector of featureVectors) {
	console.log(
		`${vector.total}: ${vector.featureVector}; truth inside=${vector.insideExpectedComponent}, ` +
			`edge=${vector.expectedComponentEdge}, ` +
			`unclassified=${vector.unclassified}`
	)

	for (const example of vector.examples) {
		console.log(`  ${example.rowID}: ${example.input}`)
	}
}

if (values["out-json"]) {
	await writeLocalJSONFile({ summary, featureVectors, rows }, values["out-json"])
}
