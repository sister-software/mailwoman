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
import { runFile } from "@mailwoman/core/process"
import { childEnv } from "@mailwoman/core/scripting/utils"
import type { PathBuilderLike } from "path-ts"

import { BUNDLES, type DataBundle } from "#data/bundles"
import { licenseRouteLines } from "#data/licensed"

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
	const asked = new Set(countries.map((country) => country.trim().toUpperCase()).filter((country) => country.length))

	return Object.values(bundles)
		.filter((bundle) => {
			if (!bundle.countries || !asked.size) return true

			return bundle.countries.some((country) => asked.has(country.toUpperCase()))
		})
		.map((bundle) => tierRow(bundle, installed))
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
 * The lines the non-interactive run prints.
 *
 * They are the roots, the parsed sample, one line per tier, the pull commands for the tiers
 * that are not installed, and the routes to a token when a licensed tier is among them.
 */
export function setupSummary(checks: SetupChecks, tiers: readonly TierRow[]): string[] {
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

	if (missing.length) {
		lines.push("", "Fetch a tier:")

		for (const row of missing) {
			lines.push(`  mailwoman data pull ${row.name}`)
		}
	}

	if (missing.some((row) => row.access === "licensed")) {
		lines.push("", "A licensed tier needs a token. Get one by one of:", ...licenseRouteLines())
	}

	return lines
}
