/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   What a two-letter uppercase token teaches: a region, a country, a street suffix, or something else (#2311).
 *
 *   `Marble Falls, AR 72648` answers no locality while `Beacon Falls, CT 06403` answers one, and a 2x2 over the same
 *   60 Arkansas names shows the region code carrying about half the recovery. The mixture's region mass does not
 *   explain which regions it favours — Arkansas holds 2.59% of US exposure and reads 2.3%, Vermont 0.05% and 100.0%.
 *   What is left is the surface: a code that opens a `country` span as often as a `region` one teaches both readings,
 *   and the decode has to pick.
 *
 *   No code list is typed. Every two-letter uppercase token that covers a whole span is counted with the tag it
 *   carries, and the contested set falls out of the data — `CT` is Connecticut and Court, `NL` is Newfoundland and the
 *   Netherlands, `AR` is Arkansas and Argentina. A typed list can only confirm a collision someone already suspected.
 *
 *   This counts the corpus pool. `census_region_code_token` in `mailwoman_train.audits` counts the emitted mixture,
 *   which is the pool after `source_weights` and after `augment_region_prob` writes region surfaces onto rows that
 *   carried none. The two answer different questions and the emitted one is the one an exposure decision is set
 *   against. this one needs no GPU, no Modal volume and no config.
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
		 * Print these codes in full regardless of rank.
		 *
		 * Everything else is ranked by total occurrences.
		 */
		codes: { type: "string" },
		/**
		 * Rows are also grouped by the row's `country`, so a code's two readings can
		 * be attributed to the countries that write them.
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
 * Unnesting three parallel lists in one select zips them positionally, so each row
 * of `spans` is one span with its own offsets and tag.
 *
 * `regexp_full_match` keeps only a span whose entire text is two uppercase letters,
 * which is the surface an address line writes a region code as.
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
 * One two-letter token: how often it opens each tag, and which countries write it that way.
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
 * The share of a token's occurrences held by its commonest tag.
 *
 * A token that teaches one reading is 1.0.
 * One the decode has to disambiguate is lower, and how much lower is the size of the contest.
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
 * A token whose commonest tag holds less than this share teaches more than one
 * reading at a rate the decode has to resolve.
 *
 * Set where a rounding artifact stops and a real second reading starts
 * rather than against a measured separation.
 */
const CONTESTED_DOMINANCE = 0.95

/**
 * Tokens below this many spans are dropped from the contested table.
 *
 * A handful of occurrences splitting two ways is a ratio over noise.
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
