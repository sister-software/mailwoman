/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer country-plan <cc>` — what moving a country between admin sources would involve.
 *
 *   READ-ONLY, by construction and not by flag. It clones nothing, edits nothing and builds nothing; the
 *   `--apply` half is a separate command precisely because the steps it would take are a clone measured in
 *   hundreds of megabytes and an edit to a file that is reviewed like code.
 *
 *   Everything it reports is computed from the ARTIFACT rather than the lists. `defaults.ts` is a
 *   declaration and the WOF leg is presence-driven, so only the built database has the two reconciled —
 *   and reading a declaration to decide what to change is how #1015 happened.
 *
 *   Output goes through {@linkcode writeRawStdout} for the reason `data/index.tsx` gives: an Ink frame as
 *   tall as the viewport emits `\x1b[3J`, which wipes the scrollback.
 */

import { mailwomanDataRoot } from "@mailwoman/core/utils"
import { Text } from "ink"
import { type CommandSpec, type ParsedCommandComponent, useCommandTask, writeRawStdout } from "mailwoman/cli-kit"
import { resolvePath } from "path-ts"

import {
	adminDBAvailable,
	censusForCountry,
	CHECKOUT_SIZE_RATIO,
	planCountryMove,
	servingSources,
} from "../../gazetteer-pipeline/country-plan.ts"
import {
	AdminSource,
	countrySourceMap,
	sourceConflicts,
	sourceSentence,
} from "../../gazetteer-pipeline/country-sources.ts"
import {
	DEFAULT_GEONAMES_COUNTRIES,
	DEFAULT_OVERTURE_COUNTRIES,
	DEFAULT_WOF_PRIORITY_COUNTRIES,
} from "../../gazetteer-pipeline/defaults.ts"

export const description =
	"Report which source serves a country's admin coverage today, and every edit moving it would require. " +
	"Read-only: clones nothing, edits nothing, builds nothing."

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "country-plan",
	description,
	positionals: [{ name: "country", description: "ISO-2 country code. Omit to audit every country's sources" }],
	options: {
		target: { type: "string", description: `Source to move to: ${Object.values(AdminSource).join(", ")}. Default wof` },
		"admin-db": { type: "string", description: "Override the admin gazetteer path" },
	},
} as const satisfies CommandSpec

interface Options {
	target?: string
	adminDB?: string
}

/**
 * The repositories a WOF move would clone. Names only — `--plan` never reaches the network, so their existence and size
 * are reported as UNKNOWN rather than guessed.
 */
function wofRepoNames(country: string): string[] {
	const cc = country.toLowerCase()

	return [`whosonfirst-data-admin-${cc}`, `whosonfirst-data-postalcode-${cc}`]
}

const CountryPlanCommand: ParsedCommandComponent<Options, [string?]> = ({ options, args }) => {
	const state = useCommandTask(
		async () => {
			const adminDB = options.adminDB ?? String(resolvePath(mailwomanDataRoot(), "wof", "admin-global-priority.db"))

			const lists = {
				wofCountries: DEFAULT_WOF_PRIORITY_COUNTRIES as readonly string[],
				overtureCountries: DEFAULT_OVERTURE_COUNTRIES as readonly string[],
				geonamesCountries: DEFAULT_GEONAMES_COUNTRIES as readonly string[],
			}

			const sources = countrySourceMap(lists)
			const conflicts = sourceConflicts(sources)
			const lines: string[] = ["mailwoman gazetteer country-plan", "", sourceSentence(sources, conflicts)]

			if (conflicts.length) {
				lines.push("", "UNRECORDED multi-source countries:")

				for (const conflict of conflicts) {
					lines.push(`  ✗ ${conflict.reason}`)
				}
			}

			const country = args[0]?.toUpperCase()

			if (!country) {
				lines.push("", "Pass a country code to plan a move.")
				writeRawStdout(`${lines.join("\n")}\n`)

				return { conflicts: conflicts.length }
			}

			if (!adminDBAvailable(adminDB)) {
				// Absence reported as absence: without the artifact there is no current state to move FROM, and
				// guessing it from the lists is the thing this command exists not to do.
				lines.push(
					"",
					`No admin gazetteer at ${adminDB}.`,
					"The current source can only be read from the built artifact — the lists are a declaration, and the",
					"WOF leg is presence-driven, so they cannot answer which source is actually serving a country."
				)

				writeRawStdout(`${lines.join("\n")}\n`)

				return { conflicts: conflicts.length }
			}

			const census = censusForCountry(adminDB, country)
			const target = (options.target ?? AdminSource.WOF) as AdminSource

			const plan = planCountryMove({
				country,
				target,
				census,
				repos: wofRepoNames(country).map((name) => ({ name, exists: true })),
			})

			lines.push(
				"",
				`${country} today, from ${adminDB.split("/").at(-1)}:`,
				`  wof ${census.wof}   overture ${census.overture}   geonames ${census.geonames}`,
				`  served by: ${servingSources(census).join(" + ") || "nothing"}`,
				"",
				`moving ${country} → ${target} requires:`
			)

			if (!plan.edits.length) {
				lines.push(`  (nothing — ${country} is already served by ${target} alone)`)
			}

			for (const edit of plan.edits) {
				lines.push(`  ${edit.action === "add" ? "+" : "−"} ${edit.list}  "${edit.country}"`, `      ${edit.why}`)
			}

			if (target === AdminSource.WOF) {
				lines.push(
					"",
					"repositories to clone (sizes UNKNOWN — this command makes no network call):",
					...plan.repos.map((r) => `  ${r.name}`),
					`  GitHub reports PACKED size; multiply by ~${CHECKOUT_SIZE_RATIO} for the checkout.`,
					"  Measured: three repos reported as 83.4 MB occupied 633 MB once cloned.",
					"",
					`  mailwoman gazetteer inspect sync --countries ${country.toLowerCase()}`
				)
			}

			if (plan.blockers.length) {
				lines.push("", "BLOCKED:")

				for (const blocker of plan.blockers) {
					lines.push(`  ✗ ${blocker}`)
				}
			}

			writeRawStdout(`${lines.join("\n")}\n`)

			return { conflicts: conflicts.length + plan.blockers.length }
		},
		(result) => (result.conflicts > 0 ? 1 : 0)
	)

	if (state.status === "error") return <Text color="red">{state.message}</Text>

	return null
}

export default CountryPlanCommand
