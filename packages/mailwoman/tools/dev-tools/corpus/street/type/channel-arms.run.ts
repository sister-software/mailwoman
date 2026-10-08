/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Measures what the `street_type` evidence channel changes about the parsed street, over three arms
 *   on the same board rows and the same weights.
 *
 *   Three arms run. The first uses the shipped lexicon. The second switches the channel off. The third
 *   extends the shipped lexicon with street words for locales it omits. Each arm counts the rows whose
 *   assembled street name equals `expectComponents.street`, per country.
 *
 *   Each column answers a different question.
 *
 *   The ablated arm removes a channel the model trained with. `createScorer` prints the model card's
 *   own out-of-distribution warning when it does. A row whose street receives no paint under the
 *   shipped lexicon already feeds the channel a zero vector. Such a row cannot move between the
 *   shipped and the ablated arm, so those two columns measure the channel only over the locales the
 *   lexicon covers. The extended arm is the one that reaches a locale the lexicon omits.
 *
 *   The extended arm sits out of distribution in the opposite direction. It feeds a positive feature
 *   where training fed zero. A row it fixes does not predict how many rows a retrain would fix. A row
 *   it breaks does not refuse a retrain either. The count states whether the signal reaches the
 *   decision under the current weights. That answer decides whether a codex authoring pass and a
 *   training run are worth starting.
 *
 *   The probe lexicon is written under the scratch directory.
 *   `data/gazetteer/street-type-lexicon-v3.json` is an input to training and `lint-prose.ts` reads no
 *   JSON, so an edit to the committed artifact would reach a training run unreviewed.
 *
 *   Usage:
 *   node packages/mailwoman/tools/dev-tools/corpus/street/type/channel-arms.run.ts [--country ES,MX,IT] [--json <out>]
 */

import { slotNodes } from "@mailwoman/core/decoder"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { repoRootPathBuilder } from "@mailwoman/core/paths"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { createScorer } from "@mailwoman/neural/scorer"
import { resolveWeights } from "@mailwoman/neural/weights"

import { assembleStreetName } from "#street/name-assembly"
import { loadRegressionCases } from "#tools/eval-harness/gauntlet/cases/load"

/**
 * Street words for locales `street-type-lexicon-v3.json` omits, for the extended arm only.
 *
 * The list is a probe rather than a proposal.
 * A real pass adds each word to the codex locale module that `evidence-lexicons.ts` reads,
 * under that locale's own spelling rules and abbreviations.
 *
 * Only then do the training-side scan and the inference-side scan read the same words.
 *
 * Each list is that locale's ordinary street vocabulary.
 * Spain and Latin America share `calle` and `avenida` under `es` and differ
 * on `cerrada`, `privada` and `andador`.
 *
 * `ca` is Catalan, and its `carrer` appears in the Barcelona board rows.
 * `it`, `nl` and `pt` each cover their own.
 */
const PROBE_STREET_WORDS: Readonly<Record<string, readonly string[]>> = {
	es: [
		"calle",
		"avenida",
		"avda",
		"paseo",
		"camino",
		"plaza",
		"plazuela",
		"glorieta",
		"ronda",
		"travesia",
		"travesía",
		"cuesta",
		"callejon",
		"callejón",
		"cerrada",
		"privada",
		"andador",
		"calzada",
		"prolongacion",
		"prolongación",
		"boulevard",
		"bulevar",
		"circuito",
		"retorno",
		"eje",
	],
	ca: ["carrer", "avinguda", "passeig", "placa", "plaça", "rambla", "carreto", "cami", "camí", "travessera"],
	it: ["via", "viale", "corso", "piazza", "piazzale", "vicolo", "largo", "strada", "lungomare", "contrada", "borgo"],
	nl: ["straat", "laan", "weg", "plein", "gracht", "kade", "dijk", "singel", "steeg", "dreef", "pad"],
	pt: ["rua", "avenida", "travessa", "largo", "praca", "praça", "alameda", "estrada", "beco", "ladeira", "rodovia"],
}

/**
 * The single-word abbreviations the probe adds.
 * The artifact matches an `entries` key case-insensitively.
 *
 * `c` is the Spanish abbreviation of `calle` and appears as `C.` in the Madrid rows.
 * It is one letter, so it also matches any single `c` elsewhere in a line.
 *
 * The extended arm pays that cost.
 * A real authoring pass would use the artifact's case-sensitive `code_entries`
 * rules for an abbreviation this short.
 */
const PROBE_ABBREVIATIONS: readonly string[] = ["c", "av", "avda", "ctra", "v", "p"]

const { values } = parseArguments({
	options: {
		country: { type: "string", description: "Comma-separated ISO country codes (default: every country)" },
		json: { type: "string", description: "Write the per-row verdicts to this path" },
	},
})

const wantedCountries = new Set(
	(values.country ?? "")
		.split(",")
		.map((code) => code.trim().toUpperCase())
		.filter((code) => code.length > 0)
)

const shippedLexiconPath = repoRootPathBuilder("data", "gazetteer", "street-type-lexicon-v3.json")

interface LexiconFile {
	entries: Record<string, number>
	code_entries: Record<string, number>
	bits: Record<string, number>
	generated_by?: string
	[key: string]: unknown
}

const shipped = await readLocalJSONFile<LexiconFile>(shippedLexiconPath)
const streetTypeBit = shipped.bits["street_type"]

if (streetTypeBit === undefined) {
	throw new Error(`${shippedLexiconPath} declares no street_type bit, so the probe cannot set one.`)
}

await using scratch = await temporaryDirectory("street-type-probe-")

const added: string[] = []
const extendedEntries = { ...shipped.entries }

for (const words of Object.values(PROBE_STREET_WORDS)) {
	for (const word of words) {
		if (!(word in extendedEntries)) {
			extendedEntries[word] = streetTypeBit
			added.push(word)
		}
	}
}

for (const abbreviation of PROBE_ABBREVIATIONS) {
	if (!(abbreviation in extendedEntries)) {
		extendedEntries[abbreviation] = streetTypeBit
		added.push(abbreviation)
	}
}

const extendedPath = scratch.path("street-type-lexicon-probe.json")

await writeLocalJSONFile(
	{
		...shipped,
		entries: extendedEntries,
		generated_by: `${shipped.generated_by ?? "(unstated)"} + probe words for es/ca/it/nl/pt (NOT a release artifact)`,
	},
	extendedPath
)

console.log(`shipped lexicon: ${Object.keys(shipped.entries).length} entries`)
console.log(`probe lexicon:   ${Object.keys(extendedEntries).length} entries  (+${added.length})`)
console.log(`  written to ${extendedPath}\n`)

const weights = await resolveWeights({})
const modelCardPath = weights.modelCardPath ?? weights.baseModelCardPath

if (!modelCardPath) {
	throw new Error(`The weights at ${weights.modelPath} resolved no model-card.json, so the label set is unknown.`)
}

/**
 * One measurement arm: a scorer over the same weights with a different `street_type` input.
 */
interface Arm {
	key: "shipped" | "ablated" | "extended"
	label: string
	build: () => Promise<Awaited<ReturnType<typeof createScorer>>>
}

const base = {
	modelPath: weights.modelPath,
	tokenizerPath: weights.tokenizerPath,
	modelCardPath,
	strict: true,
	tier: "server",
} as const

const arms: readonly Arm[] = [
	{ key: "shipped", label: "shipped lexicon", build: () => createScorer({ ...base }) },
	{
		key: "ablated",
		label: "no street_type channel",
		build: () => createScorer({ ...base, overrides: { streetType: "off" } }),
	},
	{
		key: "extended",
		label: "shipped plus probe words",
		build: () => createScorer({ ...base, streetTypeLexiconPath: extendedPath.toString() }),
	},
]

const cases = (await loadRegressionCases()).filter((seed) => {
	if (!seed.expectComponents?.street) return false

	return wantedCountries.size === 0 || wantedCountries.has((seed.country ?? "").toUpperCase())
})

console.log(`rows with an expected street: ${cases.length}\n`)

interface RowVerdict {
	id: string
	country: string
	expected: string
	byArm: Record<string, string | null>
}

const verdicts = new Map<string, RowVerdict>()

for (const arm of arms) {
	const scorer = await arm.build()

	for (const seed of cases) {
		const tree = await scorer.parse(seed.input, { postcodeRepair: true })
		// The `street` tag holds the bare base by itself: `East Sheldon Rd` reads `Sheldon`.
		// `extractGeocodeResult` reports the assembled family name, and the board compares that.
		// The pick and the assembly below are the same two calls it makes.
		const streetNode = slotNodes(tree.roots).find((node) => node.tag === "street")
		const parsed = streetNode ? assembleStreetName(streetNode) || null : null
		const country = (seed.country ?? "").toUpperCase()

		const verdict = verdicts.get(seed.id) ?? {
			id: seed.id,
			country,
			expected: seed.expectComponents!.street!,
			byArm: {},
		}

		verdict.byArm[arm.key] = parsed
		verdicts.set(seed.id, verdict)
	}
}

const exact = (verdict: RowVerdict, key: string): boolean =>
	(verdict.byArm[key] ?? "").trim().toLowerCase() === verdict.expected.trim().toLowerCase()

const byCountry = new Map<string, { rows: number; shipped: number; ablated: number; extended: number }>()

for (const verdict of verdicts.values()) {
	const entry = byCountry.get(verdict.country) ?? { rows: 0, shipped: 0, ablated: 0, extended: 0 }

	entry.rows++

	for (const arm of arms) {
		if (exact(verdict, arm.key)) {
			entry[arm.key]++
		}
	}

	byCountry.set(verdict.country, entry)
}

const totals = { rows: 0, shipped: 0, ablated: 0, extended: 0 }

for (const entry of byCountry.values()) {
	totals.rows += entry.rows
	totals.shipped += entry.shipped
	totals.ablated += entry.ablated
	totals.extended += entry.extended
}

console.log(`street exact match, out of ${totals.rows} rows:`)

for (const arm of arms) {
	console.log(`  ${arm.label.padEnd(26)} ${String(totals[arm.key]).padStart(4)}`)
}

console.log(`\nper country  (rows / shipped / ablated / extended):`)

for (const [code, entry] of [...byCountry].toSorted((a, b) => b[1].rows - a[1].rows)) {
	const moved = entry.extended !== entry.shipped || entry.ablated !== entry.shipped ? "  <- moved" : ""

	console.log(
		`  ${code.padEnd(4)} ${String(entry.rows).padStart(4)}` +
			` ${String(entry.shipped).padStart(4)}` +
			` ${String(entry.ablated).padStart(4)}` +
			` ${String(entry.extended).padStart(4)}${moved}`
	)
}

const movedRows = [...verdicts.values()].filter(
	(verdict) =>
		verdict.byArm["shipped"] !== verdict.byArm["ablated"] || verdict.byArm["shipped"] !== verdict.byArm["extended"]
)

console.log(`\nrows where any arm parsed a different street: ${movedRows.length} of ${totals.rows}`)

for (const verdict of movedRows.slice(0, 25)) {
	console.log(`\n  ${verdict.id} (${verdict.country})`)
	console.log(`    expected: ${verdict.expected}`)

	for (const arm of arms) {
		const mark = exact(verdict, arm.key) ? "match" : "     "

		console.log(`    ${mark}  ${arm.label.padEnd(26)} ${verdict.byArm[arm.key] ?? "(no street)"}`)
	}
}

if (values.json) {
	await writeLocalJSONFile(
		{
			shippedLexicon: shippedLexiconPath.toString(),
			probeWordsAdded: added,
			totals,
			byCountry: [...byCountry].map(([country, entry]) => ({ country, ...entry })),
			verdicts: [...verdicts.values()],
		},
		values.json
	)

	console.log(`\nwrote ${values.json}`)
}
