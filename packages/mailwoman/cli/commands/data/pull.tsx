/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `data pull` installs published artifacts. It plans the request with the same planner `setup` reads, prints
 *   the plan's terms, sizes, disk and activation changes, and with `--dry-run` stops there without network
 *   access or data writes. Otherwise it executes the plan: each artifact is acquired with a receipt into the data
 *   root's staging area, verified, sealed and installed, and a bundle whose readers consult the active selection
 *   is activated by one atomic replacement of `active.json` once every artifact of the bundle is installed.
 *
 *   It never builds from source. For a request with no published artifact, it prints the build as a separate command.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { CommandError } from "@mailwoman/core/scripting/command"
import { Text } from "ink"

import {
	type Check,
	CheckList,
	type CommandSpec,
	CommandTaskResult,
	type CommandComponent,
	useCommandTask,
	writeRawStdout,
} from "#cli-kit"
import { BUNDLES } from "#data/bundles"
import { ArtifactOutcome, type ArtifactResult, executeInstallation } from "#data/install"
import { readConfiguredKey } from "#data/licensed"
import { OBLIGATION_REFUSALS, parseObligationRefusals } from "#data/obligations"
import {
	describePlannedArtifact,
	describePlanSummary,
	type InstallationPlan,
	planInstallation,
	type PlanProblem,
	planProblems,
	ProblemKind,
} from "#data/plan"
import { $public } from "#env"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "pull",
	description: "Install published data bundles",
	positionals: [
		{
			name: "bundle",
			required: true,
			multiple: true,
			description: `Bundle name(s) to pull: ${Object.keys(BUNDLES).join(", ")}`,
		},
	],
	options: {
		"dry-run": {
			type: "boolean",
			default: false,
			description: "Print the installation plan without network access or data writes",
		},
		only: {
			type: "string",
			description: "Only pull artifacts whose remote/local path or state slug contains this substring (e.g. --only nh)",
		},
		force: {
			type: "boolean",
			default: false,
			description: "Re-download even when a local copy already appears present",
		},
		"data-root": {
			type: "string",
			description: "Override the data root for this pull (default: $MAILWOMAN_DATA_ROOT or the built-in default)",
		},
		host: {
			type: "string",
			validate: (value: string) => URL.canParse(value),
			description:
				"Mirror or private-registry base URL serving the same object keys as the public bucket (e.g. https://mirror.example/mailwoman/). Default: the public bucket.",
		},
		refuse: {
			type: "string",
			multiple: true,
			choices: OBLIGATION_REFUSALS,
			description:
				`Decline a bundle whose recorded expression has this class of obligation (${OBLIGATION_REFUSALS.join(", ")}). ` +
				"Repeatable. Default: $MAILWOMAN_REFUSE_OBLIGATIONS",
		},
		json: {
			type: "boolean",
			default: false,
			description: "Emit the plan, its problems by kind and each artifact's outcome as JSON",
		},
	},
} as const satisfies CommandSpec

interface PullResult {
	ok: boolean
	checks: Check[]
	/**
	 * The structured result `--json` prints: the plan's problems by kind, each artifact's
	 * outcome with its problem kind, and the generation written.
	 */
	report: {
		dataRoot: string
		basedOnGeneration: number | null
		problems: PlanProblem[]
		artifacts: Array<{ bundle: string; remotePath: string; action: string; destination: string }>
		results: ArtifactResult[]
		generation: number | null
		activationError: string | null
		cancelled: boolean
	}
}

/**
 * The plan's lines: each bundle's terms, what its copies on disk record, its refusals
 * and access, its artifacts, then the transfer, disk and dependency summary.
 */
function planChecks(plan: InstallationPlan, dryRun: boolean): { ok: boolean; checks: Check[] } {
	const checks: Check[] = []
	let ok = true

	for (const bundle of plan.bundles) {
		for (const problem of bundle.problems) {
			ok = false
			checks.push({ ok: false, check: `${bundle.name}: ${ProblemKind.Unavailable}`, detail: problem })
		}

		for (const line of bundle.terms) {
			checks.push({ ok: true, check: `${bundle.name}: terms`, detail: line })
		}

		for (const line of bundle.artifactTerms) {
			checks.push({ ok: true, check: `${bundle.name}: artifact`, detail: line })
		}

		for (const { subject, finding } of bundle.refusals) {
			ok = false

			checks.push({
				ok: false,
				check: `${bundle.name}: refused --refuse ${finding.refusal}`,
				detail: `${finding.reason} (${subject})`,
			})
		}

		if (bundle.access?.kind === "refused") {
			ok = false

			for (const line of bundle.access.lines) {
				checks.push({ ok: false, check: `${bundle.name}: ${ProblemKind.InsufficientAccess}`, detail: line })
			}
		}

		if (!dryRun) continue

		for (const artifact of bundle.artifacts) {
			checks.push({
				ok: true,
				check: `${bundle.name}: ${artifact.artifact.remotePath}`,
				detail: `[dry-run] ${describePlannedArtifact(artifact)}`,
			})
		}
	}

	for (const line of describePlanSummary(plan)) {
		checks.push({ ok: true, check: dryRun ? "[dry-run] plan" : "plan", detail: line })
	}

	if (plan.fitsOnDisk === false) {
		ok = false

		checks.push({
			ok: false,
			check: "disk",
			detail: "the transfer does not fit in the available space; free space or choose another --data-root",
		})
	}

	return { ok, checks }
}

async function pull(
	bundleNames: readonly string[],
	opts: {
		dryRun: boolean
		only?: string
		force: boolean
		dataRoot: string
		host?: string
		refuse: ReturnType<typeof parseObligationRefusals>
	}
): Promise<PullResult> {
	const plan = await planInstallation({
		bundles: bundleNames,
		only: opts.only ?? null,
		force: opts.force,
		dataRoot: opts.dataRoot,
		...(opts.host ? { host: opts.host } : {}),
		refuse: opts.refuse,
		configuredKey: readConfiguredKey,
	})

	const planned = planChecks(plan, opts.dryRun)

	const report: PullResult["report"] = {
		dataRoot: plan.dataRoot,
		basedOnGeneration: plan.basedOnGeneration,
		problems: planProblems(plan),
		artifacts: plan.bundles.flatMap((bundle) =>
			bundle.artifacts.map((artifact) => ({
				bundle: bundle.name,
				remotePath: artifact.artifact.remotePath,
				action: artifact.action,
				destination: artifact.destination,
			}))
		),
		results: [],
		generation: null,
		activationError: null,
		cancelled: false,
	}

	if (opts.dryRun || plan.fitsOnDisk === false) return { ...planned, report }

	const { APIClient } = await import("@mailwoman/core/api")

	await using client = new APIClient({ displayName: "mailwoman data", minRequestIntervalMs: 150, retry: true })

	const controller = new AbortController()
	const abort = () => controller.abort()

	process.once("SIGINT", abort)

	try {
		const result = await executeInstallation(plan, {
			client,
			signal: controller.signal,
			onProgress: (message) => console.error(`  ${message}`),
		})

		const checks = [...planned.checks]

		for (const artifact of result.results) {
			checks.push({
				ok: artifact.outcome !== ArtifactOutcome.Failed && artifact.outcome !== ArtifactOutcome.Cancelled,
				check: `${artifact.bundle}: ${artifact.remotePath}`,
				detail: `${artifact.outcome}${artifact.problem ? ` (${artifact.problem})` : ""}: ${artifact.detail}`,
			})
		}

		if (result.selection) {
			checks.push({
				ok: true,
				check: "selection",
				detail: `generation ${result.selection.generation} is active (${plan.dataRoot}/active.json); \`mailwoman data status\` lists it`,
			})
		}

		if (result.activationError) {
			checks.push({ ok: false, check: "selection", detail: result.activationError })
		}

		if (result.cancelled) {
			checks.push({ ok: false, check: "cancelled", detail: "run the same command again to resume the transfer" })
		}

		const installedSomething = result.results.some(
			(artifact) => artifact.outcome === ArtifactOutcome.Installed || artifact.outcome === ArtifactOutcome.Activated
		)

		if (result.ok && installedSomething) {
			checks.push({
				ok: true,
				check: "next",
				detail: 'mailwoman geocode "<an address in the installed area>" --format text',
			})
		}

		return {
			ok: planned.ok && result.ok,
			checks,
			report: {
				...report,
				results: result.results,
				generation: result.selection?.generation ?? null,
				activationError: result.activationError,
				cancelled: result.cancelled,
			},
		}
	} finally {
		process.off("SIGINT", abort)
	}
}

const DataPull: CommandComponent<typeof spec> = ({ options, args }) => {
	const state = useCommandTask(
		async () => {
			if (!args.length) {
				throw new CommandError(`mailwoman data pull <bundle...> — known bundles: ${Object.keys(BUNDLES).join(", ")}`)
			}

			// A flag sets the refusal for this pull.
			// The variable is the installation's standing one.
			const refused = options.refuse?.length ? options.refuse : [$public.MAILWOMAN_REFUSE_OBLIGATIONS ?? ""]

			const result = await pull(args, {
				dryRun: options.dryRun,
				...(options.only ? { only: options.only } : {}),
				force: options.force,
				dataRoot: (options.dataRoot ?? dataRootPath()).toString(),
				...(options.host ? { host: options.host } : {}),
				refuse: parseObligationRefusals(refused),
			})

			if (options.json) {
				writeRawStdout({ ok: result.ok, ...result.report })
			}

			return result
		},
		(result) => (result.ok ? 0 : 1)
	)

	if (state.status !== "done") return <CommandTaskResult state={state} running={<Text color="gray">pulling…</Text>} />

	if (options.json) return null

	return <CheckList checks={state.result.checks} verdict={state.result.ok} />
}

export default DataPull
