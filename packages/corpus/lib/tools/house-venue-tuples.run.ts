/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Writes the house-venue tuples file from each country's register.
 *
 *   Usage:
 *     node packages/corpus/lib/tools/house-venue-tuples.run.ts [--fr 60000] [--us 60000] [--gb 60000] [--seed 42]
 *       [--out <tuples.jsonl>]
 *
 *   Pass a country and an earlier tuples-file path to reuse that country's rows.
 */

import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { orderedJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { resolvePath } from "path-ts"

import {
	assembleHouseVenueTuples,
	HOUSE_VENUE_DEFAULT_BUDGET,
	HOUSE_VENUE_DEFAULT_SEED,
	HOUSE_VENUE_SAMPLERS,
	houseVenueTuplesPath,
} from "#recipes/house-venue-tuples"

const codes = HOUSE_VENUE_SAMPLERS.map(([code]) => code)

const { values } = parseArguments({
	options: {
		...Object.fromEntries(
			codes.map((code) => [code, { type: "string" as const, default: String(HOUSE_VENUE_DEFAULT_BUDGET) }])
		),
		seed: { type: "string", default: String(HOUSE_VENUE_DEFAULT_SEED) },
		out: { type: "string" },
		carry: { type: "string", multiple: true, default: [] },
		"carry-from": { type: "string" },
	},
})

const carry = values.carry as string[]

for (const code of carry) {
	if (!codes.includes(code)) throw new Error(`--carry ${code} names no country; choose from ${codes.join(", ")}`)
}

const out = values.out ? resolvePath(values.out as string) : houseVenueTuplesPath()
const carryFrom = values["carry-from"] ? resolvePath(values["carry-from"] as string) : undefined

if (carryFrom && carryFrom.toString() === out.toString()) throw new Error("--carry-from names the output file")

const parts = await assembleHouseVenueTuples({
	budgets: Object.fromEntries(codes.map((code) => [code, Number((values as Record<string, unknown>)[code])])),
	seed: Number(values.seed),
	carry,
	carryFrom,
})

await writeLocalTextFile(
	// An iterable writes one line per entry, each newline-terminated.
	parts.flatMap(([, tuples]) => tuples.map((tuple) => orderedJSON(tuple))),
	out
)

const summary = parts.map(([code, tuples]) => `${code.toUpperCase()} ${tuples.length.toLocaleString("en-US")}`)

console.log(`${out.toString()}: ${summary.join(" + ")} tuples`)
