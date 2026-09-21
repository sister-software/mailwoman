/**
 * The four surfaces #2303 is decided on, over the same US localities, through the production path.
 *
 * `Washington, DC 20003` answers a locality far less often than `123 Main St, Washington, DC 20003`
 * does, and the corpus reason is that no US recipe ever put a locality in front of
 * a region code and a postcode without a street ahead of it.
 * This renders one set of real localities four ways and reports the locality-match rate of each,
 * so the three-arm table on the issue and the reverse risk are one measurement rather than two.
 *
 * Teaching `«locality», «region» «postcode»` risks the inverse: a genuine street
 * before a region code read as a locality.
 * The reverse arm measures it by putting a street in that position and counting
 * how often it comes back tagged `locality`.
 *
 * A row whose locality is null there is correct.
 *
 * The panel is derived from the US coordinate set, one row per distinct locality, and the
 * street arm reuses that row's own street so no arm invents an address that does not exist.
 *
 * Three of the four arms render through `formatAddress` and the codex layouts (#2313)
 * and differ only in which components the dict carries.
 * `street_only` is the one that cannot: it puts a street name where a locality belongs,
 * and a renderer that produces well-formed addresses cannot express a deliberate malformation.
 *
 * That arm keeps its literal and says so in place.
 *
 * Each arm's rate ships with a per-name-shape and a per-tail-word table beside it,
 * because one rate hides the split this panel exists to show.
 * Read the per-word table for its row counts first: 24 of the 34 tail words carry one
 * or two panel rows, and `park` alone carries 11 of the bare arm's 31 suffix-bucket misses,
 * so a per-word rate here is a pointer to a question rather than an answer.
 *
 * `--out-json` carries every row's outcome for the same reason.
 *
 * Run:
 *
 *     node packages/mailwoman/lib/dev-tools/us/locality-region-postcode-arms.run.ts
 *     node packages/mailwoman/lib/dev-tools/us/locality-region-postcode-arms.run.ts --out-json <path>
 */

import { NAME_PRONE_US_SUFFIXES, US_STREET_SUFFIX_LOOKUP } from "@mailwoman/codex/us/street-suffix"
import { dataRootPath } from "@mailwoman/core/data-root"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { dirtyTrackedFiles, gitHead } from "@mailwoman/core/git"
import { sha256File } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { repoRootPath } from "@mailwoman/core/paths"
import type { QueryKind } from "@mailwoman/core/pipeline"
import { cliArguments, parseArguments, scriptEntryPath } from "@mailwoman/core/scripting/arguments"
import { formatPercent } from "@mailwoman/core/stats"
import { isoSeconds } from "@mailwoman/core/utils"

import { type PanelLocality, readCoordPanel, renderAdmin, suffixTail } from "#dev-tools/coord-panel"
import { buildGauntletDeps, type GauntletDepsOptions } from "#eval-harness/gauntlet/harness"
import { readWeightsIdentity } from "#eval-harness/preregistration"

const { values } = parseArguments({
	options: {
		"out-json": { type: "string" },
		"weights-cache": { type: "string" },
		// A declared ablation: replace the kind classifier's top verdict on every row.
		// `locality_only` is the verdict the postcode-removal arm was observed to produce,
		// so forcing it here separates "the verdict limits the decode" from "removing
		// the postcode changes the model's evidence".
		// The two the removal arm could not tell apart.
		"force-kind": { type: "string" },
		eval: { type: "string", default: String(dataRootPath("eval", "coord", "us.jsonl")) },
		// Which codex layout the three well-formed arms are written through.
		// The default matches the default panel.
		// A different panel needs its own country, because a layout is what makes the surface
		// idiomatic rather than a template that happens to suit one country.
		country: { type: "string", default: "US" },
		limit: { type: "string" },
	},
})

/**
 * The street of a coordinate row, with its house number removed.
 *
 * The reverse arm needs a street that stands where a locality would, and a house
 * number in front of it is the very cue that makes the shape unambiguous —
 * leaving it in would measure the arm that already works.
 */
function streetWithoutNumber(input: string): string | undefined {
	const head = input.split(",")[0]?.trim()

	if (!head) return undefined

	const rest = head.replace(/^\d+[A-Za-z]?\s+/, "").trim()

	return rest && rest !== head ? rest : undefined
}

const { localities, qualifiersStripped } = await readCoordPanel(values.eval!, {
	country: values.country,
	...(values.limit ? { limit: Number(values.limit) } : {}),
})

/**
 * One panel locality, with the street the reverse arm stands in place of it
 * where the row's own input carries one.
 *
 * The street is optional because only the reverse arm needs it, and a panel drawn
 * from a postcode export has no streets at all.
 * Requiring one dropped every row of such a panel and reported all four arms as `0/0` with a zero exit.
 * An empty read that looks exactly like a measured zero.
 *
 * The three forward arms take every row.
 * `street_only` takes the rows that carry a street and says how many that was.
 */
type ArmRow = PanelLocality & { street?: string }

const panel: ArmRow[] = localities.map((place) => {
	const street = streetWithoutNumber(place.input)

	return street ? { ...place, street } : place
})

const withStreet = panel.filter((row) => row.street).length

if (!panel.length) {
	throw new Error(
		`${values.eval} yielded no usable localities. A row needs expected.locality, expected.region, ` +
			`expected.postcode, lat and lon; a panel of the wrong country is filtered out by --country ${values.country}.`
	)
}

/**
 * The four surfaces, and what a correct answer looks like in each.
 *
 * `street_only` is the reverse arm and is graded inverted: the street must not be
 * read as a locality, so a row with no locality at all is the pass.
 */
const ARMS = [
	{
		name: "bare",
		inverted: false,
		render: (row: ArmRow) => renderAdmin(row),
	},
	{
		name: "with_country",
		inverted: false,
		render: (row: ArmRow) => renderAdmin(row, { country: "USA" }),
	},
	{
		name: "with_street",
		inverted: false,
		render: (row: ArmRow) => renderAdmin(row, { house_number: "123", street: "Main St" }),
	},
	{
		// This arm puts a street name where a locality belongs, to check the model does not read it as one.
		// A layout renders well-formed addresses and cannot express that, so this arm keeps a literal.
		name: "street_only",
		inverted: true,
		render: (row: ArmRow) => `${row.street}, ${row.region} ${row.postcode}`,
	},
] as const

/**
 * Misses printed per arm.
 *
 * Enough to read what the wrong answers look like.
 * The rate above them is the measurement.
 */
const EXAMPLES_PER_ARM = 5

/**
 * One row's outcome, carried into the JSON so a per-word reading needs no second run.
 */
interface RowOutcome {
	arm: string
	input: string
	/**
	 * The locality the panel names, and the one the run answered.
	 *
	 * Both are localities, so neither is `locality` alone.
	 * A field named for the tag says which tag, never which side of the comparison.
	 */
	expected: string
	answered: string | null
	matched: boolean
	suffixTail: string | null
	nameProne: boolean
	words: number
}

// A probe written to price a corpus change has to be able to point at the model that change produced.
// Without this it can only ever grade the installed one, which is the arm the change is measured against.
const depsOptions: GauntletDepsOptions = {
	...(values["weights-cache"] ? { weightsCacheRoot: values["weights-cache"] } : {}),
	...(values["force-kind"] ? { forceQueryKind: values["force-kind"] as QueryKind } : {}),
}

const deps = await buildGauntletDeps(depsOptions)
const report: Record<string, { matched: number; noLocality: number; total: number; examples: string[] }> = {}
const outcomes: RowOutcome[] = []

for (const arm of ARMS) {
	let matched = 0
	let noLocality = 0
	const examples: string[] = []

	// The reverse arm stands a real street where the locality belongs,
	// so it can only read rows that carry one.
	// The three forward arms read every row.
	const rows = arm.name === "street_only" ? panel.filter((row) => row.street) : panel

	for (const place of rows) {
		const input = arm.render(place)
		// The same country the arms were written in.
		// A run that renders through the FR layout and then resolves under a hardcoded
		// US scope grades a French surface against American candidates.
		const result = await deps.geocode(input, { defaultCountry: place.country })
		const locality = result.locality ?? null
		const tail = suffixTail(place.locality)

		outcomes.push({
			arm: arm.name,
			input,
			expected: place.locality,
			answered: locality,
			matched: locality === place.locality,
			suffixTail: tail ?? null,
			nameProne: tail ? NAME_PRONE_US_SUFFIXES.has(US_STREET_SUFFIX_LOOKUP.get(tail)!) : false,
			words: place.locality.trim().split(/\s+/).length,
		})

		if (locality === null) {
			noLocality++
		}

		if (locality === place.locality) {
			matched++
		}

		// What counts as a failure differs by arm, so the examples have to ask the arm.
		// `street_only` is graded inverted, and listing rows whose answer is not the
		// expected locality would print its passes under "misses".
		// Every one of them `null`, which is the answer that arm wants.
		const failed = arm.inverted ? locality !== null : locality !== place.locality

		if (failed && examples.length < EXAMPLES_PER_ARM) {
			examples.push(`${input} → answered ${stringifyJSON(locality)}, expected ${stringifyJSON(place.locality)}`)
		}
	}

	report[arm.name] = { matched, noLocality, total: rows.length, examples }
}

console.log(
	`#2303 arms — ${panel.length} distinct US localities, production path` +
		`\n${withStreet} of them carry a street in their own input; the reverse arm reads those and no others.` +
		(qualifiersStripped
			? `\n${qualifiersStripped} expected string(s) carried a trailing parenthetical qualifier, stripped before grading.`
			: "") +
		"\n"
)
console.log(`| arm | locality matched | no locality at all |`)
console.log(`| --- | --: | --: |`)

for (const arm of ARMS) {
	const r = report[arm.name]!

	console.log(`| ${arm.name} | ${formatPercent(r.matched, r.total)} (${r.matched}/${r.total}) | ${r.noLocality} |`)
}

console.log(
	`\nThe reverse arm is graded inverted: \`street_only\` wants NO locality, so its "no locality at all" column is` +
		` the pass count — ${report["street_only"]!.noLocality}/${panel.length}.`
)

for (const arm of ARMS) {
	const r = report[arm.name]!

	if (r.examples.length) {
		console.log(`\n${arm.name} misses:\n  ${r.examples.join("\n  ")}`)
	}
}

for (const arm of ARMS) {
	if (arm.inverted) continue

	const armRows = outcomes.filter((row) => row.arm === arm.name)

	const buckets = [
		["ends in a suffix word", armRows.filter((row) => row.suffixTail !== null)],
		["other multi-word", armRows.filter((row) => row.suffixTail === null && row.words > 1)],
		["single word", armRows.filter((row) => row.suffixTail === null && row.words === 1)],
	] as const

	console.log(`\n${arm.name} by name shape:\n\n| bucket | rows | miss rate |\n| --- | --: | --: |`)

	for (const [name, bucket] of buckets) {
		const missed = bucket.filter((row) => !row.matched).length

		console.log(`| ${name} | ${bucket.length} | ${formatPercent(missed, bucket.length)} (${missed}) |`)
	}

	const byWord = new Map<string, { rows: number; missed: number }>()

	for (const row of armRows) {
		if (row.suffixTail === null) continue

		const tally = byWord.get(row.suffixTail) ?? { rows: 0, missed: 0 }

		tally.rows++
		tally.missed += row.matched ? 0 : 1
		byWord.set(row.suffixTail, tally)
	}

	console.log(`\n${arm.name} per tail word:\n\n| word | name-prone | rows | missed |\n| --- | --- | --: | --: |`)

	for (const [word, tally] of [...byWord].toSorted((a, b) => b[1].missed - a[1].missed || b[1].rows - a[1].rows)) {
		const prone = NAME_PRONE_US_SUFFIXES.has(US_STREET_SUFFIX_LOOKUP.get(word)!)

		console.log(`| ${word} | ${prone ? "yes" : "no"} | ${tally.rows} | ${tally.missed} |`)
	}
}

if (values["out-json"]) {
	// A rate is only reproducible beside the four things that decide it: which panel bytes,
	// which model bytes, which checkout, and whether the checkout was clean when the run read it.
	// Two arms of this probe differ by the model alone, and a staged candidate's
	// model-card can be a symlink into the shared data root.
	// So the card version cannot tell the arms apart and the md5 is what the receipt is for.
	const repoRoot = repoRootPath()

	const provenance = {
		ranAt: isoSeconds(),
		gitCommit: await gitHead(repoRoot),
		gitDirtyTrackedFiles: (await dirtyTrackedFiles(repoRoot)).length,
		script: scriptEntryPath(),
		argv: cliArguments(),
		panelPath: values.eval,
		panelSHA256: await sha256File(values.eval),
		weightsCacheRoot: values["weights-cache"] ?? null,
		forcedQueryKind: values["force-kind"] ?? null,
		weights: await readWeightsIdentity(values["weights-cache"] ? { weightsCacheRoot: values["weights-cache"] } : {}),
	}

	await writeLocalJSONFile({ provenance, panel: panel.length, arms: report, rows: outcomes }, values["out-json"])

	console.log(
		`\nwrote ${values["out-json"]}\n  commit ${provenance.gitCommit}` +
			` · panel sha256 ${provenance.panelSHA256}\n  model ${provenance.weights.weightsModelMD5}` +
			` (card ${provenance.weights.weightsVersion})`
	)
}
