/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman data coverage` — what mailwoman can do PER COUNTRY, parse and geocode kept apart.
 *
 *   Sibling of `data inventory`, which asks what artifacts are on disk and whether they can say how they were built.
 *   This asks the question a reader actually has: for a given country, can we parse an address there, and can we place
 *   it — and those two have wildly different answers.
 *
 *   It exists because the answer is held in five registers that do not agree, and reading any one of them alone
 *   produces a confident wrong answer. A published locale package is not training (only `en-us` ships a model; the
 *   rest are data-only overlays). Corpus rows are not training (`country_weights` is a hard admission filter — a
 *   country absent from it trains on nothing, which is how Norway trained on zero rows across 44 configs). Training is
 *   not verification (a board row that is not `status: pass` tracks rather than gates). And the geocoder's coverage is
 *   a different, much wider set than the parser's.
 *
 *   `--json` emits the full report. The checklist form shows the mismatches first, because those are the rows nobody
 *   is looking at.
 */

import { statPath, pathExists, readDirectory } from "@mailwoman/core/fs/readers"

import {
	type CommandSpec,
	CommandTaskResult,
	type ParsedCommandComponent,
	splitUpperList,
	useCommandTask,
	writeRawStdout,
} from "#cli-kit"
import { trains, type CoverageReport } from "#coverage-census"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "coverage",
	description: "What mailwoman parses and geocodes, per country.",
	options: {
		countries: { type: "string", description: "Comma-separated ISO alpha-2 codes. Omit for the countries that train." },
		config: { type: "string", description: "Training config whose country_weights decides admission" },
		refresh: {
			type: "boolean",
			default: false,
			description: "Recount the corpus instead of reading the cache (costs minutes)",
		},
		json: { type: "boolean", default: false, description: "Emit the full report as JSON" },
	},
} as const satisfies CommandSpec

interface Options {
	countries?: string
	config?: string
	refresh: boolean
	json: boolean
}

const CoverageCommand: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { censusCoverage } = await import("#coverage-census")
		const { dataRootPath, repoRootPath } = await import("@mailwoman/core/utils")

		const repoRoot = String(repoRootPath())
		const configDir = `${repoRoot}/corpus-python/src/mailwoman_train/configs`

		// By MTIME, not filename: the version scheme sorts neither lexically nor numerically — `v8-leg2-sp.yaml` beats
		// `v4.8.0-...` both ways, and picking it reports every country as DROPPED, which reads as a catastrophic
		// finding rather than as the wrong file. The report always names the config it used.
		let newest: string | undefined

		if (await pathExists(configDir)) {
			const pairs: Array<{ n: string; at: number }> = []

			for (const n of await readDirectory(configDir)) {
				if (n.endsWith(".yaml") && !n.includes("smoke")) {
					pairs.push({ n, at: (await statPath(`${configDir}/${n}`)).mtimeMs })
				}
			}

			newest = pairs.toSorted((a, b) => b.at - a.at).at(0)?.n
		}

		const versioned = String(dataRootPath("corpus", "versioned"))
		const manifests: Array<{ path: string; at: number }> = []

		// By MTIME, not directory name. Corpus versions sort neither lexically (`v0.9.9` beats `v0.26.0`, because
		// `9` > `2`) nor numerically (`v8-jp-full` beats both) — measured: the name sort picked `v0.9.9` and silently
		// reported the coverage of a corpus nine versions old. The report always names the manifest it used.
		if (await pathExists(versioned)) {
			for (const version of await readDirectory(versioned)) {
				for (const inner of await readDirectory(`${versioned}/${version}`)) {
					const candidate = `${versioned}/${version}/${inner}/MANIFEST.json`

					if (await pathExists(candidate)) {
						manifests.push({ path: candidate, at: (await statPath(candidate)).mtimeMs })
					}
				}
			}
		}

		const manifestPath = manifests.toSorted((a, b) => b.at - a.at)[0]?.path ?? ""

		const report = await censusCoverage({
			configPath: options.config ?? (newest ? `${configDir}/${newest}` : ""),
			manifestPath,
			casesRoot: `${repoRoot}/packages/mailwoman/eval-harness/gauntlet/cases`,
			refresh: options.refresh,
		})

		if (options.json) {
			writeRawStdout(report)

			return { ok: true }
		}

		const wanted = options.countries === undefined ? undefined : splitUpperList(options.countries)

		writeRawStdout(render(report, wanted))

		return { ok: true }
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	return null
}

export default CoverageCommand

/**
 * The checklist form. Mismatches first — they are the rows nobody is looking at, and each one is a defect class that
 * has shipped at least once.
 */
/**
 * How many empty-but-admitted codes to name before eliding.
 *
 * There are ~100 of them by design — the config declares intent for every board country — so the full list buries the
 * three lines above it that a reader must act on.
 */
const EMPTY_CODES_SHOWN = 24

function render(report: CoverageReport, wanted?: string[]): string {
	const shown = wanted
		? report.countries.filter((c) => wanted.includes(c.country))
		: report.countries.filter(trains).toSorted((a, b) => b.corpusRows - a.corpusRows)

	const lines: string[] = []
	const trained = report.countries.filter(trains)
	const withStreet = trained.filter((c) => c.corpusStreetRows > 0)
	const geocodable = report.countries.filter((c) => c.gazetteerPlaces > 0)

	lines.push(
		`corpus ${report.corpusVersion} — ${report.corpusRowsTotal.toLocaleString()} rows` +
			(report.corpusCensusTakenAt ? ` (counts cached ${report.corpusCensusTakenAt})` : " (recounted)"),
		`config ${report.configPath}`,
		"",
		`${trained.length} countries TRAIN · ${withStreet.length} with street-level rows · ${geocodable.length} geocodable · 2 rooftop (US, FR)`,
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
		lines.push(`TRAINED, NOTHING GATES IT: ${m.trainedButUnmeasured.join(" ")}`)
	}

	lines.push("", "country | parse | geocode | board")

	for (const c of shown) {
		const parse = !c.admitted
			? c.corpusRows > 0
				? `DROPPED (${c.corpusRows.toLocaleString()})`
				: "—"
			: c.corpusRows === 0
				? "admitted, no rows"
				: `${c.corpusRows.toLocaleString()}${c.corpusStreetRows ? ` (${c.corpusStreetRows.toLocaleString()} street)` : ", NO STREET"}`

		const geo =
			c.geocodeTier === "rooftop-published"
				? "rooftop"
				: c.gazetteerPlaces
					? `locality ${c.gazetteerPlaces.toLocaleString()}`
					: "—"

		lines.push(
			`${c.country} | ${parse} | ${geo} | ${c.boardRows ? `${c.boardGatedRows}/${c.boardRows} gated` : "unmeasured"}`
		)
	}

	lines.push("", ...report.notes.map((n) => `note: ${n}`))

	return lines.join("\n")
}
