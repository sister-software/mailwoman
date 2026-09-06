/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval premise-linkage` — the controlled premise-linkage harness (#1902). Grades one
 *   adapter's rows through both registered arms (Mailwoman with open artifacts only, then Mailwoman
 *   plus the #1901 authoritative provider) and emits an aggregate report that has passed the writer's
 *   preflight.
 *
 *   Two modes, and the report says which it was. With `--config <module>` the command loads a PRIVATE
 *   run configuration from outside this repository — the controlled adapter, the real provider, and
 *   production deps — and requires both an agreed `--min-cell-size` and a run salt in the environment.
 *   Without it the command runs the shipped synthetic fixture end to end, which is a self-check of the
 *   harness and never a measurement of a register.
 *
 *   The salt is read from `$MAILWOMAN_PREMISE_LINKAGE_SALT` rather than taken as a flag: a flag value
 *   is visible in the process table to every user on the host.
 */

import { Box, Text } from "ink"

import {
	type CommandSpec,
	CommandTaskResult,
	type ParsedCommandComponent,
	readMailwomanVersion,
	useCommandTask,
} from "#cli-kit"

export const description = "Grade a controlled premise-linkage evaluation across the open and authoritative arms."

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "premise-linkage",
	description,
	options: {
		config: {
			type: "string",
			description: "Private module default-exporting the controlled run configuration (or a factory returning one).",
		},
		out: {
			type: "string",
			description: "Write the publishable aggregate report to this path instead of printing a summary.",
		},
		"min-cell-size": {
			type: "number",
			description: "Minimum cell size agreed with the data provider. Required for a controlled run.",
		},
		policy: {
			type: "string",
			default: "abstain_ok",
			choices: ["unique_required", "abstain_ok"],
			description: "Whether the registered evaluation policy required a unique answer.",
		},
	},
} as const satisfies CommandSpec

interface Options {
	config?: string
	out?: string
	minCellSize?: number
	policy?: string
}

/**
 * The synthetic self-check publishes nothing, so its cell floor exists only to keep the writer's suppression path on
 * the same code the controlled run takes.
 */
const SYNTHETIC_MIN_CELL_SIZE = 1

/**
 * Bytes of per-run salt generated when the synthetic self-check finds none in the environment. A controlled run never
 * reaches this: it is told to supply its own.
 */
const GENERATED_SALT_BYTES = 24

const EvalPremiseLinkage: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const [{ runPremiseLinkage, resolvePremiseLinkageConfig }, { publishableReport, writePremiseLinkageReport }] =
			await Promise.all([
				import("#eval-harness/premise-linkage/run"),
				import("#eval-harness/premise-linkage/report-writer"),
			])

		const { PremiseLinkageMode, PremiseLinkagePolicy } = await import("#eval-harness/premise-linkage/schema")
		const { $private } = await import("#env")

		const controlled = typeof options.config === "string" && options.config.length > 0
		const mode = controlled ? PremiseLinkageMode.Controlled : PremiseLinkageMode.Synthetic
		const declaredSalt = $private.MAILWOMAN_PREMISE_LINKAGE_SALT

		if (controlled && !declaredSalt) {
			throw new Error(
				"premise-linkage: a controlled run needs a per-run secret in $MAILWOMAN_PREMISE_LINKAGE_SALT. " +
					"Generate a fresh one for every published run — a reused salt lets two reports be joined."
			)
		}

		if (controlled && options.minCellSize === undefined) {
			throw new Error(
				"premise-linkage: a controlled run needs --min-cell-size set to the minimum agreed with the data provider."
			)
		}

		const salt =
			declaredSalt ?? Buffer.from(crypto.getRandomValues(new Uint8Array(GENERATED_SALT_BYTES))).toString("hex")

		const minCellSize = options.minCellSize ?? SYNTHETIC_MIN_CELL_SIZE

		const config = controlled
			? await loadControlledConfig(options.config!, resolvePremiseLinkageConfig)
			: await loadSyntheticConfig()

		const policy =
			options.policy === PremiseLinkagePolicy.UniqueRequired
				? PremiseLinkagePolicy.UniqueRequired
				: PremiseLinkagePolicy.AbstainPermitted

		const mailwomanVersion = await readMailwomanVersion()

		const run = await runPremiseLinkage({
			...config,
			salt,
			policy,
			minCellSize,
			mailwomanVersion,
			mode,
		})

		const report = options.out ? await writePremiseLinkageReport(options.out, run) : publishableReport(run)

		return { report, adapter: config.adapter.name, outPath: options.out }
	})

	if (state.status !== "done")
		return <CommandTaskResult state={state} running={<Text dimColor>Grading the premise-linkage arms…</Text>} />

	if (state.status === "done") {
		const { report } = state.result

		return (
			<Box flexDirection="column">
				<Text color={report.mode === "synthetic" ? "yellow" : "green"}>
					{report.mode === "synthetic"
						? "synthetic self-check — no controlled data was read"
						: "controlled run complete"}
				</Text>
				<Text dimColor>
					adapter {state.result.adapter} · policy {report.policy} · minimum cell size {report.minCellSize} · suppressed
					cells {report.suppressedCells}
				</Text>
				{report.arms.map((arm) => (
					<Text key={arm.arm}>
						{arm.arm}: exact {arm.overall.exactOverEligible.n} of {arm.overall.exactOverEligible.of} eligible · wrong{" "}
						{arm.overall.wrongOverEligible.n} of {arm.overall.wrongOverEligible.of} · refused{" "}
						{arm.overall.refusedOverAll.n} of {arm.overall.refusedOverAll.of} · ambiguous{" "}
						{arm.overall.ambiguousOverAll.n} of {arm.overall.ambiguousOverAll.of} · ungradable {arm.erroredOverAll.n} of{" "}
						{arm.erroredOverAll.of}
					</Text>
				))}
				<Text>
					{report.comparison.baselineArm} → {report.comparison.candidateArm}: changed {report.comparison.changed.n} of{" "}
					{report.comparison.changed.of} · improved {report.comparison.improved.n} of {report.comparison.improved.of} ·
					regressed {report.comparison.regressed.n} of {report.comparison.regressed.of}
				</Text>
				{state.result.outPath ? <Text dimColor>report written to {state.result.outPath}</Text> : null}
			</Box>
		)
	}

	return null
}

/**
 * Import a private run configuration from outside this repository. The specifier is the operator's; nothing here
 * inspects it beyond handing it to the loader, and `resolve` decides whether what came back is usable.
 */
async function loadControlledConfig<T>(
	specifier: string,
	resolve: (exported: unknown, specifier: string) => Promise<T>
): Promise<T> {
	const module = (await import(specifier)) as { default?: unknown }

	return resolve(module.default, specifier)
}

/**
 * The shipped synthetic fixture, its matching provider, and a pipeline stub — the self-check's three pieces, which ship
 * together so they cannot disagree.
 */
async function loadSyntheticConfig() {
	const { syntheticFixtureAdapter, syntheticFixtureDeps, syntheticFixtureProvider } =
		await import("#eval-harness/premise-linkage/adapter")

	return {
		adapter: syntheticFixtureAdapter(),
		deps: syntheticFixtureDeps(),
		authoritativeProvider: syntheticFixtureProvider(),
	}
}

export default EvalPremiseLinkage
