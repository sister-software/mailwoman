/**
 * The twelve-stage coverage funnel over every jurisdiction the source register carries,
 * plus the incumbency grouping and the inputs a work-selection ranking would read.
 *
 * `mailwoman data coverage` reports the countries the five registers mention.
 * This reports the 250 the register knows, so a jurisdiction that appears in none
 * of them still gets a row saying so at every stage.
 *
 * The difference between the two denominators is printed, because that difference
 * is the population a failure-driven roadmap cannot see.
 *
 * Every stage carries a state and a reason.
 * `unknown` says this instrument cannot answer the stage from a checkout — `sampled` reads it
 * until an `audit_epoch_mixture` output is supplied — and it is never a claim about the jurisdiction.
 *
 * Run:
 *
 *     node packages/mailwoman/lib/dev-tools/coverage-funnel.run.ts
 *     node packages/mailwoman/lib/dev-tools/coverage-funnel.run.ts --out-json <path>
 *     node packages/mailwoman/lib/dev-tools/coverage-funnel.run.ts --config <training config> --rows
 *     node packages/mailwoman/lib/dev-tools/coverage-funnel.run.ts --mixture-audit <epoch-mixture-audit.json>
 *
 * Without `--config` the `admitted` stage reads the config `scope.config.json` records
 * for the Latin family's shipped graph, which admits 25 countries.
 * The v5.9.0 in-flight config admits 135, so the stage reads a different number for
 * the same repository depending on which question is asked.
 *
 * The report names the file it read either way, and prints the union across both shipped graphs beside it.
 *
 * `--mixture-audit` takes what `python -m mailwoman_train.audits.epoch_mixture --json`
 * writes and fills the `sampled` stage.
 * Without it that stage reads `unknown` for all 250, because how many rows a country
 * contributes to an epoch is a property of a run.
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

import { admittedByShippedGraphs, resolveTrainingConfig } from "#coverage/census"
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
 * The emitted level is the one that answers the stage.
 * Draw level counts what the sampler pulled, and emitted level counts what survived
 * augmentation to fill the trainer's row budget — the rows a run actually trains on.
 */
interface EpochMixtureAudit {
	emitted_level?: { by_country?: Record<string, number> }
	meta?: { config?: string }
}

/**
 * Rows sampled per country in one audited epoch, and the epoch's total.
 *
 * A country absent from `by_country` stays absent from the map rather than being
 * written in as zero, and the funnel decides what that absence means.
 * `by_country` enumerates every country the audit drew, so a country the audit
 * never mentions drew zero of the audit's own denominator.
 *
 * An admitted country therefore reads `blocked` with that denominator beside it,
 * which is a measured zero rather than an unknown.
 * A country the config never admitted reads `absent`, since it had nothing to draw.
 *
 * Refuses an audit produced from a config other than the one the `admitted` stage reads.
 * Both stages describe one training arm, and reading them from two configs puts two arms in one column:
 * a run of this tool read `admitted` from the shipped Latin config, which admits 25 countries,
 * beside a `sampled` stage from `v5.9.0-locality-shape-60k.yaml`, which admits 135.
 *
 * So `sampled` reported 38 countries drawn while `admitted` reported 25,
 * and a country could appear in the second and not the first.
 */
async function readMixtureAudit(
	path: string,
	configPath: string
): Promise<{ rows: Map<string, number>; total: number }> {
	const audit = await readLocalJSONFile<EpochMixtureAudit>(path)
	const byCountry = audit.emitted_level?.by_country

	if (!byCountry) {
		throw new Error(
			`${path} carries no \`emitted_level.by_country\`. That is the field this reads, and a file without it is ` +
				"either a different report or a truncated one — either way it cannot answer the sampled stage."
		)
	}

	// The audit runs on the volume and records an absolute path under `/data`, so only the filename is comparable.
	const audited = audit.meta?.config?.split("/").at(-1)
	const wanted = configPath.split("/").at(-1)

	if (audited && wanted && audited !== wanted) {
		throw new Error(
			`the mixture audit was produced from ${audited} and the admitted stage reads ${wanted}. Those are two ` +
				"training arms, and reporting them in one table would put a country in `sampled` that `admitted` " +
				`excludes. Re-run the audit against ${wanted}, or pass --config ${audited}.`
		)
	}

	const rows = new Map(Object.entries(byCountry))

	return { rows, total: [...rows.values()].reduce((sum, count) => sum + count, 0) }
}

const repoRoot = repoRootPath()
const scope = await readScopeConfig(repoRoot)
const config = resolveTrainingConfig(scope, { requested: values.config })
const configPath = config.path
const manifestPath = await newestManifest()

if (!manifestPath) {
	throw new Error(
		`no corpus manifest under the data root — that is an absence of FILES, not of coverage. The config resolved to ${configPath}.`
	)
}

const report = await censusCoverage({
	configPath,
	manifestPath,
	casesRoot: repoRootPath("packages", "mailwoman", "lib", "eval-harness", "gauntlet", "cases"),
})

const mixture = values["mixture-audit"] ? await readMixtureAudit(values["mixture-audit"], configPath) : undefined

const funnel = await readCoverageFunnel({
	coverage: report.countries,
	tieredCountries: [...tieredCountries(scope)],
	protectedCountries: dRuleCountries(scope).map((entry) => entry.country),
	...(values["mixture-audit"] ? { mixtureAudit: values["mixture-audit"] } : {}),
	...(mixture ? { sampledRows: mixture.rows, sampledTotal: mixture.total } : {}),
})

console.log(`\n# Coverage funnel — ${funnel.provenance.jurisdictions} jurisdictions`)
console.log(
	`\nRegister ${funnel.provenance.registerVersion}. Training config ${configPath} (${config.provenance}` +
		`${config.family ? `, weights family ${config.family}` : ""}).`
)

// The `admitted` stage reads one config, and one config answers for one graph.
// Printing the shipped union beside it keeps a reader from taking an in-flight
// config's admissions for the countries a released model trains.
const shippedAdmitted = await admittedByShippedGraphs(scope)
const shippedByFamily = new Map<string, number>()

for (const families of shippedAdmitted.values()) {
	for (const family of families) {
		shippedByFamily.set(family, (shippedByFamily.get(family) ?? 0) + 1)
	}
}

console.log(
	`\nThe shipped graphs admit ${shippedAdmitted.size} countries between them ` +
		`(${[...shippedByFamily].map(([family, count]) => `${family} ${count}`).join(", ")}). The \`admitted\` stage ` +
		`below counts the one config named above, so the two differ whenever that config is not a shipped one.`
)
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
 * Presentation only.
 * The shallow groups hold over a hundred codes each, and a cell carrying all of them
 * wraps past the width a terminal table stays readable at.
 *
 * `--out-json` writes every code.
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
	admittedAndEmpty > 0
		? `\n${candidates.length} candidates. ${configPath} admits ${admittedAndEmpty} of them and the corpus holds no ` +
				`row for any of those, so the config names a country it cannot feed.`
		: `\n${candidates.length} candidates. ${configPath} admits none of them, so every one of these would need a ` +
				`\`country_weights\` entry as well as corpus rows.`
)

// The funnel counts jurisdictions, and a jurisdiction is not always the parser unit.
// A regime reported here is one whose addresses the funnel's row for its parent country
// says nothing about: SH's row describes one place where three postal systems live,
// and a BFPO address is counted under GB while nothing parses it as GB.
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
				configProvenance: config.provenance,
				shippedAdmittedCountries: [...shippedAdmitted.keys()].toSorted(),
				manifestPath,
				// No flag names the manifest, so it was chosen by modification time rather than given.
				// The config beside it carries its own provenance for the same reason (#2349).
				manifestProvenance: "newest modification time under the data root",
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
