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

import { readFileSync, writeFileSync } from "node:fs"

import { mailwomanDataRoot, repoRootPath } from "@mailwoman/core/utils"
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
import { addCountry, removeCountry } from "../../gazetteer-pipeline/recipe-edit.ts"
import { auditReposRoot, clonedCountries, reposSentence } from "../../gazetteer-pipeline/repos-audit.ts"

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
		write: {
			type: "boolean",
			default: false,
			description: "Apply the recipe edits to defaults.ts (leaves them UNSTAGED for review)",
		},
	},
} as const satisfies CommandSpec

interface Options {
	target?: string
	adminDB?: string
	write: boolean
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

			// The repos root is checked against the DECLARED wof list rather than substituted for it. The WOF leg
			// is presence-driven, so a clone nobody declared becomes coverage on the next build and a declaration
			// nobody cloned silently does not — and only comparing the two can tell those apart.
			const reposRoot = String(resolvePath(mailwomanDataRoot(), "wof", "repos"))
			const audit = auditReposRoot(reposRoot)
			const cloned = clonedCountries(audit)

			const sources = countrySourceMap(lists)
			const conflicts = sourceConflicts(sources)

			const lines: string[] = [
				"mailwoman gazetteer country-plan",
				"",
				sourceSentence(sources, conflicts),
				reposSentence(audit),
			]

			const declaredNotCloned = lists.wofCountries.filter((cc) => !cloned.includes(cc.toUpperCase()))
			const clonedNotDeclared = cloned.filter((cc) => !lists.wofCountries.some((d) => d.toUpperCase() === cc))

			if (declaredNotCloned.length || clonedNotDeclared.length) {
				lines.push("", "the WOF list and the repos root disagree:")

				if (declaredNotCloned.length) {
					lines.push(
						`  declared, NOT cloned: ${declaredNotCloned.join(", ")}`,
						"      the ingest globs the repos root, so these contribute nothing until they are synced"
					)
				}

				if (clonedNotDeclared.length) {
					lines.push(
						`  cloned, NOT declared: ${clonedNotDeclared.join(", ")}`,
						"      the ingest reads no list, so these become coverage on the next build regardless"
					)
				}
			}

			if (audit.duplicated.length) {
				lines.push("", "checked out TWICE — two independent copies, which can diverge:")

				for (const repo of audit.duplicated) {
					const commits = Object.entries(repo.commits)
						.map(([layout, head]) => `${layout}=${head}`)
						.join(" ")

					lines.push(`  ${audit.diverged.includes(repo) ? "✗" : "·"} ${repo.name}  ${commits}`)
				}
			}

			if (audit.aliased.length) {
				// Read twice by the ingest all the same — `ingest-wof` passes no `followSymbolicLinks` and
				// fast-glob defaults it to true — but one directory cannot diverge from itself.
				lines.push("", "symlinked into the other layout — one copy, read twice, cannot diverge:")

				for (const repo of audit.aliased) {
					lines.push(`  · ${repo.name}`)
				}
			}

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

			let writeFailures = 0

			// `--write` edits the working tree and stops there. It does not stage, commit or build: the value
			// this command adds is that BOTH halves of a move are written or neither, and a diff a person reads
			// is what keeps that reviewable. A commit would move the review to after the fact.
			if (options.write && plan.edits.length && !plan.blockers.length) {
				const defaultsPath = String(repoRootPath("packages", "mailwoman", "gazetteer-pipeline", "defaults.ts"))
				let source = readFileSync(defaultsPath, "utf8")
				const applied: string[] = []

				for (const edit of plan.edits) {
					const result =
						edit.action === "add"
							? addCountry(source, edit.list, edit.country)
							: removeCountry(source, edit.list, edit.country)

					if (!result.ok) {
						writeFailures++
						applied.push(`  ✗ ${edit.action} ${edit.list}: ${result.reason}`)

						for (const line of result.comment ?? []) {
							applied.push(`      ${line.trim()}`)
						}

						continue
					}

					source = result.source
					applied.push(`  ${result.changed ? "✓" : "·"} ${result.note}`)
				}

				// All or nothing. A half-applied move is the exact state the #267 warning describes, and writing
				// one edit while refusing the other would manufacture it.
				if (writeFailures) {
					lines.push("", "NOT WRITTEN — every edit must apply or none do:", ...applied)
				} else {
					writeFileSync(defaultsPath, source)
					lines.push("", `wrote ${defaultsPath}:`, ...applied, "", "  Review with `git diff`, then commit.")
				}
			} else if (plan.edits.length && !plan.blockers.length) {
				lines.push("", "Pass --write to apply these edits to defaults.ts (unstaged, for review).")
			}

			writeRawStdout(`${lines.join("\n")}\n`)

			return { conflicts: conflicts.length + plan.blockers.length + writeFailures }
		},
		(result) => (result.conflicts > 0 ? 1 : 0)
	)

	if (state.status === "error") return <Text color="red">{state.message}</Text>

	return null
}

export default CountryPlanCommand
