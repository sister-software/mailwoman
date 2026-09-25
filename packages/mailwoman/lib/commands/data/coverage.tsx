/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	type CommandSpec,
	CommandTaskResult,
	type CommandComponent,
	splitCountryCodes,
	useCommandTask,
	writeRawStdout,
} from "#cli-kit"
import { trains, type CoverageReport, type GeocodeTier } from "#coverage/census"

/**
 * Command specification for `data coverage`, which reports parse and geocode coverage for each country.
 */
export const spec = {
	name: "coverage",
	description: "What mailwoman parses and geocodes, per country.",
	options: {
		countries: { type: "string", description: "Comma-separated ISO alpha-2 codes. Omit for the countries that train." },
		config: {
			type: "string",
			description:
				"Training config whose country_weights decides admission. Defaults to the config scope.config.json records for the Latin family's shipped graph.",
		},
		refresh: {
			type: "boolean",
			default: false,
			description: "Recount the corpus instead of reading the cache (costs minutes)",
		},
		manifest: {
			type: "string",
			description:
				"Corpus MANIFEST.json to count with --refresh. Defaults to the newest manifest under the data root's corpus/versioned/.",
		},
		json: { type: "boolean", default: false, description: "Emit the full report as JSON" },
	},
} as const satisfies CommandSpec

const CoverageCommand: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { censusCoverage, newestManifest, resolveTrainingConfig } = await import("#coverage/census")
		const { repoRootPath } = await import("@mailwoman/core/paths")
		const { readScopeConfig } = await import("@mailwoman/core/scope-config")

		const repoRoot = repoRootPath()

		// The default config comes from `scope.config.json` because neither file mtimes
		// nor version names order the configs reliably.
		const config = resolveTrainingConfig(await readScopeConfig(), { requested: options.config })
		const manifestPath = options.manifest ?? (await newestManifest())

		const report = await censusCoverage({
			configPath: config.path,
			manifestPath,
			casesRoot: `${repoRoot}/packages/mailwoman/lib/eval-harness/gauntlet/cases`,
			refresh: options.refresh,
		})

		if (options.json) {
			writeRawStdout(report)

			return { ok: true }
		}

		const wanted = options.countries === undefined ? undefined : splitCountryCodes(options.countries)

		writeRawStdout(render(report, wanted))

		return { ok: true }
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	return null
}

export default CoverageCommand

/**
 * The number of admitted-but-empty country codes listed before the rest are elided.
 */
const EMPTY_CODES_SHOWN = 24

/**
 * Renders the coverage checklist with mismatches listed before the per-country table.
 */
function render(report: CoverageReport, wanted?: string[]): string {
	const shown = wanted
		? report.countries.filter((c) => wanted.includes(c.country))
		: report.countries.filter(trains).toSorted((a, b) => b.corpusRows - a.corpusRows)

	const lines: string[] = []
	const trained = report.countries.filter(trains)
	const withStreet = trained.filter((c) => c.corpusStreetRows > 0)
	const geocodable = report.countries.filter((c) => c.gazetteerPlaces > 0)

	const rooftopSummary = (tier: GeocodeTier, label: string) => {
		const codes = report.countries.filter((c) => c.geocodeTier === tier).map((c) => c.country)

		return `${codes.length} ${label}${codes.length ? ` (${codes.join(", ")})` : ""}`
	}

	lines.push(
		`corpus ${report.corpusVersion} — ${report.corpusRowsTotal.toLocaleString()} rows` +
			(report.corpusCensusTakenAt ? ` (counts cached ${report.corpusCensusTakenAt})` : " (recounted)"),
		`config ${report.configPath}`,
		"",
		`${trained.length} countries TRAIN · ${withStreet.length} with street-level rows · ${geocodable.length} geocodable · ${rooftopSummary("rooftop-published", "rooftop")} · ${rooftopSummary("rooftop-build-local", "rooftop build-local")}`,
		""
	)

	const m = report.mismatches

	if (m.presentButDropped.length) {
		lines.push(`SILENTLY DROPPED — corpus rows, absent from country_weights: ${m.presentButDropped.join(" ")}`)
	}

	if (m.packageWithoutTraining.length) {
		lines.push(`SHIPS A LOCALE PACKAGE, NEVER TRAINED: ${m.packageWithoutTraining.join(" ")}`)
	}

	if (m.admittedButEmpty.length) {
		lines.push(
			`ADMITTED BUT EMPTY (${m.admittedButEmpty.length}): ${m.admittedButEmpty.slice(0, EMPTY_CODES_SHOWN).join(" ")}${m.admittedButEmpty.length > EMPTY_CODES_SHOWN ? " …" : ""}`
		)
	}

	if (m.trainedButUnmeasured.length) {
		lines.push(`TRAINED, NOTHING CHECKS IT: ${m.trainedButUnmeasured.join(" ")}`)
	}

	lines.push("", "country | parse | geocode | board")

	for (const c of shown) {
		const parse = !c.admitted
			? c.corpusRows > 0
				? `DROPPED (${c.corpusRows.toLocaleString()})`
				: "—"
			: c.corpusRows === 0
				? "admitted without rows"
				: `${c.corpusRows.toLocaleString()}${c.corpusStreetRows ? ` (${c.corpusStreetRows.toLocaleString()} street)` : ", NO STREET"}`

		const geo =
			c.geocodeTier === "rooftop-published"
				? "rooftop"
				: c.geocodeTier === "rooftop-build-local"
					? "rooftop (build-local)"
					: c.gazetteerPlaces
						? `locality ${c.gazetteerPlaces.toLocaleString()}`
						: "—"

		lines.push(
			`${c.country} | ${parse} | ${geo} | ${c.boardRows ? `${c.boardPassedRows}/${c.boardRows} conditional` : "unmeasured"}`
		)
	}

	lines.push("", ...report.notes.map((n) => `note: ${n}`))

	return lines.join("\n")
}
