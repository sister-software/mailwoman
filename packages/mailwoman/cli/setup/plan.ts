/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The pure half of `mailwoman setup`: which tiers the asked countries have, and the lines the non-interactive run
 *   prints. The Ink command in `cli/commands/setup.tsx` draws these and adds the prompts.
 */

import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { parseJSONStrict } from "@mailwoman/core/json"
import { ServingRole } from "@mailwoman/core/layers"
import { runFile } from "@mailwoman/core/process"
import { CommandError } from "@mailwoman/core/scripting/command"
import { childEnv } from "@mailwoman/core/scripting/utils"
import type { PathBuilderLike } from "path-ts"

import { BUNDLES, type DataBundle } from "#data/bundles"
import { licenseRouteLines } from "#data/licensed"
import {
	type InstallationPlan,
	type InstallationRequest,
	planInstallation,
	PlannedAction,
	type PlannedArtifact,
} from "#data/plan"
import { SizeBasis } from "#data/registry"

/**
 * The installation inventory could not be read, naming the input that failed.
 */
export class InstallationReadError extends CommandError {
	readonly path: string

	constructor(path: string, cause: unknown) {
		const message = cause instanceof Error ? cause.message : String(cause)

		super(`setup could not read the installation at ${path}: ${message}`, { cause })
		this.name = "InstallationReadError"
		this.path = path
	}
}

/**
 * The installation plan for `bundles` under `dataRoot`, the one `data pull --dry-run` prints.
 *
 * A failure to read the installation is an error with the unreadable path:
 * the system call's own path when it reports one, and the data root otherwise.
 * An empty installation in place of the failure would print every tier as not installed,
 * a report about an installation setup never read.
 *
 * @throws {@link InstallationReadError} when the installation cannot be read.
 */
export async function readInstallationPlan(
	dataRoot: PathBuilderLike,
	bundles: readonly string[],
	read: (request: InstallationRequest) => Promise<InstallationPlan> = planInstallation
): Promise<InstallationPlan> {
	try {
		return await read({ dataRoot, bundles })
	} catch (error) {
		const path = (error as { path?: unknown } | null)?.path

		throw new InstallationReadError(typeof path === "string" ? path : dataRoot.toString(), error)
	}
}

/**
 * Whether a planned artifact is installed: selected and reused, or present at its conventional path.
 */
function isInstalled(artifact: PlannedArtifact): boolean {
	return artifact.action === PlannedAction.Reuse || artifact.action === PlannedAction.Present
}

/**
 * The bundles of a plan whose every artifact is installed.
 */
export function installedBundles(plan: InstallationPlan): ReadonlySet<string> {
	return new Set(
		plan.bundles
			.filter((bundle) => bundle.artifacts.length && bundle.artifacts.every(isInstalled))
			.map((bundle) => bundle.name)
	)
}

/**
 * What a customer can do with the installation, one row per capability.
 */
export const Capability = {
	Parsing: "parsing",
	PlaceResolution: "place resolution",
	Rooftop: "rooftop lookup",
	Interpolation: "interpolation",
	PointsOfInterest: "points of interest",
} as const

export type Capability = (typeof Capability)[keyof typeof Capability]

const ROLE_CAPABILITIES: ReadonlyArray<[ServingRole, Capability]> = [
	[ServingRole.Candidate, Capability.PlaceResolution],
	[ServingRole.AddressPoints, Capability.Rooftop],
	[ServingRole.Interpolation, Capability.Interpolation],
	[ServingRole.POI, Capability.PointsOfInterest],
]

/**
 * One capability's state.
 */
export interface CapabilityRow {
	capability: Capability
	state: "available" | "partial" | "unavailable"
	detail: string
}

/**
 * The capabilities the installation provides for the asked bundles.
 *
 * The parser needs only the model the package ships.
 * Each other capability is read from the plan's artifacts of its role, counted per scope,
 * so a US installation with one state reads as partial and lists that state's code.
 */
export function setupCapabilities(parse: SampleParse, plan: InstallationPlan): CapabilityRow[] {
	const rows: CapabilityRow[] = [
		parse.status === "ok"
			? {
					capability: Capability.Parsing,
					state: "available",
					detail: "the parser runs on the shipped model and needs no geographic data",
				}
			: { capability: Capability.Parsing, state: "unavailable", detail: parse.reason },
	]

	const artifacts = plan.bundles.flatMap((bundle) => bundle.artifacts)

	for (const [role, capability] of ROLE_CAPABILITIES) {
		const ofRole = artifacts.filter((artifact) => artifact.available.role === role)

		if (!ofRole.length) continue

		const installed = ofRole.filter(isInstalled)

		const scopes = installed.flatMap((artifact) =>
			artifact.available.scope.subdivisions?.length
				? artifact.available.scope.subdivisions
				: artifact.available.scope.countries
		)

		const where = scopes.length ? ` (${scopes.join(", ")})` : ""

		if (installed.length === ofRole.length) {
			rows.push({ capability, state: "available", detail: `installed${where}` })
		} else if (installed.length) {
			rows.push({
				capability,
				state: "partial",
				detail: `installed for ${installed.length} of ${ofRole.length} published scopes${where}`,
			})
		} else {
			rows.push({ capability, state: "unavailable", detail: "not installed" })
		}
	}

	return rows
}

function plannedBytes(artifact: PlannedArtifact): number {
	return artifact.available.size.basis === SizeBasis.Unknown ? 0 : artifact.available.size.bytes
}

/**
 * The next smallest installation for the asked bundles, as the commands to run.
 *
 * Place resolution comes first, because every finer tier is reached through it.
 * A bundle published per state is offered one state at a time with `--only`,
 * with the smallest and largest state's size, rather than as the whole bundle.
 */
export function nextInstallation(plan: InstallationPlan): string[] {
	const pending = plan.bundles.filter((bundle) => bundle.artifacts.some((artifact) => !isInstalled(artifact)))

	const gazetteer = pending.find((bundle) =>
		bundle.artifacts.some((artifact) => artifact.available.role === ServingRole.Candidate)
	)

	const steps = pending.map((bundle) => {
		const missing = bundle.artifacts.filter((artifact) => !isInstalled(artifact))
		const bySlug = new Map<string, number>()

		for (const artifact of missing) {
			const slug = artifact.artifact.stateSlug

			if (slug) {
				bySlug.set(slug, (bySlug.get(slug) ?? 0) + plannedBytes(artifact))
			}
		}

		if (!bySlug.size) {
			const bytes = missing.reduce((sum, artifact) => sum + plannedBytes(artifact), 0)

			return { bundle, bytes, command: `mailwoman data pull ${bundle.name}   # ${ByteFormatter.formatSI(bytes)}` }
		}

		const sizes = [...bySlug.entries()].toSorted((a, b) => a[1] - b[1])
		const smallest = sizes[0]!
		const largest = sizes.at(-1)!

		return {
			bundle,
			bytes: smallest[1],
			command:
				`mailwoman data pull ${bundle.name} --only <state>   # one of ${sizes.length} states, ` +
				`from ${ByteFormatter.formatSI(smallest[1])} (${smallest[0]}) to ${ByteFormatter.formatSI(largest[1])} (${largest[0]})`,
		}
	})

	// The gazetteer first, then the smallest step.
	return steps
		.toSorted((a, b) => Number(b.bundle === gazetteer) - Number(a.bundle === gazetteer) || a.bytes - b.bytes)
		.map((step) => step.command)
}

/**
 * The address the first parse runs on.
 *
 * A well-known US street address with a unit-free, comma-separated shape.
 */
export const SETUP_SAMPLE_ADDRESS = "1600 Pennsylvania Avenue NW, Washington, DC 20500"

/**
 * The routes the wizard offers after the tier list.
 */
export const SetupRoute = {
	Declare: "declare",
	Evaluate: "evaluate",
	Buy: "buy",
	Skip: "skip",
} as const

export type SetupRoute = (typeof SetupRoute)[keyof typeof SetupRoute]

export interface TierRow {
	name: string
	description: string
	/**
	 * The scope entry a token must admit, or `null` for a free bundle.
	 */
	tier: string | null
	/**
	 * The sum of the bundle's recorded artifact sizes.
	 */
	bytes: number
	access: "free" | "licensed"
	installed: boolean
}

function tierRow(bundle: DataBundle, installed: ReadonlySet<string>): TierRow {
	return {
		name: bundle.name,
		description: bundle.description,
		tier: bundle.tier ?? null,
		bytes: bundle.artifacts.reduce((sum, artifact) => sum + artifact.approxBytes, 0),
		access: bundle.access === "licensed" ? "licensed" : "free",
		installed: installed.has(bundle.name),
	}
}

/**
 * The tiers for the asked countries: every global bundle, plus each bundle
 * whose countries include one asked.
 * With no country asked, every bundle is listed.
 */
export function tiersFor(
	countries: readonly string[],
	installed: ReadonlySet<string>,
	bundles: Readonly<Record<string, DataBundle>> = BUNDLES
): TierRow[] {
	return bundlesFor(countries, bundles).map((bundle) => tierRow(bundle, installed))
}

/**
 * The bundles for the asked countries: every global bundle, plus each bundle
 * whose countries include one asked.
 * With no country asked, every bundle.
 */
export function bundlesFor(
	countries: readonly string[],
	bundles: Readonly<Record<string, DataBundle>> = BUNDLES
): DataBundle[] {
	const asked = new Set(countries.map((country) => country.trim().toUpperCase()).filter((country) => country.length))

	return Object.values(bundles).filter((bundle) => {
		if (!bundle.countries || !asked.size) return true

		return bundle.countries.some((country) => asked.has(country.toUpperCase()))
	})
}

export type SampleParse = { status: "ok"; components: Record<string, string> } | { status: "failed"; reason: string }

export interface SetupChecks {
	dataRoot: string
	configRoot: string
	parse: SampleParse
}

/**
 * Run the compiled CLI's `parse` on the sample address and read its components.
 *
 * The CLI is spawned rather than imported so the wizard sees what a user's
 * first command sees, weights and all.
 */
export async function parseSample(
	cliBin: PathBuilderLike,
	address: string = SETUP_SAMPLE_ADDRESS
): Promise<SampleParse> {
	try {
		const { stdout } = await runFile(process.execPath, [cliBin, "parse", "--format", "json", address], {
			env: childEnv({ NODE_NO_WARNINGS: "1" }),
			maxBuffer: 4 * 1024 * 1024,
		})

		const parsed: unknown = parseJSONStrict(stdout)

		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { status: "failed", reason: "the parse command answered no component object" }
		}

		const components = Object.fromEntries(
			Object.entries(parsed as Record<string, unknown>).filter(
				(entry): entry is [string, string] => typeof entry[1] === "string"
			)
		)

		return { status: "ok", components }
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)

		return { status: "failed", reason: /^[^\n]*/u.exec(message)?.[0] || "unknown" }
	}
}

function tierLine(row: TierRow): string {
	const state = row.installed ? "installed" : "not installed"

	return `  ${row.name.padEnd(14)} ${row.access.padEnd(9)} ${state.padEnd(14)} ${ByteFormatter.formatSI(row.bytes).padStart(9)}  ${row.description}`
}

/**
 * What the installation provides now and the next smallest installation, read from one plan.
 */
export interface SetupInstallation {
	capabilities: readonly CapabilityRow[]
	/**
	 * The commands of the next smallest installation, in the order to run them.
	 */
	next: readonly string[]
}

/**
 * The lines the non-interactive run prints.
 *
 * They are the roots, the parsed sample, one line per tier, what works now, the next smallest
 * installation, and the routes to a token when a licensed tier is among the tiers not installed.
 */
export function setupSummary(
	checks: SetupChecks,
	tiers: readonly TierRow[],
	installation?: SetupInstallation
): string[] {
	const lines = [`Data root:   ${checks.dataRoot}`, `Config root: ${checks.configRoot}`, ""]

	if (checks.parse.status === "ok") {
		lines.push(`Parsed: ${SETUP_SAMPLE_ADDRESS}`)

		for (const [tag, value] of Object.entries(checks.parse.components)) {
			lines.push(`  ${tag}: ${value}`)
		}
	} else {
		lines.push(`Parsed: failed (${checks.parse.reason})`)
	}

	lines.push("", "Tiers:")

	for (const row of tiers) {
		lines.push(tierLine(row))
	}

	const missing = tiers.filter((row) => !row.installed)

	if (installation) {
		lines.push("", "Works now:")

		for (const row of installation.capabilities) {
			lines.push(`  ${row.capability.padEnd(20)} ${row.state.padEnd(12)} ${row.detail}`)
		}
	}

	const next = installation?.next ?? missing.map((row) => `mailwoman data pull ${row.name}`)

	if (next.length) {
		lines.push("", "Next installation:")

		for (const command of next) {
			lines.push(`  ${command}`)
		}
	}

	if (missing.some((row) => row.access === "licensed")) {
		lines.push("", "A licensed tier needs a token. Get one by one of:", ...licenseRouteLines())
	}

	return lines
}
