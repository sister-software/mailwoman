// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Prints a config's `data.source_emit_factors` block, read from an epoch-mixture audit of that config.
 *
 *   The audit's emitted level runs the stream through the emit step.
 *   The emit step's augmented copies make a source emit more or fewer rows per draw than the run's mean.
 *
 *   The audit's `distortion_vs_draw_share` per source is that ratio.
 *
 *   A `source_reps` target counts emitted rows, so the sampler divides it by the factor
 *   (`derive_source_weights` in `mtf-sampler/src/source_reps.rs`).
 *   Paste the block under `data:` and audit the config again: a factor read with
 *   one set of weights moves a little once they change.
 *
 *   A source the audit's epoch emitted fewer than `--min-emitted` rows of
 *   (default 2,000) gets no factor and reads 1.
 *   Its factor is mostly the epoch's sampling noise: at 2,000 rows a ratio's
 *   relative standard error is about 2%.
 *
 *   Usage:
 *     node packages/mailwoman/tools/training/draw/emit-factors.run.ts --config <yaml> --audit <epoch-mixture .json> \
 *       [--min-emitted 2000]
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { loadTrainingConfig } from "../config.ts"

const { values } = parseArguments({
	options: {
		config: { type: "string" },
		audit: { type: "string" },
		"min-emitted": { type: "string", default: "2000" },
	},
})

if (!values.config || !values.audit) {
	throw new Error("--config and --audit are required")
}

const config = await loadTrainingConfig(values.config)

const audit = await readLocalJSONFile<{
	emitted_level: { per_source: Record<string, { emitted: number; distortion_vs_draw_share: number | null }> }
}>(values.audit)

const minEmitted = Number(values["min-emitted"])
const lines = ["  source_emit_factors:"]
const below: string[] = []

for (const source of Object.keys(config.data.source_reps ?? {}).toSorted()) {
	const entry = audit.emitted_level.per_source[source]

	if (!entry) {
		throw new Error(`${values.audit} reports no emitted level for ${source}`)
	}

	const factor = entry.distortion_vs_draw_share

	if (entry.emitted < minEmitted) {
		below.push(`${source} (${entry.emitted})`)

		continue
	}

	if (factor == null || factor <= 0) {
		throw new Error(`${values.audit} reports no emit factor for ${source}`)
	}

	lines.push(`    ${source}: ${factor.toFixed(4)}`)
}

console.log(lines.join("\n"))
console.error(`${below.length} sources below ${minEmitted} emitted rows read 1: ${below.join(", ")}`)
