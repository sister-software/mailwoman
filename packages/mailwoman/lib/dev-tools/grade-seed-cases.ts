/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Grade seed cases BEFORE they are committed, through the gauntlet's own grader, and stamp each one's `status` with
 *   what the shipped pipeline does today: `pass` when it passes, `improvement_target` when it does not. A board author
 *   that writes statuses by hand writes what it hopes; this writes what was measured, and the regression layer then
 *   holds the passes as pins and reports the targets as tracked.
 *
 *   The shape is the regression runner's own loop (`regression.ts`): route the row's overlay country, geocode through
 *   the shared deps, project through `runOne`, grade through `checkCase`. Sharing the function rather than the shape is
 *   what keeps a board builder's verdict equal to the runner's.
 */

import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import type { PathBuilderLike } from "path-ts"

import {
	canonicalizeSeedCase,
	SEED_CASE_KEY_ORDER,
	seedCaseToTableRow,
	type SeedCase,
} from "#eval-harness/gauntlet/cases/seed-case"
import { checkCase } from "#eval-harness/gauntlet/check-case"
import { buildGauntletDeps, type GauntletDeps, runOne } from "#eval-harness/gauntlet/harness"
import { routeCountry } from "#eval-harness/gauntlet/routing"

export interface GradedSeedCase {
	seed: SeedCase
	/**
	 * The grader's findings; empty is a pass.
	 */
	issues: string[]
}

/**
 * Grade every case in place: `status` becomes `pass` or `improvement_target`, and the issues come back beside each row.
 * `deps` defaults to the production ladder (shipped model, production resolver pins) and is disposed when built here.
 */
export async function gradeSeedCases(cases: SeedCase[], deps?: GauntletDeps): Promise<GradedSeedCase[]> {
	const owned = deps ?? (await buildGauntletDeps())
	const graded: GradedSeedCase[] = []

	try {
		for (const seed of cases) {
			const overlayCountry = routeCountry(seed)

			const result = await runOne(seed.input, owned, {
				...(seed.defaultCountry ? { defaultCountry: seed.defaultCountry } : {}),
				...(overlayCountry ? { caseCountry: overlayCountry } : {}),
				...(seed.locale ? { fuzzyCountryScope: seed.locale.split("-")[1] } : {}),
			})

			const issues = checkCase(seedCaseToTableRow(seed), result)

			seed.status = issues.length ? "improvement_target" : "pass"
			graded.push({ seed, issues })
		}
	} finally {
		if (!deps) {
			owned[Symbol.dispose]()
		}
	}

	return graded
}

/**
 * Write seed cases as a committed case file: sorted by id (the loader's order, so a text diff means something), each
 * row re-keyed through the canonical key order. A duplicate id is an authoring error and refuses.
 */
export async function writeSeedCaseFile(cases: readonly SeedCase[], path: PathBuilderLike): Promise<void> {
	const seen = new Set<string>()

	for (const seed of cases) {
		if (seen.has(seed.id)) throw new Error(`duplicate case id ${seed.id}`)

		seen.add(seed.id)
	}

	const sorted = cases.toSorted((a, b) => a.id.localeCompare(b.id))

	const lines = sorted.map((seed) => {
		const canonical = canonicalizeSeedCase(seed)

		return JSON.stringify(canonical, [...SEED_CASE_KEY_ORDER, ...Object.keys(canonical.expectComponents ?? {})])
	})

	await writeLocalTextFile(lines.join("\n") + "\n", path)

	console.log(`wrote ${sorted.length} rows → ${path}`)
}

/**
 * How many failing rows a per-group read prints; the file carries every row's status.
 */
export const ISSUES_SHOWN_PER_GROUP = 12

/**
 * Print a per-group read: `<group>: <pass>/<total> pass`, then the first failing rows with the grader's findings.
 */
export function reportGradedGroups(graded: readonly GradedSeedCase[], groupOf: (seed: SeedCase) => string): void {
	const groups = new Map<string, { pass: number; total: number; issues: string[] }>()

	for (const { seed, issues } of graded) {
		const key = groupOf(seed)
		const tally = groups.get(key) ?? { pass: 0, total: 0, issues: [] }

		tally.total++

		if (issues.length) {
			tally.issues.push(`  ~ ${seed.id} "${seed.input}": ${issues.join("; ")}`)
		} else {
			tally.pass++
		}

		groups.set(key, tally)
	}

	for (const [key, tally] of groups) {
		console.log(`${key}: ${tally.pass}/${tally.total} pass`)

		for (const line of tally.issues.slice(0, ISSUES_SHOWN_PER_GROUP)) {
			console.log(line)
		}

		if (tally.issues.length > ISSUES_SHOWN_PER_GROUP) {
			console.log(`  … ${tally.issues.length - ISSUES_SHOWN_PER_GROUP} more`)
		}
	}
}
