/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Regenerate the ModelVisualizer story/test fixture: one real `NeuralParseTrace` from the
 *   locally-resolved en-us weights (`@mailwoman/neural-weights-en-us`). Committed so docs CI
 *   never needs a model download. Re-run after any trace-schema change or weights bump:
 *
 *       mailwoman dev generate trace-fixture ["custom address"]
 *
 *   NOTE: on machines without the anchor lookup ($MAILWOMAN_DATA_ROOT), loadFromWeights warns
 *   and the trace's `anchor` channel is absent — the component's "channel not fed" state. The
 *   deployed demo feeds anchor from postcode-<cc>.bin, so regenerate on a lab box for a
 *   fully-fed fixture when that state matters.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import { repoRootPathBuilder } from "@mailwoman/core/utils"
import { NeuralAddressClassifier } from "@mailwoman/neural"

const DEFAULT_OUT = String(
	repoRootPathBuilder("docs", "src", "components", "ModelVisualizer", "fixtures", "white-house.trace.json")
)

const DEFAULT_TEXT = "1600 Pennsylvania Ave NW, Washington, DC 20500"

/** Options for {@linkcode generateTraceFixture}. */
export interface GenerateTraceFixtureOptions {
	/** Address to trace. Default: the White House. */
	text?: string
	/** Output path override. Default: the committed ModelVisualizer fixture. */
	out?: string
}

/** Summary returned by {@linkcode generateTraceFixture}. */
export interface GenerateTraceFixtureSummary {
	outPath: string
	pieces: number
	labels: number
}

/** Trace one address through the en-us weights and write the committed fixture JSON. */
export async function generateTraceFixture(
	options: GenerateTraceFixtureOptions = {},
	report?: (line: string) => void
): Promise<GenerateTraceFixtureSummary> {
	const outPath = options.out ?? DEFAULT_OUT
	const text = options.text ?? DEFAULT_TEXT
	const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-us" })
	const trace = await classifier.traceParse(text, { addressSystemConventions: "auto" })

	mkdirSync(dirname(outPath), { recursive: true })
	writeFileSync(outPath, `${JSON.stringify(trace, null, "\t")}\n`)
	report?.(`wrote ${outPath} (${trace.pieces.length} pieces, ${trace.labels.length} labels)`)

	return { outPath, pieces: trace.pieces.length, labels: trace.labels.length }
}
