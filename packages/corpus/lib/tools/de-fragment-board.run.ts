/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Writes the DE fragment board and its reserved surfaces from Overture-DE.
 *
 *   Usage:
 *     node packages/corpus/lib/tools/de-fragment-board.run.ts [--per-class 400] [--seed 42]
 *       [--parquet $MAILWOMAN_DATA_ROOT/overture/2026-06-17.0/addresses-de.parquet]
 *       [--lexicon $MAILWOMAN_DATA_ROOT/gazetteer/locality-surface-lexicon-v7.json]
 *       [--out packages/mailwoman/tools/eval-harness/fixtures/overture-fragments-de.jsonl]
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { repoRootPath } from "@mailwoman/core/paths"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { buildDEFragmentBoard } from "#de/fragment-board"

const { values } = parseArguments({
	options: {
		"per-class": { type: "string", default: "400" },
		seed: { type: "string", default: "42" },
		parquet: { type: "string" },
		lexicon: { type: "string" },
		out: { type: "string" },
	},
})

const integer = (name: string, value: string): number => {
	const parsed = Number(value)

	if (!Number.isSafeInteger(parsed)) throw new Error(`--${name} must be an integer, got ${value}`)

	return parsed
}

const counts = await buildDEFragmentBoard({
	parquet: values.parquet ?? dataRootPath("overture", "2026-06-17.0", "addresses-de.parquet").toString(),
	lexicon: values.lexicon ?? dataRootPath("gazetteer", "locality-surface-lexicon-v7.json").toString(),
	out:
		values.out ??
		repoRootPath(
			"packages",
			"mailwoman",
			"tools",
			"eval-harness",
			"fixtures",
			"overture-fragments-de.jsonl"
		).toString(),
	perClass: integer("per-class", values["per-class"]),
	seed: integer("seed", values.seed),
})

for (const [klass, count] of counts) {
	console.log(`  ${klass.padEnd(22)} ${count}`)
}
