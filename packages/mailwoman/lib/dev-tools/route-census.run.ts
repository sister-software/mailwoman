/**
 * Which rows the weights-family routers send to a graph that cannot produce the row's
 * expected tags, and which rows the candidate routers disagree about.
 *
 * `docs/engineering/CONTRIBUTING_MODEL_WORK.mdx` requires a route comparison before a
 * change sends an existing request to a different graph, and a comparison needs truth.
 * The gauntlet board declares no routing label.
 *
 * It does carry one for a subset, in a form that has to be derived: a row's `expectComponents` names
 * the tags a correct parse produces, a family's model card declares the tags its head can emit,
 * and a row whose expected tags only one family emits is labeled for that family by construction.
 * On the current board that is 26 rows of 1,029, and 7 of the 26 route to a
 * family that cannot emit what they ask for.
 *
 * The other 1,003 rows have no label, because their tags are in both families' vocabularies.
 * For those the tool reports where the routers disagree, which is the set a human has to adjudicate.
 *
 * A row states its country, its address kind and its expected components.
 * Nothing says which model graph should read it, and two obvious derivations
 * both fail on rows the board already holds.
 *
 * The country does not supply it.
 * `新加坡` is an SG row written wholly in Han, and `逊克二分场四队, HEILONGJIANG, CHINA`
 * is a CN row whose Han sits in one comma segment.
 *
 * Reading truth off the country would send both to the Latin family, which is the
 * reading `script-router.ts` records as measured wrong: under the whole-input fold
 * `Far East Chinese 口福羊汤, 13 Gerrard St, London W1D 5PS` came back `country: "Chi"`, `region: "Far East"`.
 *
 * The script share does not supply it either.
 * `逊克二分场四队, HEILONGJIANG, CHINA` carries 29.2% Han and routes to the character model.
 *
 * `Far East Chinese 口福羊汤, 13 Gerrard St, London W1D 5PS` carries 10.8% Han and stays on the Latin one.
 * Those distributions overlap, which is why `carriesFamilySegment` reads
 * where the Han sits rather than how much there is.
 *
 * A threshold fitted here would restate one router's rule and then grade that router against itself.
 *
 * Which scripts a family can encode settles nothing either.
 * The Latin SentencePiece model tokenizes `新加坡` as three pieces, `▁新` `加` `坡`, and
 * `neural-weights-cjk`'s `char-vocab.json` carries all 52 ASCII letters among its 4,451 entries.
 *
 * Each family represents the other's script.
 *
 * Which tags a family can emit does settle a row, and it is read from the model cards rather than argued.
 * `en-us` declares 33 labels and `cjk` declares 49, and `block`, `district`,
 * `municipality` and `prefecture` are in the second set alone.
 *
 * A row expecting any of those is unreachable on the Latin graph whatever script it is written in.
 * That is what labels the 26 rows, and it reaches rows a disagreement census cannot:
 * `jp-ws-jingumae-4-12-10-google-canonical` is mis-routed and both routers agree on it,
 * so agreement is not correctness and the two sections below answer different questions.
 *
 * This tool claims no confusion matrix over the whole board.
 * It grades the rows the label sets label, and for the rest it reports what each
 * router answered and prints the rows they disagree about.
 *
 * Two routers run here and a third is named:
 *
 * - `script` is the shipped router (`routeFamilyForText`).
 *   Abstaining means the caller's locale decides, which for a Latin request is
 *   the ordinary path rather than a failure.
 * - `locale-hint` is `@mailwoman/locale-hint`'s `detectLocale` folded to a family.
 *   It costs a query-shape computation and runs before any model.
 * - The model's `locale_logits` router is left out.
 *   Reading that output needs a parse, so a posterior route runs the primary graph before
 *   it can pick another one, and that cost belongs in the same measurement as its accuracy.
 *   Reading it also means loading weights, which this tool does not do.
 *
 * Run:
 *
 *     node packages/mailwoman/lib/dev-tools/route-census.run.ts
 *     node packages/mailwoman/lib/dev-tools/route-census.run.ts --checking-only --out-json <path>
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
import { join } from "path-ts"
import { JSONSpliterator } from "spliterator"
import { Globerator } from "spliterator/node/fs"

const { values } = parseArguments({
	options: {
		"out-json": { type: "string" },
		"checking-only": { type: "boolean", default: false },
	},
})

/**
 * What a router answered, with `(caller)` standing for an abstention so the two read in one column.
 */
const CALLER = "(caller)"

/**
 * The family an abstention resolves to, which is the family of the locale a process is opened with.
 *
 * Comparing the two routers means resolving this first.
 * The script router abstains on every Latin row and the locale hint names the Latin family,
 * and those are the same outcome: a process opened at `--locale en-US` loads the Latin family,
 * so "the caller decides" and "the Latin family" route the row to one graph.
 *
 * Comparing the raw answers instead reported 1,011 of 1,029 rows as disagreements,
 * every one of them a row both routers send to the same place.
 *
 * `en-us` because that is `resolveWeights`' own default locale.
 * A census of a process opened elsewhere would resolve abstentions to that locale's family instead.
 */
const DEFAULT_CALLER_FAMILY = "en-us"

/**
 * The graph a row reaches, which is what two routers have to be compared on.
 */
function resolved(answer: string): string {
	return answer === CALLER ? DEFAULT_CALLER_FAMILY : answer
}

/**
 * The family `detectLocale` implies, the locale it named, and which scorer named it.
 *
 * The locale travels with the family because the two are different claims
 * and this census turns on the difference.
 * `Rinrin, 3 Chome-57 Tenmanmachi, Takayama, Gifu 506-0025, Japan` is locale `ja-JP`, which the
 * locale hint gets right from `format=jp_postcode`, and the row is written entirely in Latin script.
 *
 * Folding that locale to a family answers `cjk` for a Latin row, and on this row
 * that answer reaches the only graph whose head vocabulary carries the `prefecture`
 * and `municipality` tags the row expects.
 * Whether that graph parses romaji well is unmeasured.
 *
 * The reason column reports which scorer decided, so a reader can tell a
 * postcode-named locale from a script-named one.
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
 * The tags each family's head can emit, read from its published model card.
 *
 * A card's labels are BIO-prefixed (`B-locality`, `I-locality`), so the prefix is
 * stripped to leave the tag a row's `expectComponents` is keyed by.
 * A family whose card is absent from the checkout contributes no tags and therefore
 * labels no row, which understates the graded set rather than mislabeling it.
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
 * The family a row's expected tags name, or `undefined` when more than one family could produce them.
 *
 * `undefined` is the ordinary answer.
 * It means the row's tags are in every family's vocabulary, so the label sets say nothing about
 * which graph should read it, and the row needs a human label instead.
 */
function familyByExpectedTags(
	expected: readonly string[],
	emittable: Map<string, ReadonlySet<string>>
): string | undefined {
	if (!expected.length) return undefined

	const capable = [...emittable].filter(([, tags]) => expected.every((tag) => tags.has(tag))).map(([family]) => family)

	return capable.length === 1 ? capable[0] : undefined
}

interface BoardRow {
	id?: string
	input?: string
	country?: string
	status?: string
	addressKind?: string
	expectComponents?: Record<string, unknown>
}

interface Misroute {
	id: string
	country: string
	status: string
	routed: string
	truth: string
	input: string
	/**
	 * The expected tags the routed family cannot emit.
	 *
	 * These are what makes the row unreachable.
	 */
	unreachable: string[]
}

interface Disagreement {
	id: string
	country: string
	addressKind: string
	input: string
	script: string
	localeHint: string
	/**
	 * The locale the hint named, and which of its scorers named it.
	 *
	 * A family disagreement whose locale is right is a different finding from one whose locale is wrong.
	 */
	hintLocale: string
	hintReason: string
	/**
	 * The input's script distribution, so a reader labeling the row sees what each router was looking at.
	 */
	scripts: string
}

const casesRoot = String(repoRootPath("packages", "mailwoman", "lib", "eval-harness", "gauntlet", "cases"))

/**
 * A case directory the board loads from: a two-letter country code, non-recursively.
 *
 * Copied from `cases/load.ts`'s `COUNTRY_DIR` rather than widened, so this
 * census reads the population the board reads.
 * A recursive glob over the whole tree instead returns 1,308 rows across 230 countries,
 * because it picks up `cases/generalization/country-sweep-2026-08-05-passes.jsonl` —
 * 279 rows the loader's directory rule excludes and `mwdev_compare` does not run.
 *
 * Measuring a router on rows the board never grades would report a mis-route nothing checks.
 */
const COUNTRY_DIR = /^[a-z]{2}$/u

const emittable = await emittableTags()

const answers: Record<string, Record<string, number>> = { script: {}, "locale-hint": {} }
const byCountry = new Map<string, { rows: number; script: Record<string, number> }>()
const disagreements: Disagreement[] = []
const misroutes: Misroute[] = []

/**
 * One row the candidate leading-run reading would send to a different graph
 * than the shipped router sends it to.
 *
 * The reading is tried after the shipped router and only when that router abstained,
 * so this list is the whole difference between the two arms.
 * Every row a change would move, and no row it would leave alone.
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
 * The candidate readings this tool measures, each tried after the shipped router
 * and only where that router abstained.
 *
 * Reported separately rather than as one arm.
 * They are different classes of evidence.
 *
 * One reads where a script sits, one reads a postal format — and a combined count
 * would not say which reading claimed a row.
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
		cwd: join(casesRoot, dir),
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

			// The label sets grade this row when they name exactly one family.
			// The shipped router is the arm graded, because it is the one deciding today.
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

// The candidate arms, reported on the whole board rather than on the rows each proposal was built from.
// `#2350` states its readings as hypotheses with rows they must move and rows they must not, and the
// board is hand-authored, so the count that decides anything is over every row rather than over those.
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
				casesRoot,
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
