/**
 * @copyright Sister Software
 * @license AGPL-3.0
 *
 *   Multi-region interp-radius conformal sweep (#374/C). For each state: synthesize a
 *   situs-ground-truth holdout, run conformal-calibrate.ts INTERP-ONLY (situs no-op'd via an empty
 *   tableless DB → the #568 guard), and print the per-state Q̂ + coverage. The situs (OA/NAD) vs
 *   interp (TIGER) provenance split makes this non-circular for any state. See
 *   docs/articles/evals/2026-06-14-interp-multiregion-recalibration.md.
 *
 *   Usage: node scripts/eval/run-conformal-multistate.ts [STATE_SLUGS...] (default: mi ny ca mt)
 */

import { parseArgs } from "node:util"

import { dataRootPath } from "@mailwoman/core/utils"
import { runIfScript } from "mailwoman/sdk/scripting"
import { $ } from "zx"

async function main() {
	const EMPTY = "/tmp/empty-situs.db"
	// The bash for-loop was unquoted (`for slug in ${STATES[@]}`), so a single space-joined arg splits too.
	const parsed = parseArgs({ options: { n: { type: "string" } }, allowPositionals: true, strict: false })
	const N = (parsed.values.n as string | undefined) ?? "2000"
	const args = parsed.positionals.flatMap((a) => a.split(/\s+/)).filter(Boolean)
	const STATES = args.length ? args : ["mi", "ny", "ca", "mt"]

	$.verbose = false

	// Empty tableless situs DB so the situs tier is a no-op (interp-only). readOnly can't create it, so make it here.
	await $`node -e ${`const {DatabaseSync}=require('node:sqlite'); const d=new DatabaseSync(${JSON.stringify(EMPTY)}); d.exec('CREATE TABLE IF NOT EXISTS _placeholder (x)'); d.close();`}`

	for (const slug of STATES) {
		const reg = slug.toUpperCase()
		console.log(`######## ${reg} ########`)
		// >/dev/null dropped stdout; stderr went to the terminal — forward it.
		const built =
			await $`node --experimental-strip-types scripts/eval/build-situs-holdout.ts --shard ${dataRootPath("address-points", `address-points-us-${slug}.db`)} --region ${reg} --n ${N}`

		if (built.stderr) {
			process.stderr.write(built.stderr)
		}

		const r =
			await $`node --experimental-strip-types scripts/eval/conformal-calibrate.ts --holdout ${`/tmp/${slug}-situs-holdout.jsonl`} --address-points ${EMPTY} --interpolation ${dataRootPath("interpolation", `interpolation-us-${slug}.db`)}`
		console.log(
			r.stdout
				.split("\n")
				.filter((l) =>
					/resolved :|combined conformal threshold|empirical coverage on test|uncalibrated coverage|interpolated /.test(
						l
					)
				)
				.join("\n")
		)
		console.log("")
	}
}

runIfScript(main)
