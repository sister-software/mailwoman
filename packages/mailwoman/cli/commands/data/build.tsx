/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `data build <recipe> --countries <cc>` builds a layer from source data through the installer: it plans
 *   the inputs and outputs, checks the build's tools before any download, acquires the inputs with receipts,
 *   builds, validates and installs each output, and activates the outputs with `--activate`. `--dry-run`
 *   stops after the plan without network access or data writes.
 *
 *   The recipe's code ships in an optional package, so a customer who installs only published data never
 *   needs the build's tools. This command reports a missing package or tool before it acquires anything.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { type BuildRecipe, BuildRecipeName } from "@mailwoman/core/layers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { extractDelimited } from "@mailwoman/core/scripting/arguments"
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
import { executeBuild, planBuild, type BuildReport, type BuildResult } from "#data/build"
import { ProblemKind } from "#data/plan"
import { readMailwomanVersion } from "#metadata"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "build",
	description: "Build a data layer from source data, install it, and optionally activate it",
	positionals: [
		{
			name: "recipe",
			required: true,
			description: `The build recipe: ${Object.values(BuildRecipeName).join(", ")}`,
		},
	],
	options: {
		countries: {
			type: "string",
			description: "Comma-separated ISO 3166-1 alpha-2 codes to build (e.g. --countries DE,NL)",
		},
		region: {
			type: "string",
			description:
				"One publisher region every requested country is derived from (e.g. europe/dach). Default: each country's own region",
		},
		"dry-run": {
			type: "boolean",
			default: false,
			description: "Print the plan and the prerequisite check without network access or data writes",
		},
		activate: {
			type: "boolean",
			default: false,
			description: "Select each built layer after it installs, after any source its country already selects",
		},
		"data-root": {
			type: "string",
			description: "Override the data root (default: $MAILWOMAN_DATA_ROOT or the built-in default)",
		},
		"geofabrik-host": {
			type: "string",
			validate: (value: string) => URL.canParse(value),
			description: "A mirror serving Geofabrik's region paths. Default: https://download.geofabrik.de/",
		},
		"geoboundaries-host": {
			type: "string",
			validate: (value: string) => URL.canParse(value),
			description: "A mirror serving the geoBoundaries API paths. Default: https://www.geoboundaries.org/",
		},
		json: {
			type: "boolean",
			default: false,
			description: "Emit the plan, its problems by kind and the build's result as JSON",
		},
	},
} as const satisfies CommandSpec

interface BuildCommandResult {
	ok: boolean
	checks: Check[]
	report: {
		dataRoot: string
		problems: BuildReport["problems"]
		inputs: Array<{ key: string; url: string; kept: string | null; destination: string }>
		outputs: Array<{ country: string; fileName: string; policy: string; inputs: readonly string[] }>
		result: BuildResult | null
	}
}

/**
 * Load the recipe's implementation from its optional package.
 *
 * @returns Null when the package is not installed.
 */
async function loadRecipe(
	name: string,
	hosts: { geofabrik?: string; geoBoundaries?: string }
): Promise<{ recipe: BuildRecipe; version: string } | null> {
	if (name !== BuildRecipeName.OSMAddressPoints) {
		throw new CommandError(`unknown recipe ${name}; the recipes are ${Object.values(BuildRecipeName).join(", ")}`)
	}

	const imported = await import("@mailwoman/osm/tools/address-points-recipe").catch((error: unknown) => {
		if ((error as { code?: unknown } | null)?.code === "ERR_MODULE_NOT_FOUND") return null

		throw error
	})

	if (!imported) return null

	const { version } = await readLocalJSONFile<{ version: string }>(resolvePackagePath("@mailwoman/osm", "package.json"))

	return {
		recipe: imported.createOSMAddressPointsRecipe({
			...(hosts.geofabrik ? { geofabrikBaseURL: hosts.geofabrik } : {}),
			...(hosts.geoBoundaries ? { geoBoundariesBaseURL: hosts.geoBoundaries } : {}),
		}),
		version,
	}
}

function planChecks(report: BuildReport, dryRun: boolean): Check[] {
	const prefix = dryRun ? "[dry-run] " : ""
	const checks: Check[] = []

	for (const prerequisite of report.prerequisites) {
		checks.push({ ok: prerequisite.satisfied, check: `prerequisite ${prerequisite.name}`, detail: prerequisite.detail })
	}

	for (const problem of report.problems) {
		if (problem.kind !== ProblemKind.MissingDependency) {
			checks.push({ ok: false, check: problem.kind, detail: problem.detail })
		}
	}

	for (const planned of report.inputs) {
		checks.push({
			ok: true,
			check: `${prefix}input ${planned.input.name}`,
			detail: planned.kept
				? `kept at ${planned.destination.replace("<release>", planned.kept.release ?? "unreleased")}; verified against the host before reuse`
				: `download ${planned.input.url}${planned.input.locate ? ` (download URL read from its ${planned.input.locate.field})` : ""}, size unknown until the host answers, to ${planned.destination}`,
		})
	}

	for (const output of report.plan.outputs) {
		checks.push({
			ok: true,
			check: `${prefix}output ${output.country}`,
			detail:
				`${output.fileName} from ${output.inputs.join(" + ")} under ${output.policy.name} v${output.policy.version}` +
				(output.inputs.length > 1 ? ", clipped to the outline" : ""),
		})
	}

	return checks
}

async function build(
	recipeName: string,
	opts: {
		countries: string[]
		region: string | null
		dryRun: boolean
		activate: boolean
		dataRoot: string
		hosts: { geofabrik?: string; geoBoundaries?: string }
	}
): Promise<BuildCommandResult> {
	const loaded = await loadRecipe(recipeName, opts.hosts)

	if (!loaded) {
		return {
			ok: false,
			checks: [
				{
					ok: false,
					check: ProblemKind.MissingDependency,
					detail: `the ${recipeName} recipe ships in @mailwoman/osm. Install it beside mailwoman (npm install @mailwoman/osm) and run the command again.`,
				},
			],
			report: { dataRoot: opts.dataRoot, problems: [], inputs: [], outputs: [], result: null },
		}
	}

	const report = await planBuild(opts.dataRoot, loaded.recipe, { countries: opts.countries, region: opts.region })
	const checks = planChecks(report, opts.dryRun)

	const summary: BuildCommandResult["report"] = {
		dataRoot: report.dataRoot,
		problems: report.problems,
		inputs: report.inputs.map((planned) => ({
			key: planned.input.key,
			url: planned.input.url,
			kept: planned.kept ? planned.destination.replace("<release>", planned.kept.release ?? "unreleased") : null,
			destination: planned.destination,
		})),
		outputs: report.plan.outputs.map((output) => ({
			country: output.country,
			fileName: output.fileName,
			policy: `${output.policy.name} v${output.policy.version}`,
			inputs: output.inputs,
		})),
		result: null,
	}

	if (opts.dryRun || report.problems.length) {
		return { ok: !report.problems.length, checks, report: summary }
	}

	const { APIClient } = await import("@mailwoman/core/api")

	await using client = new APIClient({ displayName: "mailwoman data build", minRequestIntervalMs: 150, retry: true })

	const controller = new AbortController()
	const abort = () => controller.abort()

	process.once("SIGINT", abort)

	try {
		const result = await executeBuild(report, loaded.recipe, {
			client,
			builderSHA: `mailwoman@${await readMailwomanVersion()} @mailwoman/osm@${loaded.version}`,
			activate: opts.activate,
			signal: controller.signal,
			onProgress: (message) => console.error(`  ${message}`),
		})

		for (const input of result.inputs) {
			checks.push({
				ok: true,
				check: `input ${input.input.name}`,
				detail: `${input.reused ? "reused" : "acquired"} ${input.path} (sha256 ${input.sha256})${input.restartReason ? `; ${input.restartReason}` : ""}`,
			})
		}

		for (const output of result.outputs) {
			const counts = output.manifest.derivation?.counts ?? {}

			checks.push({
				ok: true,
				check: `installed ${output.output.country}`,
				detail: `${output.path} (${output.manifest.id}${output.reused ? ", reused" : ""}); ${counts["written"] ?? 0} points kept of ${counts["total"] ?? 0} read`,
			})
		}

		checks.push({ ok: true, check: "installation", detail: result.installation.id })

		checks.push(
			result.activatedGeneration
				? {
						ok: true,
						check: "selection",
						detail: `generation ${result.activatedGeneration} is active; \`mailwoman data status\` lists it`,
					}
				: {
						ok: true,
						check: "next",
						detail: `mailwoman data activate ${result.installation.id}  (selects the built layers)`,
					}
		)

		if (result.activatedGeneration) {
			checks.push({
				ok: true,
				check: "next",
				detail: 'mailwoman geocode "<an address in the built country>" --format text',
			})
		}

		return { ok: true, checks, report: { ...summary, result } }
	} finally {
		process.off("SIGINT", abort)
	}
}

const DataBuild: CommandComponent<typeof spec> = ({ options, args }) => {
	const state = useCommandTask(
		async () => {
			const [recipe] = args

			if (!recipe)
				throw new CommandError(`mailwoman data build <recipe> — recipes: ${Object.values(BuildRecipeName).join(", ")}`)

			const countries = extractDelimited(options.countries).map((country) => country.trim().toUpperCase())

			const result = await build(recipe, {
				countries,
				region: options.region ?? null,
				dryRun: options.dryRun,
				activate: options.activate,
				dataRoot: (options.dataRoot ?? dataRootPath()).toString(),
				hosts: {
					...(options.geofabrikHost ? { geofabrik: options.geofabrikHost } : {}),
					...(options.geoboundariesHost ? { geoBoundaries: options.geoboundariesHost } : {}),
				},
			})

			if (options.json) {
				writeRawStdout({ ok: result.ok, ...result.report })
			}

			return result
		},
		(result) => (result.ok ? 0 : 1)
	)

	if (state.status !== "done") return <CommandTaskResult state={state} running={<Text color="gray">building…</Text>} />

	if (options.json) return null

	return <CheckList checks={state.result.checks} verdict={state.result.ok} />
}

export default DataBuild
