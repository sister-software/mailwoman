// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The command-line entry of the three capability arenas.
 *
 *   The arenas are `tools/eval-harness/evaluation/external-arenas.ts`, and the promotion evaluation
 *   calls that module in its own process. This entry runs the same module from a shell.
 *
 *   Output is byte-identical because the module owns every printed line.
 *   Do not add logic here.
 */

import { runIfScript } from "@mailwoman/core/scripting"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { parseAddressSystemConventions } from "@mailwoman/neural/classifier/options"

import { externalArenas } from "#tools/eval-harness/evaluation/external-arenas"

async function main(): Promise<void> {
	// Flags replace the bash-era env interface (model=… tokenizer=… → --model … --tokenizer …).
	const { values: cli } = parseArguments({
		options: {
			"out-dir": { type: "string" },
			model: { type: "string" },
			tokenizer: { type: "string" },
			"model-card": { type: "string" },
			"gazetteer-lexicon": { type: "string" },
			"anchor-lookup": { type: "string" },
			conventions: { type: "string" },
			"bridge-gaps": { type: "boolean" },
		},
	})

	await externalArenas({
		outDir: cli["out-dir"],
		model: cli.model,
		tokenizer: cli.tokenizer,
		modelCard: cli["model-card"],
		gazetteerLexicon: cli["gazetteer-lexicon"],
		anchorLookup: cli["anchor-lookup"],
		conventions: cli.conventions ? parseAddressSystemConventions(cli.conventions) : "off",
		bridgePunctuationGaps: cli["bridge-gaps"] ? "on" : "off",
	})
}

runIfScript(import.meta, main)
