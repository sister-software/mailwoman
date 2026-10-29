/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Writes `test/fixtures/evidence-parity-v2.json`, the parity fixture between the training painter and the
 *   inference painter for the street-type and locality-surface channels.
 *
 *   Two small lexicons are painted over a probe set by the training encoder's painter in `mtf-channels`, through the
 *   tracked fixture tokenizer, and each piece's features and confidence are recorded. `evidence-inference.test.ts`
 *   replays the same lexicons and piece offsets through `buildGazetteerFeatures` and requires equal values.
 *
 *   The probes include hyphenated and apostrophe surfaces, uppercase-only codes, homograph bits, multi-word
 *   longest-first matches, lowercase input, negative rows, and digit-guard rows, where a match beside or containing a
 *   digit paints zeros.
 *
 *   Usage: `node packages/neural/tools/fixtures/evidence-parity.run.ts`
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { prettyJSON, stringifyJSON } from "@mailwoman/core/json"
import { repoRootPath, workspacePath } from "@mailwoman/core/paths"
import { runFile } from "@mailwoman/core/process"
import { runMTFTokenizer } from "@mailwoman/mtf/tools/tokenizer/binary"

interface FixtureLexicon {
	feature_dim: number
	slots: string[]
	bits: Record<string, number>
	max_ngram: number
	entries: Record<string, number>
	code_entries: Record<string, number>
	rules: { digit_guard: boolean }
}

const STREET_LEXICON: FixtureLexicon = {
	feature_dim: 1,
	slots: ["street_type"],
	bits: { street_type: 1 },
	max_ngram: 2,
	entries: {
		rue: 1,
		boulevard: 1,
		impasse: 1,
		chemin: 1,
		street: 1,
		// A two-word entry, matched longest first.
		"ancien chemin": 1,
	},
	code_entries: { R: 1, AV: 1, ST: 1 },
	rules: { digit_guard: true },
}

const LOCALITY_LEXICON: FixtureLexicon = {
	feature_dim: 2,
	slots: ["locality", "locality_homograph"],
	bits: { locality: 1, locality_homograph: 2 },
	max_ngram: 3,
	entries: {
		paris: 3,
		springfield: 3,
		rennes: 1,
		// Hyphenated: the surface class the painter folds.
		"saint-denis": 3,
		// An apostrophe and a hyphen.
		"l'isle-adam": 1,
		// A three-word entry, matched longest first.
		"la grange park": 1,
		belleville: 3,
	},
	code_entries: {},
	rules: { digit_guard: true },
}

const PROBES = [
	"12 rue de la Paix, Paris",
	"12 rue de la paix, paris",
	"Boulevard des Capucines",
	"Saint-Denis",
	"saint-denis",
	"L'Isle-Adam",
	"123 Main ST",
	"123 main st",
	"La Grange Park Illinois",
	"Ancien Chemin de Rennes",
	"Springfield",
	"nothing to see here",
	"Chemin de Belleville",
	"Springfield 62704",
	"12b rue du Springfield",
	"Boulevard 7 des Capucines",
	"Ancien Chemin 3 de Rennes",
]

/**
 * Raise when a lexicon's metadata cannot describe its feature vectors.
 */
function validateLexicon(name: string, lexicon: FixtureLexicon): void {
	if (lexicon.feature_dim !== lexicon.slots.length) {
		throw new Error(`${name}: feature_dim=${lexicon.feature_dim} but slots has ${lexicon.slots.length} entries`)
	}

	if (Object.keys(lexicon.bits).toSorted().join() !== lexicon.slots.toSorted().join()) {
		throw new Error(`${name}: bits keys must equal slots`)
	}

	const validMask = (1 << lexicon.feature_dim) - 1

	for (const section of ["bits", "entries", "code_entries"] as const) {
		const invalid = Object.entries(lexicon[section]).filter(([, mask]) => mask <= 0 || (mask & ~validMask) !== 0)

		if (invalid.length) throw new Error(`${name}: ${section} holds invalid feature masks: ${stringifyJSON(invalid)}`)
	}

	const longest = Math.max(
		0,
		...[...Object.keys(lexicon.entries), ...Object.keys(lexicon.code_entries)].map((e) => e.split(/\s+/).length)
	)

	if (lexicon.max_ngram < longest) {
		throw new Error(`${name}: max_ngram=${lexicon.max_ngram} cannot reach a ${longest}-word entry`)
	}
}

interface PaintedChannel {
	features: number[][]
	confidence: number[]
}

interface PaintedCase {
	raw: string
	pieces: { piece: string; start: number; end: number }[]
	street: PaintedChannel
	locality: PaintedChannel
}

/**
 * A float as Python's `repr` writes it, so an integral value keeps its `.0`.
 */
function pythonFloat(value: number): string {
	return Number.isInteger(value) ? value.toFixed(1) : String(value)
}

/**
 * A channel's values as JSON-ready placeholders that the writer below turns into Python float literals.
 */
function floatChannel(channel: PaintedChannel): { features: string[][]; confidence: string[] } {
	return {
		features: channel.features.map((row) => row.map((v) => `\u0000${pythonFloat(v)}`)),
		confidence: channel.confidence.map((v) => `\u0000${pythonFloat(v)}`),
	}
}

validateLexicon("street_lexicon", STREET_LEXICON)
validateLexicon("locality_lexicon", LOCALITY_LEXICON)

const out = workspacePath("neural", "test", "fixtures", "evidence-parity-v2.json")

await using scratch = await temporaryDirectory("evidence-parity-")
const street = scratch.path("street.json").toString()
const locality = scratch.path("locality.json").toString()
const texts = scratch.path("texts.json").toString()
const painted = scratch.path("painted.json").toString()

await writeLocalJSONFile(STREET_LEXICON, street)
await writeLocalJSONFile(LOCALITY_LEXICON, locality)
await writeLocalJSONFile(PROBES, texts)

await runMTFTokenizer([
	"paint",
	"--model",
	workspacePath("neural", "test", "fixtures", "tokenizer-v0.1.0.model"),
	"--lexicon",
	`street=${street}`,
	"--lexicon",
	`locality=${locality}`,
	"--texts",
	texts,
	"--out",
	painted,
])

const cases = (await readLocalJSONFile<PaintedCase[]>(painted)).map((c) => ({
	raw: c.raw,
	pieces: c.pieces.map(({ piece, start, end }) => ({ piece, start, end })),
	street: floatChannel(c.street),
	locality: floatChannel(c.locality),
}))

const fixture = {
	generated_by: "packages/neural/tools/fixtures/evidence-parity.run.ts",
	street_lexicon: STREET_LEXICON,
	locality_lexicon: LOCALITY_LEXICON,
	cases,
}

// JSON has one number form, so each float placeholder is written out as its Python literal after serializing.
const text = prettyJSON(fixture, true, 1).replaceAll(/"\\u0000([^"]*)"/g, "$1")

await writeLocalTextFile(text, out)
await runFile("yarn", ["oxfmt", out], { cwd: repoRootPath() })

console.log(`wrote ${out} (${cases.length} cases)`)
