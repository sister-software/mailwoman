/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Generates an adversarial corpus through the DeepSeek API. Each request is billed.
 *
 *   Usage:
 *     node packages/corpus/lib/tools/deepseek.run.ts --mode kryptonite --out-dir out/ --target-count 8000
 *     node packages/corpus/lib/tools/deepseek.run.ts --mode transliteration --out-dir out/ \
 *       --seed-paths seeds-us.jsonl --seed-paths seeds-fr.jsonl [--scripts cyrl --scripts hang] [--limit N]
 *
 *   Other flags: `--model`, `--batch-size 50`, `--concurrency 15`, `--max-tokens 20000` and
 *   `--unshippable-reason <why>`. A run restarted with the same arguments skips the batches its checkpoint holds.
 *   `DEEPSEEK_API_KEY` is read from the private environment after the sources are admitted.
 */

import { parseArguments, requiredArgument } from "@mailwoman/core/scripting/arguments"
import { resolvePath } from "path-ts"

import { DEEPSEEK_DEFAULT_MODEL, DeepSeekClient, requireDeepSeekAPIKey } from "#recipes/deepseek/client"
import { DeepSeekMode, runDeepSeekGeneration } from "#recipes/deepseek/generate"
import { openSourceRightsAdmission } from "#source-register/corpus-inputs"

const { values } = parseArguments({
	options: {
		mode: { type: "string" },
		"out-dir": { type: "string" },
		model: { type: "string", default: DEEPSEEK_DEFAULT_MODEL },
		"batch-size": { type: "string", default: "50" },
		concurrency: { type: "string", default: "15" },
		"max-tokens": { type: "string", default: "20000" },
		"seed-paths": { type: "string", multiple: true, default: [] },
		scripts: { type: "string", multiple: true, default: [] },
		"target-count": { type: "string", default: "8000" },
		limit: { type: "string", default: "0" },
		"unshippable-reason": { type: "string" },
	},
})

function integer(flag: string, text: string, least: number): number {
	const value = Number(text)

	if (!Number.isSafeInteger(value) || value < least)
		throw new Error(`--${flag} must be an integer of at least ${least}, got ${text}`)

	return value
}

const mode = requiredArgument("deepseek", "--mode", values.mode)
const modes: readonly string[] = Object.values(DeepSeekMode)

if (!modes.includes(mode)) throw new Error(`--mode must be one of ${modes.join(", ")}, got ${mode}`)

await runDeepSeekGeneration(
	{
		mode: mode as DeepSeekMode,
		outDir: resolvePath(requiredArgument("deepseek", "--out-dir", values["out-dir"])).toString(),
		model: values.model,
		batchSize: integer("batch-size", values["batch-size"], 1),
		concurrency: integer("concurrency", values.concurrency, 1),
		maxTokens: integer("max-tokens", values["max-tokens"], 1),
		seedPaths: values["seed-paths"],
		scripts: values.scripts.length ? values.scripts : null,
		targetCount: integer("target-count", values["target-count"], 0),
		limit: integer("limit", values.limit, 0),
	},
	{
		openAdmission: (context) =>
			openSourceRightsAdmission({ context, unshippableReason: values["unshippable-reason"] ?? null }),
		readAPIKey: requireDeepSeekAPIKey,
		createClient: (apiKey) => new DeepSeekClient({ apiKey }),
	}
)
