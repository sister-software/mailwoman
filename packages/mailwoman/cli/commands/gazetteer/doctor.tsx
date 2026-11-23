// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `mailwoman gazetteer doctor`: check the Who's On First clones before a build reads them.
 *
 *   It reports retired records still in the forks, references to IDs no clone holds,
 *   and successors listed in `whosonfirst-data-deprecated` that no clone holds.
 *   It reads the clones and changes none of them.
 *   The exit status is non-zero when any check fails.
 *
 *   With `--postcodes` it audits the postcode clones instead: each `whosonfirst-data-postalcode-<cc>`
 *   clone's current records against the postcode package's formats, a geometry at 0,
 *   0, the GeoNames postal exports, and the other clones' postcodes.
 *   That mode prints counts and exits 0.
 */

import { allKeyed } from "@mailwoman/core/async/promises"
import { dataRootPath, wofReposPath } from "@mailwoman/core/data-root"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { formatQuantity } from "@mailwoman/core/resources/locale"
import type {
	PostcodeAuditReport,
	PostcodeCloneAudit,
	PostcodeFinding,
} from "@mailwoman/gazetteer/tools/pipeline/wof/postcode-audit"
import { PathBuilder } from "path-ts"

import {
	type Check,
	CheckList,
	type CommandComponent,
	type CommandSpec,
	CommandSummaryLines,
	CommandTaskResult,
	useCommandTask,
	useStageProgress,
} from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "doctor",
	description: "Check the Who's On First clones for retired records and references no clone resolves.",
	positionals: [
		{
			name: "local-repo-directory",
			description: "Repository root. Default <cache-root>/sources/wof-repos",
		},
	],
	options: {
		deprecated: {
			type: "string",
			description: "The whosonfirst-data-deprecated checkout. Default <repository root>/whosonfirst-data-deprecated",
		},
		out: { type: "string", description: "Write the full report, with examples, to this JSON file" },
		concurrency: { type: "number", description: "Records read at once. Default 32" },
		postcodes: {
			type: "boolean",
			default: false,
			description: "Audit the postcode clones' current records instead, print counts and exit 0",
		},
		"geonames-postal": {
			type: "string",
			description: "GeoNames postal export directory for --postcodes. Default <data-root>/geonames-postal",
		},
	},
} as const satisfies CommandSpec

/**
 * A finding's count, or the state that kept it from being measured.
 */
function findingText(finding: PostcodeFinding): string {
	return typeof finding.count === "number" ? formatQuantity(finding.count) : finding.state
}

/**
 * The lines the postcode audit prints: one per clone, then the totals over the clones that were read.
 */
function postcodeAuditLines(report: PostcodeAuditReport, out: string | undefined): string[] {
	const read = report.clones.filter((clone) => clone.read)

	const total = (pick: (clone: PostcodeCloneAudit) => number | null) =>
		formatQuantity(read.reduce((sum, clone) => sum + (pick(clone) ?? 0), 0))

	return [
		`Audited ${read.length} of ${report.clones.length} postcode clones against ${report.geonamesDirectory}`,
		...report.clones.map((clone) =>
			clone.read
				? `${clone.country}: ${formatQuantity(clone.records)} records, ${formatQuantity(clone.current)} current, ` +
					`${formatQuantity(clone.skipped)} skipped, ${formatQuantity(clone.unreadable.count)} unreadable; ` +
					`format ${findingText(clone.format)}; geometry at 0, 0 ${findingText(clone.geometry)}; ` +
					`uncorroborated ${findingText(clone.corroboration)}` +
					(clone.corroboration.territoryUnread.count
						? ` (and ${formatQuantity(clone.corroboration.territoryUnread.count)} whose territory export is unread)`
						: "") +
					`; shared ${findingText(clone.shared)}`
				: `${clone.country}: unread, ${clone.error}`
		),
		`Read clones together: ${total((clone) => clone.records)} records, ${total((clone) => clone.current)} current; ` +
			`format ${total((clone) => clone.format.count)}; geometry at 0, 0 ${total((clone) => clone.geometry.count)}; ` +
			`uncorroborated ${total((clone) => clone.corroboration.count)}; ` +
			`${formatQuantity(report.shared.length)} postcodes shared by two or more countries`,
		...(out ? [`Wrote the record ids to ${out}`] : []),
	]
}

/**
 * The most entries a check's detail lists before it summarizes.
 */
const LISTED = 5

function topEntries(counts: Record<string, number>): string {
	return Object.entries(counts)
		.toSorted((a, b) => b[1] - a[1])
		.slice(0, LISTED)
		.map(([key, count]) => `${key} ${formatQuantity(count)}`)
		.join(", ")
}

const GazetteerDoctor: CommandComponent<typeof spec, [string?]> = ({ options, args }) => {
	const progress = useStageProgress()

	const state = useCommandTask(
		async () => {
			const {
				audit: { auditReposRoot },
				doctor: { diagnoseClones, readDeprecatedMapping },
				repoOrigin: { WOF_DEPRECATED_REPO },
				Placetype: { PLACETYPES_REPO },
			} = await allKeyed({
				audit: import("@mailwoman/gazetteer/tools/pipeline/repos/audit"),
				doctor: import("@mailwoman/gazetteer/tools/pipeline/wof/doctor"),
				repoOrigin: import("@mailwoman/gazetteer/tools/pipeline/wof/repo-origin"),
				Placetype: import("@mailwoman/gazetteer/whosonfirst/placetypes/Placetype"),
			})

			const root = args[0] ? PathBuilder.from(args[0]) : wofReposPath()

			if (options.postcodes) {
				const { auditPostcodeClones } = await import("@mailwoman/gazetteer/tools/pipeline/wof/postcode-audit")
				const cloned = await auditReposRoot(root)

				const postcodeClones = cloned.repos.flatMap((repo) =>
					repo.theme === "postalcode" && repo.country
						? [{ repo: repo.name, directory: root(repo.name), country: repo.country, commit: repo.commit }]
						: []
				)

				progress.report("clones", `${postcodeClones.length} postcode clones under ${root.toString()}`)

				const report = await auditPostcodeClones(postcodeClones, {
					geonamesDirectory: options.geonamesPostal ?? dataRootPath("geonames-postal"),
					...(options.concurrency ? { concurrency: options.concurrency } : {}),
					onClone: (clone) =>
						progress.report(
							clone.repo,
							clone.read ? `${formatQuantity(clone.records)} records` : `unread, ${clone.error}`
						),
				})

				if (options.out) {
					await writeLocalJSONFile(
						{ ...report, commits: Object.fromEntries(postcodeClones.map((clone) => [clone.repo, clone.commit])) },
						options.out
					)
				}

				return { ok: true, checks: [], lines: postcodeAuditLines(report, options.out) }
			}

			const audit = await auditReposRoot(root, { readCommits: false })

			const clones = audit.repos
				.filter((repo) => repo.name !== WOF_DEPRECATED_REPO && repo.name !== PLACETYPES_REPO.name)
				.map((repo) => ({ repo: repo.name, directory: root(repo.name) }))

			const deprecatedDirectory = options.deprecated ? PathBuilder.from(options.deprecated) : root(WOF_DEPRECATED_REPO)
			let mapping: Map<number, number[]> | null = null
			let mappingError: string | null = null

			try {
				mapping = await readDeprecatedMapping(deprecatedDirectory)
			} catch (error) {
				mappingError = error instanceof Error ? error.message : String(error)
			}

			console.error(`Scanning ${clones.length} clones under ${root.toString()}`)

			const report = await diagnoseClones(clones, mapping, {
				...(options.concurrency ? { concurrency: options.concurrency } : {}),
				onClone: (repo, records) => console.error(`  ▸ ${repo}: ${formatQuantity(records)} records`),
			})

			if (options.out) {
				await writeLocalJSONFile({ ...report, mappingError }, options.out)
			}

			const { retired, dangling } = report

			const checks: Check[] = [
				{
					ok: report.unreadable.count === 0,
					check: "Every record reads",
					detail:
						`${formatQuantity(report.records)} records in ${report.clones} clones; ` +
						`${formatQuantity(report.unreadable.count)} unreadable; ` +
						`${formatQuantity(report.wholeFileParses)} parsed whole because the geometry came first`,
				},
				{
					ok: retired.superseded + retired.deprecated === 0,
					check: "The forks carry no retired record",
					detail:
						`${formatQuantity(retired.superseded)} superseded, ${formatQuantity(retired.deprecated)} deprecated without a successor` +
						(retired.superseded + retired.deprecated
							? `; most in ${topEntries(Object.fromEntries(Object.entries(retired.byRepo).map(([repo, c]) => [repo, c.superseded + c.deprecated])))}`
							: ""),
				},
				{
					ok: dangling.ids === 0,
					check: "Every parent and hierarchy ID resolves",
					detail:
						`${formatQuantity(dangling.ids)} IDs no clone carries, in ${formatQuantity(dangling.references)} references` +
						(dangling.ids
							? `; ${formatQuantity(dangling.listed)} listed in ${WOF_DEPRECATED_REPO}, ` +
								`${formatQuantity(dangling.resolvable)} of them leading to a successor a clone carries; by key ${topEntries(dangling.byKey)}`
							: ""),
				},
				{
					ok: mapping !== null && report.mapping.successorMissing === 0,
					check: `Every successor ${WOF_DEPRECATED_REPO} lists is present`,
					detail: mapping
						? `${formatQuantity(report.mapping.entries)} listed IDs; ${formatQuantity(report.mapping.successorMissing)} lead to an ID no clone carries`
						: `${deprecatedDirectory.toString()} could not be read: ${mappingError}`,
				},
			]

			return { ok: checks.every((check) => check.ok), checks, lines: null }
		},
		(result) => (result.ok ? 0 : 1)
	)

	if (state.status !== "done") return <CommandTaskResult state={state} progress={progress} />

	if (state.result.lines) return <CommandSummaryLines lines={state.result.lines} />

	return <CheckList checks={state.result.checks} verdict={state.result.ok} />
}

export default GazetteerDoctor
