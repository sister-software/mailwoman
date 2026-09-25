/**
 * Reports which board rows the weights-family routers send to a graph that cannot emit
 * the row's expected tags, and which rows the routers disagree about.
 *
 * The board has no routing label, so this tool derives one where it can.
 * A family's model card lists the tags its head can emit.
 *
 * When only one family can emit every tag in a row's `expectComponents`, that family is the row's label.
 * Neither the country nor the script mix can serve as a label, because mixed-script
 * rows route correctly to either family.
 *
 * Most rows have tags that every family can emit, so they get no label.
 * For those rows the tool prints where the routers disagree, for a human to label.
 * Router agreement does not imply a correct route.
 *
 * Two routers run:
 *
 * - `script` is the shipped router, `routeFamilyForText`.
 *   An abstention lets the caller's locale decide.
 * - `locale-hint` folds `detectLocale` from `@mailwoman/locale-hint` to a family.
 *
 * The model's `locale_logits` router is excluded because it needs loaded weights and a parse.
 *
 * Run:
 *
 *     node packages/mailwoman/lib/dev-tools/route-census.run.ts [--checking-only] [--out-json <path>]
 */

import { pathExists, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { dirtyTrackedFiles, gitHead } from "@mailwoman/core/git"
import { repoRootPath } from "@mailwoman/core/paths"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { formatPercent } from "@mailwoman/core/stats"
import { isoSeconds } from "@mailwoman/core/utils"
import { detectLocale, scoreByPostcode, scoreByScript } from "@mailwoman/locale-hint"
import {
	FAMILIES,
	familyForLocale,
	routeFamilyForText,
	routeFamilyWithLeadingRun,
	routeFamilyWithPostcode,
} from "@mailwoman/neural"
import { computeQueryShape } from "@mailwoman/query-shape"
import { JSONSpliterator } from "spliterator"
import { Globerator } from "spliterator/node/fs"

import { CASES_DIR } from "#eval-harness/gauntlet/cases/load"

const { values } = parseArguments({
	options: {
		"out-json": { type: "string" },
		"checking-only": { type: "boolean", default: false },
	},
})

/**
 * Stands for a router abstention in the answer tables.
 */
const CALLER = "(caller)"

/**
 * Sets the family an abstention resolves to, which is `resolveWeights`' default locale.
 *
 * Routers are compared after this resolution.
 * Otherwise an abstention and an explicit Latin answer would count as a disagreement
 * although both reach the same graph.
 */
const DEFAULT_CALLER_FAMILY = "en-us"

/**
 * Returns the graph a router answer reaches.
 */
function resolved(answer: string): string {
	return answer === CALLER ? DEFAULT_CALLER_FAMILY : answer
}

/**
 * Returns the family `detectLocale` implies, the locale it chose, and which scorer chose it.
 *
 * The locale is kept beside the family because they can diverge.
 * A romanized Japanese address gets `ja-JP` from its postcode, which folds to the
 * `cjk` family although the text is Latin script.
 */
function localeHintAnswer(text: string): { family: string; locale: string; reason: string } {
	const shape = computeQueryShape(text)
	const hint = detectLocale(shape)
	const postcode = scoreByPostcode(shape)
	const script = scoreByScript(shape)

	return {
		family: familyForLocale(hint.locale)?.family ?? CALLER,
		locale: hint.locale,
		reason: script ? "script" : postcode ? (postcode.reason ?? "postcode") : "fallback",
	}
}

/**
 * Reads the tags each family's head can emit from its model card, with the BIO prefix stripped.
 *
 * A family whose card is missing from the checkout is skipped, which shrinks
 * the graded set without mislabeling any row.
 */
async function emittableTags(): Promise<Map<string, ReadonlySet<string>>> {
	const out = new Map<string, ReadonlySet<string>>()

	for (const family of FAMILIES) {
		const card = repoRootPath("packages", `neural-weights-${family.family}`, "model-card.json")

		if (!(await pathExists(card))) continue

		const declared = (await readLocalJSONFile<{ labels?: unknown }>(card)).labels
		const labels = Array.isArray(declared) ? declared : Object.values(declared ?? {})

		out.set(family.family, new Set(labels.map((label) => String(label).replace(/^[BIOES]-/u, ""))))
	}

	return out
}

/**
 * Returns the only family that can emit every expected tag, or `undefined` when zero or several can.
 *
 * Most rows return `undefined` and need a human label.
 */
function familyByExpectedTags(
	expected: readonly string[],
	emittable: Map<string, ReadonlySet<string>>
): string | undefined {
	if (!expected.length) return undefined

	const capable = [...emittable].filter(([, tags]) => expected.every((tag) => tags.has(tag))).map(([family]) => family)

	return capable.length === 1 ? capable[0] : undefined
}

/**
 * Describes the fields this tool reads from a board row.
 */
interface BoardRow {
	id?: string
	input?: string
	country?: string
	status?: string
	addressKind?: string
	expectComponents?: Record<string, unknown>
}

/**
 * Describes a labeled row that the shipped router sends to the wrong family.
 */
interface Misroute {
	id: string
	country: string
	status: string
	routed: string
	truth: string
	input: string
	/**
	 * Lists the expected tags that the routed family cannot emit.
	 */
	unreachable: string[]
}

/**
 * Describes a row that the two routers send to different graphs.
 */
interface Disagreement {
	id: string
	country: string
	addressKind: string
	input: string
	script: string
	localeHint: string
	/**
	 * Holds the locale the hint chose and the scorer that chose it.
	 */
	hintLocale: string
	hintReason: string
	/**
	 * Describes the input's script mix, which helps a reader label the row.
	 */
	scripts: string
}

const casesRoot = CASES_DIR

/**
 * Matches the two-letter country directories the board loader reads, without recursion.
 *
 * This copies `COUNTRY_DIR` from `cases/load.ts` so the census covers exactly the rows the board grades.
 */
const COUNTRY_DIR = /^[a-z]{2}$/u

const emittable = await emittableTags()

const answers: Record<string, Record<string, number>> = { script: {}, "locale-hint": {} }
const byCountry = new Map<string, { rows: number; script: Record<string, number> }>()
const disagreements: Disagreement[] = []
const misroutes: Misroute[] = []

/**
 * Describes a row that a candidate router would send to a different graph than the shipped router does.
 */
interface MovedRow {
	id: string
	country: string
	status: string
	from: string
	to: string
	input: string
}

const movedByLeadingRun: MovedRow[] = []
const movedByPostcode: MovedRow[] = []

/**
 * Lists the unshipped candidate routers, which apply only where the shipped router abstains.
 *
 * Each candidate is reported on its own so the output shows which one moved each row.
 */
const CANDIDATES: ReadonlyArray<{ name: string; route: (text: string) => string; moved: MovedRow[] }> = [
	{
		name: "leading family-script run",
		route: (text) => routeFamilyWithLeadingRun(text).family ?? CALLER,
		moved: movedByLeadingRun,
	},
	{
		name: "postcode format",
		route: (text) => routeFamilyWithPostcode(text).family ?? CALLER,
		moved: movedByPostcode,
	},
]

let labeledByTags = 0

let rowsRead = 0
let graded = 0
let skippedNoInput = 0
let skippedNoCountry = 0
let skippedNotChecking = 0
let agreed = 0

const countryDirs = (await Globerator.from("*", { cwd: casesRoot, onlyFiles: false }).toArray()).filter((entry) =>
	COUNTRY_DIR.test(entry)
)

for (const dir of countryDirs) {
	const files = await Globerator.files("jsonl", {
		cwd: casesRoot(dir),
		absolute: true,
		recursive: false,
	}).toArray()

	for (const file of files) {
		for await (const row of JSONSpliterator.fromAsync<BoardRow>(file)) {
			rowsRead++

			if (!row.input) {
				skippedNoInput++

				continue
			}

			if (!row.country) {
				skippedNoCountry++

				continue
			}

			if (values["checking-only"] && row.status !== "pass") {
				skippedNotChecking++

				continue
			}

			graded++

			const script = routeFamilyForText(row.input).family ?? CALLER
			const hint = localeHintAnswer(row.input)
			const localeHint = hint.family

			for (const candidate of CANDIDATES) {
				const answered = candidate.route(row.input)

				if (answered === script) continue

				candidate.moved.push({
					id: row.id ?? "(no id)",
					country: row.country,
					status: row.status ?? "(none)",
					from: resolved(script),
					to: resolved(answered),
					input: row.input,
				})
			}

			answers.script![script] = (answers.script![script] ?? 0) + 1
			answers["locale-hint"]![localeHint] = (answers["locale-hint"]![localeHint] ?? 0) + 1

			const country = byCountry.get(row.country) ?? { rows: 0, script: {} }

			country.rows++
			country.script[script] = (country.script[script] ?? 0) + 1
			byCountry.set(row.country, country)

			// A row with a tag-derived label grades the shipped router.
			const expected = Object.keys(row.expectComponents ?? {})
			const byTags = familyByExpectedTags(expected, emittable)

			if (byTags) {
				labeledByTags++

				const reached = resolved(script)

				if (reached !== byTags) {
					misroutes.push({
						id: row.id ?? "(no id)",
						country: row.country,
						status: row.status ?? "(none)",
						routed: reached,
						truth: byTags,
						input: row.input,
						unreachable: expected.filter((tag) => !emittable.get(reached)?.has(tag)),
					})
				}
			}

			if (resolved(script) === resolved(localeHint)) {
				agreed++

				continue
			}

			disagreements.push({
				id: row.id ?? "(no id)",
				country: row.country,
				addressKind: row.addressKind ?? "(none)",
				input: row.input,
				script,
				localeHint,
				hintLocale: hint.locale,
				hintReason: hint.reason,
				scripts: (computeQueryShape(row.input).scripts ?? [])
					.map((entry) => `${entry.script} ${(entry.share * 100).toFixed(0)}%`)
					.join(" "),
			})
		}
	}
}

console.log(`\n# Route census — ${graded} rows of ${rowsRead} read\n`)
console.log(
	`Skipped: ${skippedNoInput} with no input, ${skippedNoCountry} with no country` +
		(values["checking-only"] ? `, ${skippedNotChecking} that track rather than check` : "")
)
console.log(
	`\nCompared on the graph each row reaches — an abstention resolves to \`${DEFAULT_CALLER_FAMILY}\`, the caller's ` +
		`own family — the routers agree on ${agreed} of ${graded} rows ` +
		`(${formatPercent(agreed, graded, 1)}) and send ${disagreements.length} to different graphs.\n` +
		`Agreement is separate from correctness: the label sets below grade rows both routers agree on.`
)

console.log(`\n## Graded by label set — ${labeledByTags} of ${graded} rows carry expected tags only one family emits\n`)

if (misroutes.length) {
	console.log(
		`The shipped router sends ${misroutes.length} of those ${labeledByTags} to a family that cannot emit what ` +
			`the row asks for. Those spans are unreachable on the routed graph whatever the model does.\n`
	)
	console.log(`| id | status | country | routed to | can emit them | tags it cannot emit | input |`)
	console.log(`| --- | --- | --- | --- | --- | --- | --- |`)

	for (const entry of misroutes) {
		console.log(
			`| \`${entry.id}\` | ${entry.status} | ${entry.country} | ${entry.routed} | ${entry.truth} | ` +
				`${entry.unreachable.join(", ")} | ${entry.input.replaceAll("|", "\\|")} |`
		)
	}
} else {
	console.log(`The shipped router sends every one of them to a family that can emit their tags.`)
}

// Candidates are measured over every board row, including rows outside each one's design set.
console.log(`\n## Candidate readings — measured and unshipped\n`)

for (const candidate of CANDIDATES) {
	console.log(
		`### ${candidate.name}\n\n` +
			`It would move ${candidate.moved.length} of ${graded} rows ` +
			`(${formatPercent(candidate.moved.length, graded, 1)}) to a different graph. Nothing serving reads it, and ` +
			`it is tried only where the shipped router abstained, so this list is the whole difference between the two ` +
			`arms.\n`
	)

	if (!candidate.moved.length) {
		console.log(`No row on this board reads differently under it.\n`)

		continue
	}

	const movedMisroutes = candidate.moved.filter((moved) => misroutes.some((entry) => entry.id === moved.id)).length
	const movedChecking = candidate.moved.filter((moved) => moved.status === "pass").length

	console.log(
		`${movedMisroutes} of the ${misroutes.length} rows the label sets grade as mis-routed are among them. ` +
			(movedChecking
				? `${movedChecking} of the moved rows check rather than track, so the board would grade the change on ` +
					`those at once.`
				: `Every moved row tracks rather than checks, so the board would report no pass or fail either way — ` +
					`whether the reading helps has to be measured by parsing the moved rows on both graphs.`) +
			"\n"
	)
	console.log(`| id | status | country | from | to | input |`)
	console.log(`| --- | --- | --- | --- | --- | --- |`)

	for (const entry of candidate.moved) {
		console.log(
			`| \`${entry.id}\` | ${entry.status} | ${entry.country} | ${entry.from} | ${entry.to} | ` +
				`${entry.input.replaceAll("|", "\\|")} |`
		)
	}

	console.log()
}

console.log(`\n## What each router answers\n`)
console.log(`| router | ${[...new Set(Object.values(answers).flatMap((a) => Object.keys(a)))].join(" | ")} |`)

const columns = [...new Set(Object.values(answers).flatMap((a) => Object.keys(a)))]

console.log(`| --- | ${columns.map(() => "--:").join(" | ")} |`)

for (const [name, tally] of Object.entries(answers)) {
	console.log(`| ${name} | ${columns.map((column) => tally[column] ?? 0).join(" | ")} |`)
}

console.log(`\n## Countries the shipped router sends off the caller's locale\n`)
console.log(`| country | rows | answers |`)
console.log(`| --- | --: | --- |`)

for (const [country, tally] of [...byCountry].toSorted((left, right) => right[1].rows - left[1].rows)) {
	const routed = Object.entries(tally.script).filter(([family]) => family !== CALLER)

	if (!routed.length) continue

	console.log(`| ${country} | ${tally.rows} | ${routed.map(([family, n]) => `${family} ${n}`).join(", ")} |`)
}

if (disagreements.length) {
	console.log(`\n## Rows needing a label — the routers disagree\n`)
	console.log(`| id | country | kind | script | locale-hint | its locale | named by | scripts | input |`)
	console.log(`| --- | --- | --- | --- | --- | --- | --- | --- | --- |`)

	for (const entry of disagreements) {
		console.log(
			`| \`${entry.id}\` | ${entry.country} | ${entry.addressKind} | ${entry.script} | ${entry.localeHint} | ` +
				`${entry.hintLocale} | ${entry.hintReason} | ${entry.scripts} | ${entry.input.replaceAll("|", "\\|")} |`
		)
	}
}

if (values["out-json"]) {
	await writeLocalJSONFile(
		{
			provenance: {
				ranAt: isoSeconds(),
				gitCommit: await gitHead(repoRootPath()),
				gitDirtyTrackedFiles: (await dirtyTrackedFiles(repoRootPath())).length,
				casesRoot: casesRoot.toString(),
				checkingOnly: values["checking-only"],
				rowsRead,
				graded,
				agreed,
				skipped: {
					noInput: skippedNoInput,
					noCountry: skippedNoCountry,
					notChecking: skippedNotChecking,
				},
				labeledByTags,
				truth:
					"per row: the family whose model card is the only one declaring every tag the row expects. Rows whose " +
					"tags every family emits carry no label and are reported as router disagreements instead.",
			},
			answers,
			byCountry: Object.fromEntries(byCountry),
			misroutes,
			disagreements,
		},
		values["out-json"]
	)

	console.log(`\nwrote ${values["out-json"]}`)
}
