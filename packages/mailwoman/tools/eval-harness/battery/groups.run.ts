// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Compares two groups of trained runs on a battery report that `battery.run.ts` wrote,
 *   and writes `<out>.md` and `<out>.json`.
 *
 *   Usage:
 *   node packages/mailwoman/tools/eval-harness/battery/groups.run.ts --report <report .json> \
 *     --a control=c42-i8,r43-i8,r44-i8 --b candidate=n42-i8,n43-i8 --out <prefix> [--min-country-rows 200]
 *
 *   Each run is an arm of the report.
 *   Group `a` is the comparison arm and group `b` the arm under test.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

import type { BatteryReport } from "#tools/eval-harness/battery/battery"
import { compareRunGroups, formatGroupComparison, type RunGroup } from "#tools/eval-harness/battery/groups"

const { values } = parseArguments({
	options: {
		report: { type: "string", description: "A battery report .json" },
		a: { type: "string", description: "name=run,run,... — the comparison group" },
		b: { type: "string", description: "name=run,run,... — the group under test" },
		out: { type: "string", description: "Output prefix; writes <out>.md and <out>.json" },
		"min-country-rows": { type: "string", default: "200", description: "Decision rows a country needs to be tested" },
	},
})

function group(flag: string, value: string | undefined): RunGroup {
	const [name, runs] = value?.split("=") ?? []

	if (!name || !runs) throw new Error(`--${flag} takes name=run,run,..., got ${value}`)

	return { name, runs: runs.split(",").map((run) => run.trim()) }
}

if (!values.report || !values.out) throw new Error("--report and --out are required")

const report = await readLocalJSONFile<BatteryReport>(values.report)

const comparison = compareRunGroups(report, group("a", values.a), group("b", values.b), {
	minimumCountryRows: Number(values["min-country-rows"]),
})

await writeLocalTextFile(formatGroupComparison(comparison), `${values.out}.md`)
await writeLocalJSONFile(comparison, `${values.out}.json`)

console.log(`wrote ${values.out}.md and ${values.out}.json`)
