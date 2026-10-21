/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman setup`: the first run as one command. It reads the data and config roots, runs the parser on a sample
 *   address, lists the tiers for the countries that matter with their size and whether each is free or licensed, and
 *   offers the three routes to a token. A declaration or an evaluation is made in place. A download is printed as the
 *   `data pull` command to run next, because a multi-gigabyte transfer has its own progress output and belongs to
 *   that command. `--no-interactive` prints the same report without prompts.
 */

import { Select, TextInput } from "@inkjs/ui"
import { configRootPath, dataRootPath } from "@mailwoman/core/data-root"
import { Box, Text } from "ink"
import React, { useEffect, useState } from "react"

import { type CommandComponent, type CommandSpec, CommandTaskResult, useCommandTask } from "#cli-kit"
import { declareAction, evaluateAction, spec as licenseSpec } from "#cli/native/commands/license"
import { parseCommand } from "#cli/native/spec"
import { parseSample, type SetupChecks, SetupRoute, setupSummary, type TierRow, tiersFor } from "#cli/setup/plan"
import { installedBundleNames } from "#data/ceiling"
import { mailwomanCLIPath } from "#metadata"

/**
 * The `setup` command's interface: no positionals, a tri-state `--interactive`
 * and the countries whose tiers to list.
 */
export const spec = {
	name: "setup",
	description:
		"The first run as one command: check the roots, parse a sample address, list the tiers for your countries, and get a token by declaring, evaluating or buying.",
	positionals: [],
	options: {
		interactive: {
			type: "boolean",
			default: true,
			description: "Ask which countries matter and which route to take. --no-interactive prints the report and exits.",
		},
		countries: {
			type: "string",
			multiple: true,
			description: "ISO 3166-1 alpha-2 codes of the countries whose tiers to list, such as GB or US.",
		},
	},
} as const satisfies CommandSpec

interface SetupReport {
	checks: SetupChecks
	tiers: TierRow[]
}

async function runChecks(countries: readonly string[]): Promise<SetupReport> {
	const dataRoot = dataRootPath()
	const configRoot = configRootPath()
	let installed: ReadonlySet<string>

	try {
		installed = await installedBundleNames(dataRoot)
	} catch {
		installed = new Set()
	}

	return {
		checks: {
			dataRoot: dataRoot.toString(),
			configRoot: configRoot.toString(),
			parse: await parseSample(await mailwomanCLIPath()),
		},
		tiers: tiersFor(countries, installed),
	}
}

type Step =
	| { kind: "countries" }
	| { kind: "checking"; countries: string[] }
	| { kind: "route"; report: SetupReport }
	| { kind: "declare-intent"; report: SetupReport }
	| { kind: "declare-fields"; report: SetupReport; intent: string; answers: string[] }
	| { kind: "evaluate-fields"; report: SetupReport; answers: string[] }
	| { kind: "working"; report: SetupReport; promise: Promise<number> }
	| { kind: "finished"; report: SetupReport; exitCode: number; note: string }

const DECLARE_FIELDS: Record<string, readonly string[]> = {
	"open-source": ["--name: the project", "--project: its public source URL"],
	"non-profit": ["--name: the licensee", "--organization: the non-profit", "--email: an address at it"],
	academic: ["--name: the licensee", "--organization: the university", "--email: an address at it"],
	student: ["--name: the licensee", "--organization: the school", "--email: an address at it"],
}

function declareArguments(intent: string, answers: readonly string[]): string[] {
	const flags = (DECLARE_FIELDS[intent] ?? []).map((field) => field.split(":")[0] ?? "")

	return ["declare", "--intent", intent, ...flags.flatMap((flag, index) => [flag, answers[index] ?? ""])]
}

function Report({ report }: { report: SetupReport }): React.ReactElement {
	return (
		<Box flexDirection="column">
			{setupSummary(report.checks, report.tiers).map((line, index) => (
				// oxlint-disable-next-line react/no-array-index-key -- the summary is a fixed list rendered once, so the index is the stable key
				<Text key={index}>{line}</Text>
			))}
		</Box>
	)
}

const NonInteractive: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(
		() => runChecks(options.countries ?? []),
		() => 0
	)

	if (state.status !== "done") {
		return <CommandTaskResult state={state} running={<Text color="gray">checking the installation…</Text>} />
	}

	return <Report report={state.result} />
}

/**
 * Run one asynchronous step once, for the wizard's intermediate screens.
 *
 * `useCommandTask` exits the process when its task settles.
 * That suits a one-shot command and not a step that hands the wizard its next screen.
 */
/* oxlint-disable react-hooks/exhaustive-deps -- The step must run once, so the effect ignores later closures. */
function useStep(run: () => Promise<void>, onError: (message: string) => void): void {
	useEffect(() => {
		void run().catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))
	}, [])
}

/* oxlint-enable react-hooks/exhaustive-deps */

const Interactive: CommandComponent<typeof spec> = ({ options }) => {
	const [step, setStep] = useState<Step>(
		options.countries?.length ? { kind: "checking", countries: options.countries } : { kind: "countries" }
	)

	if (step.kind === "countries") {
		return (
			<Box flexDirection="column">
				<Text>Which countries matter? ISO codes, comma-separated, or leave blank for every tier.</Text>
				<TextInput
					placeholder="GB, US"
					onSubmit={(value) => setStep({ kind: "checking", countries: value.split(",").map((part) => part.trim()) })}
				/>
			</Box>
		)
	}

	if (step.kind === "checking") {
		return <Checking countries={step.countries} onDone={(report) => setStep({ kind: "route", report })} />
	}

	if (step.kind === "route") {
		return (
			<Box flexDirection="column">
				<Report report={step.report} />
				<Text> </Text>
				<Text>Get a token?</Text>
				<Select
					options={[
						{ label: "Declare an open-source, non-profit, academic or student use (free)", value: SetupRoute.Declare },
						{ label: "Evaluate for thirty days (free, one per address)", value: SetupRoute.Evaluate },
						{ label: "Buy a commercial license", value: SetupRoute.Buy },
						{ label: "Skip", value: SetupRoute.Skip },
					]}
					onChange={(value) => {
						switch (value) {
							case SetupRoute.Declare:
								setStep({ kind: "declare-intent", report: step.report })

								break
							case SetupRoute.Evaluate:
								setStep({ kind: "evaluate-fields", report: step.report, answers: [] })

								break
							case SetupRoute.Buy:
								setStep({
									kind: "finished",
									report: step.report,
									exitCode: 0,
									note: "Buy at https://mailwoman.ai/license and adopt the key with: mailwoman license adopt <key> --secret <secret>",
								})

								break
							default:
								setStep({ kind: "finished", report: step.report, exitCode: 0, note: "" })
						}
					}}
				/>
			</Box>
		)
	}

	if (step.kind === "declare-intent") {
		return (
			<Box flexDirection="column">
				<Text>Which declaration?</Text>
				<Select
					options={Object.keys(DECLARE_FIELDS).map((intent) => ({ label: intent, value: intent }))}
					onChange={(intent) => setStep({ kind: "declare-fields", report: step.report, intent, answers: [] })}
				/>
			</Box>
		)
	}

	if (step.kind === "declare-fields" || step.kind === "evaluate-fields") {
		const fields =
			step.kind === "declare-fields"
				? (DECLARE_FIELDS[step.intent] ?? [])
				: ["--email: the address the key is sent to", "--name: who is evaluating"]

		const field = fields[step.answers.length]

		if (field) {
			return (
				<Box flexDirection="column">
					<Text>{field}</Text>
					<TextInput key={field} onSubmit={(value) => setStep({ ...step, answers: [...step.answers, value.trim()] })} />
				</Box>
			)
		}

		const args =
			step.kind === "declare-fields"
				? declareArguments(step.intent, step.answers)
				: ["evaluate", "--email", step.answers[0] ?? "", "--name", step.answers[1] ?? ""]

		const parsed = parseCommand(licenseSpec, args)
		const promise = step.kind === "declare-fields" ? declareAction(parsed) : evaluateAction(parsed)

		setStep({ kind: "working", report: step.report, promise })

		return null
	}

	if (step.kind === "working") {
		return (
			<Working
				promise={step.promise}
				onDone={(exitCode, note) => setStep({ kind: "finished", report: step.report, exitCode, note })}
			/>
		)
	}

	return <Finished report={step.report} exitCode={step.exitCode} note={step.note} />
}

function Finished({ report, exitCode, note }: { report: SetupReport; exitCode: number; note: string }) {
	const pulls = report.tiers.filter((row) => !row.installed).map((row) => `  mailwoman data pull ${row.name}`)

	// The one-shot task exits the process with the wizard's code once this screen has rendered.
	useCommandTask(
		() => Promise.resolve(exitCode),
		(code) => code
	)

	return (
		<Box flexDirection="column">
			{note ? <Text>{note}</Text> : null}
			{pulls.length ? <Text>Fetch the tiers you want next:</Text> : null}
			{pulls.map((line) => (
				<Text key={line}>{line}</Text>
			))}
			<Text>Check the installation any time: mailwoman doctor</Text>
		</Box>
	)
}

function Checking({ countries, onDone }: { countries: string[]; onDone: (report: SetupReport) => void }) {
	const [failure, setFailure] = useState<string | null>(null)

	useStep(async () => onDone(await runChecks(countries)), setFailure)

	if (failure) return <Text color="red">{failure}</Text>

	return <Text color="gray">checking the installation…</Text>
}

function Working({ promise, onDone }: { promise: Promise<number>; onDone: (exitCode: number, note: string) => void }) {
	useStep(
		async () => {
			const exitCode = await promise

			onDone(exitCode, exitCode === 0 ? "Your key is adopted." : "The worker did not answer. Try again later.")
		},
		(message) => onDone(1, message)
	)

	return <Text color="gray">talking to the license worker…</Text>
}

const Setup: CommandComponent<typeof spec> = (props) =>
	props.options.interactive ? <Interactive {...props} /> : <NonInteractive {...props} />

export default Setup
