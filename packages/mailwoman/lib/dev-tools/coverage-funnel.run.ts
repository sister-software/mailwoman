/**
 * The ten-stage coverage funnel over every jurisdiction the source register carries, plus the incumbency grouping and
 * the inputs a work-selection ranking would read.
 *
 * `mailwoman data coverage` reports the countries the five registers mention. This reports the 250 the register knows,
 * so a jurisdiction that appears in none of them still gets a row saying so at every stage. The difference between the
 * two denominators is printed, because that difference is the population a failure-driven roadmap cannot see.
 *
 * Every stage carries a state and a reason. `unknown` says this instrument cannot answer the stage from a checkout —
 * `sampled` reads it until an `audit_epoch_mixture` output is supplied — and it is never a claim about the
 * jurisdiction.
 *
 * Run:
 *
 *     node packages/mailwoman/lib/dev-tools/coverage-funnel.run.ts
 *     node packages/mailwoman/lib/dev-tools/coverage-funnel.run.ts --out-json <path>
 *     node packages/mailwoman/lib/dev-tools/coverage-funnel.run.ts --config <training config> --rows
 *     node packages/mailwoman/lib/dev-tools/coverage-funnel.run.ts --mixture-audit <epoch-mixture-audit.json>
 *
 * `--mixture-audit` takes what `python -m mailwoman_train.audits.epoch_mixture --json` writes and fills the `sampled`
 * stage. Without it that stage reads `unknown` for all 250, because how many rows a country contributes to an epoch is
 * a property of a run.
 */

import { POSTAL_REGIMES } from "@mailwoman/codex/postal-regimes"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { dirtyTrackedFiles, gitHead } from "@mailwoman/core/git"
import { repoRootPath } from "@mailwoman/core/paths"
import { dRuleCountries, readScopeConfig, tieredCountries } from "@mailwoman/core/scope-config"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { formatPercent } from "@mailwoman/core/stats"
import { isoSeconds } from "@mailwoman/core/utils"

import { censusCoverage, newestManifest } from "#coverage/index"
import {
	FUNNEL_STAGES,
	incumbencyGroups,
	OPPORTUNITY_INPUTS,
	opportunityCandidates,
	readCoverageFunnel,
	StageState,
} from "#eval-harness/coverage-funnel"

const { values } = parseArguments({
	options: {
		"out-json": { type: "string" },
		config: { type: "string" },
		"mixture-audit": { type: "string" },
		rows: { type: "boolean", default: false },
	},
})

/**
 * What `mailwoman_train.audits.epoch_mixture --json` writes, down to the two fields this reads.
 *
 * The emitted level is the one that answers the stage. Draw level counts what the sampler pulled, and emitted level
 * counts what survived augmentation to fill the trainer's row budget — the rows a run actually trains on.
 */
interface EpochMixtureAudit {
	emitted_level?: { by_country?: Record<string, number> }
}

/**
 * Rows sampled per country in one audited epoch, and the epoch's total.
 *
 * A country absent from `by_country` stays absent from the map rather than reading zero. The funnel then leaves its
 * `sampled` stage `unknown`: the audit reports the countries it drew, and a name it never mentions was not measured.
 */
async function readMixtureAudit(path: string): Promise<{ rows: Map<string, number>; total: number }> {
	const audit = await readLocalJSONFile<EpochMixtureAudit>(path)
	const byCountry = audit.emitted_level?.by_country

	if (!byCountry) {
		throw new Error(
			`${path} carries no \`emitted_level.by_country\`. That is the field this reads, and a file without it is ` +
				"either a different report or a truncated one — either way it cannot answer the sampled stage."
		)
	}

	const rows = new Map(Object.entries(byCountry))

	return { rows, total: [...rows.values()].reduce((sum, count) => sum + count, 0) }
}

/**
 * The training config the `admitted` stage reads when the caller names none.
 *
 * Named rather than discovered. `newestConfig` picks by modification time, and on a fresh clone every config carries
 * the checkout's timestamp, so the pick is arbitrary: this run selected `v0_4_0-stableLR-cw-only.yaml`, whose
 * `country_weights` admits 2 countries, and the `admitted` row read 2 of 250 as though that were a property of the
 * repository. Which config is read decides what the whole stage means, so it is stated here and printed with the
 * report.
 */
const DEFAULT_TRAINING_CONFIG = "corpus-python/src/mailwoman_train/configs/v5.9.0-locality-shape-60k.yaml"

const repoRoot = repoRootPath()
const configPath = values.config ?? String(repoRootPath(...DEFAULT_TRAINING_CONFIG.split("/")))
const manifestPath = await newestManifest()

if (!configPath || !manifestPath) {
	throw new Error(
		`no training config (${String(configPath)}) or corpus manifest (${String(manifestPath)}) — that is an absence of FILES, not of coverage`
	)
}

const report = await censusCoverage({
	configPath,
	manifestPath,
	casesRoot: String(repoRootPath("packages", "mailwoman", "lib", "eval-harness", "gauntlet", "cases")),
})

const scope = await readScopeConfig(repoRoot)

const mixture = values["mixture-audit"] ? await readMixtureAudit(values["mixture-audit"]) : undefined

const funnel = await readCoverageFunnel({
	coverage: report.countries,
	tieredCountries: [...tieredCountries(scope)],
	protectedCountries: dRuleCountries(scope).map((entry) => entry.country),
	...(values["mixture-audit"] ? { mixtureAudit: values["mixture-audit"] } : {}),
	...(mixture ? { sampledRows: mixture.rows, sampledTotal: mixture.total } : {}),
})

console.log(`\n# Coverage funnel — ${funnel.provenance.jurisdictions} jurisdictions`)
console.log(`\nRegister ${funnel.provenance.registerVersion}. Training config ${configPath}.`)
console.log(
	`The census report carried ${funnel.provenance.censusCountries} countries, so ` +
		`${funnel.provenance.jurisdictions - funnel.provenance.censusCountries} jurisdictions appear in none of its ` +
		"five registers and would be absent from a report keyed on their union."
)

console.log(
	`\nThe stages are not one pipeline. \`licensed\`, \`addressRole\` and \`coverage\` describe the source register's ` +
		`researched sources; \`corpusRows\`, \`admitted\` and \`sampled\` describe the training corpus, which is fed by ` +
		`adapters and carries its own per-row licence. The two populations overlap without matching, so a jurisdiction ` +
		`holds both readings at once rather than passing from one into the other.`
)

console.log(`\n| stage | reached | absent | blocked | unknown |`)
console.log(`| --- | --: | --: | --: | --: |`)

for (const stage of FUNNEL_STAGES) {
	const counts = funnel.byStage[stage]
	const total = funnel.provenance.jurisdictions

	console.log(
		`| ${stage} | ${counts[StageState.Reached]} (${formatPercent(counts[StageState.Reached], total, 1)}) | ` +
			`${counts[StageState.Absent]} | ${counts[StageState.Blocked]} | ${counts[StageState.Unknown]} |`
	)
}

/**
 * How many country codes a group's cell prints before it counts the rest.
 *
 * Presentation only. The shallow groups hold over a hundred codes each, and a cell carrying all of them wraps past the
 * width a terminal table stays readable at. `--out-json` writes every code.
 */
const CODES_PER_GROUP_CELL = 18

console.log(`\n## Incumbency — jurisdictions by stages reached\n`)
console.log(`| stages reached | jurisdictions | which |`)
console.log(`| --: | --: | --- |`)

for (const group of incumbencyGroups(funnel)) {
	const shown = group.jurisdictions.slice(0, CODES_PER_GROUP_CELL).join(" ")
	const hidden = group.jurisdictions.length - CODES_PER_GROUP_CELL
	const rest = hidden > 0 ? ` … +${hidden}` : ""

	console.log(`| ${group.reached} | ${group.jurisdictions.length} | ${shown}${rest} |`)
}

console.log(`\nWhich roadmap items were selected from each group is not derivable here. State it beside this table.`)

console.log(`\n## Opportunity inputs\n`)
console.log(`| input | this instrument supplies it | from |`)
console.log(`| --- | --- | --- |`)

for (const entry of OPPORTUNITY_INPUTS) {
	console.log(`| ${entry.input} | ${entry.supplied ? "yes" : "no"} | ${entry.from} |`)
}

console.log(
	`\nExisting package and board coverage is deliberately absent from that list. It lowers what work costs and is ` +
		`not evidence of need.`
)

const candidates = opportunityCandidates(funnel)

console.log(
	`\n## Candidates — a verified source is researched and the corpus holds no row\n\n` +
		`A filter on two of the five inputs above, ordered by how far the source research got. The three inputs it ` +
		`cannot read are the ones that would order these against each other.\n`
)
console.log(`| iso2 | jurisdiction | backbone | admitted | terms elected |`)
console.log(`| --- | --- | --- | --- | --- |`)

for (const entry of candidates) {
	console.log(
		`| ${entry.iso2} | ${entry.name} | ${entry.backboneState} | ${entry.admitted ? "yes" : "no"} | ` +
			`${entry.licensed ? "yes" : "no"} |`
	)
}

const admittedAndEmpty = candidates.filter((entry) => entry.admitted).length

console.log(
	`\n${candidates.length} candidates. ${admittedAndEmpty} are admitted by the training config and still contribute ` +
		`no row, which is a defect in the config rather than a gap in the corpus.`
)

// The funnel counts jurisdictions, and a jurisdiction is not always the parser unit. A regime reported here is one
// whose addresses the funnel's row for its parent country says nothing about: SH's row describes one place where
// three postal systems live, and a BFPO address is counted under GB while nothing parses it as GB.
console.log(`\n## Postal regimes — where the parser unit is not the ISO country code\n`)
console.log(`| regime | kind | ISO | coverage | parent jurisdictions' stages reached |`)
console.log(`| --- | --- | --- | --- | --- |`)

const reachedByCountry = new Map(funnel.rows.map((row) => [row.iso2, row.reached]))

for (const regime of POSTAL_REGIMES) {
	const parents = regime.iso2.map((code) => `${code}:${reachedByCountry.get(code) ?? "—"}`).join(" ")

	console.log(`| ${regime.regimeID} | ${regime.kind} | ${regime.iso2.join(" ")} | ${regime.coverage} | ${parents} |`)
}

const unmodeled = POSTAL_REGIMES.filter((regime) => regime.coverage !== "modeled").length

console.log(
	`\n${unmodeled} of ${POSTAL_REGIMES.length} regimes are not modeled. An address written in one of those parses ` +
		`as an ordinary address of its parent country, and the parent's funnel row says nothing about that.`
)

if (values.rows) {
	console.log(`\n## Per jurisdiction\n`)
	console.log(`| iso2 | name | backbone | reached | ${FUNNEL_STAGES.join(" | ")} |`)
	console.log(`| --- | --- | --- | --: | ${FUNNEL_STAGES.map(() => "---").join(" | ")} |`)

	for (const row of funnel.rows) {
		const cells = FUNNEL_STAGES.map((stage) => row.stages[stage].state)

		console.log(`| ${row.iso2} | ${row.name} | ${row.backboneState} | ${row.reached} | ${cells.join(" | ")} |`)
	}
}

if (values["out-json"]) {
	await writeLocalJSONFile(
		{
			provenance: {
				ranAt: isoSeconds(),
				gitCommit: await gitHead(repoRoot),
				gitDirtyTrackedFiles: (await dirtyTrackedFiles(repoRoot)).length,
				configPath,
				manifestPath,
				...funnel.provenance,
			},
			byStage: funnel.byStage,
			incumbency: incumbencyGroups(funnel),
			opportunityInputs: OPPORTUNITY_INPUTS,
			opportunityCandidates: candidates,
			rows: funnel.rows,
		},
		values["out-json"]
	)

	console.log(`\nwrote ${values["out-json"]}`)
}
