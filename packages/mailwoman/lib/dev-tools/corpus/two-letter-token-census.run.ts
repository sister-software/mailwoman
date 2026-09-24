/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Count uppercase two-letter spans by tag and country to identify tokens used ambiguously as regions, countries, or
 *   other components. This reports corpus counts; the training audit reports the emitted mixture after weighting and
 *   augmentation.
 *
 *   Run:
 *
 *       node packages/mailwoman/lib/dev-tools/corpus/two-letter-token-census.run.ts
 *       node packages/mailwoman/lib/dev-tools/corpus/two-letter-token-census.run.ts --codes AR,VT,CT,NL --by-country
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { formatPercent } from "@mailwoman/core/stats"

import { openMixture, readMixtureFiles } from "#dev-tools/corpus/mixture"

const DEFAULT_CORPUS = dataRootPath(
	"corpus",
	"versioned",
	"v0.31.0-region-code-and-unit",
	"corpus-v0.31.0-region-code-and-unit"
).toString()

const { values } = parseArguments({
	options: {
		corpus: { type: "string", default: DEFAULT_CORPUS },
		split: { type: "string", default: "train" },
		"out-json": { type: "string" },
		/**
		 * Show these codes regardless of rank; rank other codes by frequency.
		 */
		codes: { type: "string" },
		/**
		 * Also group counts by country.
		 */
		"by-country": { type: "boolean", default: false },
		detail: { type: "string", default: "30" },
		"memory-limit": { type: "string", default: "8GB" },
		threads: { type: "string", default: "8" },
		files: { type: "string" },
	},
})

const mixture = await readMixtureFiles(values.corpus!, values.split!, values.files ? Number(values.files) : undefined)

const { db, fileList } = await openMixture(mixture.files, {
	memoryLimit: values["memory-limit"]!,
	threads: Number(values.threads),
})

/**
 * Unnest aligned span arrays and count spans consisting of exactly two uppercase letters.
 */
const sql = `
WITH spans AS (
	SELECT country, raw, unnest(span_starts) AS st, unnest(span_ends) AS en, unnest(span_tags) AS tg
	FROM read_parquet([${fileList}])
)
SELECT
	substring(raw, st + 1, en - st) AS text,
	tg AS tag,
	${values["by-country"] ? "country" : "NULL AS country"},
	count(*) AS n
FROM spans
WHERE regexp_full_match(substring(raw, st + 1, en - st), '[A-Z]{2}')
GROUP BY 1, 2, 3`

const started = Date.now()
const reader = await db.runAndReadAll(sql)

db.closeSync()

console.log(
	`${mixture.manifest.corpus_version} ${values.split}: ${mixture.files.length} of ${mixture.available} file(s), ` +
		`${mixture.rows.toLocaleString()} rows, ${Date.now() - started} ms\n`
)

/**
 * Counts for one token by tag and country.
 */
interface TokenCensus {
	text: string
	byTag: Map<string, number>
	byTagCountry: Map<string, Map<string, number>>
	total: number
}

const census = new Map<string, TokenCensus>()

for (const row of reader.getRowObjects()) {
	const text = String(row.text)
	const tag = String(row.tag)
	const n = Number(row.n)

	let entry = census.get(text)

	if (!entry) {
		entry = { text, byTag: new Map(), byTagCountry: new Map(), total: 0 }
		census.set(text, entry)
	}

	entry.byTag.set(tag, (entry.byTag.get(tag) ?? 0) + n)
	entry.total += n

	if (row.country != null) {
		const countries = entry.byTagCountry.get(tag) ?? new Map<string, number>()

		countries.set(String(row.country), (countries.get(String(row.country)) ?? 0) + n)
		entry.byTagCountry.set(tag, countries)
	}
}

/**
 * Fraction of occurrences assigned to the most common tag.
 */
function dominance(entry: TokenCensus): number {
	return entry.total === 0 ? 0 : Math.max(...entry.byTag.values()) / entry.total
}

function commonestTag(entry: TokenCensus): string {
	return [...entry.byTag].toSorted((a, b) => b[1] - a[1])[0]![0]
}

function tagBreakdown(entry: TokenCensus): string {
	return [...entry.byTag]
		.toSorted((a, b) => b[1] - a[1])
		.map(([tag, n]) => `${tag} ${n.toLocaleString()}`)
		.join(", ")
}

/**
 * Maximum dominant-tag share for the contested-token report.
 */
const CONTESTED_DOMINANCE = 0.95

/**
 * Minimum frequency for inclusion in the contested-token report.
 */
const CONTESTED_FLOOR = 1000

const asked = values.codes?.split(",").map((code) => code.trim().toUpperCase())
const ranked = [...census.values()].toSorted((a, b) => b.total - a.total)
const detail = Number(values.detail)

const shown = asked
	? asked.map((code) => census.get(code)).filter((entry) => entry !== undefined)
	: ranked.slice(0, detail)

if (asked) {
	const missing = asked.filter((code) => !census.has(code))

	if (missing.length) {
		console.log(`no span in the ${values.split} split is exactly: ${missing.join(", ")}\n`)
	}
}

console.log(`| token | spans | commonest tag | share | every tag |`)
console.log(`| --- | --: | --- | --: | --- |`)

for (const entry of shown) {
	console.log(
		`| ${entry.text} | ${entry.total.toLocaleString()} | ${commonestTag(entry)} ` +
			`| ${formatPercent(Math.max(...entry.byTag.values()), entry.total)} | ${tagBreakdown(entry)} |`
	)
}

const contested = ranked.filter(
	(entry) => entry.byTag.size > 1 && dominance(entry) < CONTESTED_DOMINANCE && entry.total >= CONTESTED_FLOOR
)

console.log(
	`\nContested — more than one tag, commonest under ${CONTESTED_DOMINANCE * 100}%, ` +
		`at least ${CONTESTED_FLOOR.toLocaleString()} spans: ${contested.length}\n`
)
console.log(`| token | spans | share of commonest | every tag |`)
console.log(`| --- | --: | --: | --- |`)

for (const entry of contested.slice(0, detail)) {
	console.log(
		`| ${entry.text} | ${entry.total.toLocaleString()} | ${(dominance(entry) * 100).toFixed(1)}% | ${tagBreakdown(entry)} |`
	)
}

if (values["out-json"]) {
	await writeLocalJSONFile(
		{
			corpus_version: mixture.manifest.corpus_version,
			split: values.split,
			files: mixture.files.length,
			tokens: ranked.map((entry) => ({
				text: entry.text,
				total: entry.total,
				by_tag: Object.fromEntries([...entry.byTag].toSorted((a, b) => b[1] - a[1])),
				by_tag_country: Object.fromEntries(
					[...entry.byTagCountry].map(([tag, countries]) => [
						tag,
						Object.fromEntries([...countries].toSorted((a, b) => b[1] - a[1]).slice(0, 12)),
					])
				),
			})),
		},
		values["out-json"]
	)

	console.log(`\nwrote ${values["out-json"]}`)
}
