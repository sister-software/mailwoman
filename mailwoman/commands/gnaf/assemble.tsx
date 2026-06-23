/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gnaf assemble --standard-dir <G-NAF/.../Standard> --out <assembled-au.jsonl>`
 *
 *   Assemble a sampled, component-labeled Australian address set from the G-NAF (Geocoded National
 *   Address File) relational PSV distribution — joining ADDRESS_DETAIL → STREET_LOCALITY → LOCALITY
 *   and reservoir-sampling across states. Streams via the house `PSVSpliterator`; memory stays bounded
 *   (the two lookup tables as Maps, the 16.9M address rows sampled in one pass).
 *
 *   The output JSONL is the input to the `gnaf` corpus adapter (`mailwoman corpus build`), which
 *   renders each tuple in multiple word orders to teach the model AU's postcode-first layout (#208).
 *   `--holdout` excludes the benchmark addresses by (street, locality, postcode) so the training shard
 *   never overlaps the eval. Open G-NAF licence — attribute "Geoscape Australia".
 */

import { assembleGnaf, type GnafAssembleResult } from "@mailwoman/corpus"
import { Box, Text } from "ink"
import { setImmediate } from "node:timers/promises"
import { useEffect, useState } from "react"
import zod from "zod"
import type { CommandComponent } from "../../sdk/cli.js"

const OptionsSchema = zod.object({
	standardDir: zod
		.string()
		.describe("G-NAF `Standard` directory holding the per-state *_psv.psv tables"),
	n: zod.coerce.number().int().positive().optional().default(150_000).describe("Sample size (reservoir; population-proportional across states)"),
	out: zod.string().describe("Output JSONL path (component tuples, consumed by the `gnaf` corpus adapter)"),
	holdout: zod
		.string()
		.optional()
		.describe("Eval JSONL whose (street,locality,postcode) are excluded so the training shard never overlaps the benchmark"),
})

export { OptionsSchema as options }

const GnafAssemble: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const [error, setError] = useState<string>()
	const [done, setDone] = useState<GnafAssembleResult>()
	const [progress, setProgress] = useState<string>()

	useEffect(() => {
		if (error) setImmediate().then(() => process.exit(1))
		else if (done) setImmediate().then(() => process.exit(0))
	}, [error, done])

	useEffect(() => {
		assembleGnaf({
			standardDir: options.standardDir,
			sampleSize: options.n,
			out: options.out,
			holdoutPath: options.holdout,
			onProgress: setProgress,
		})
			.then(setDone)
			.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
	}, [options])

	if (error) return <Text color="red">{error}</Text>

	if (done) {
		return (
			<Box flexDirection="column">
				<Text>
					<Text color="green">✓</Text> {done.written.toLocaleString()} tuples sampled (of {done.seen.toLocaleString()} valid
					{done.heldOut ? `, ${done.heldOut.toLocaleString()} held out` : ""})
				</Text>
				<Text dimColor>
					by state: {Object.entries(done.byState).map(([s, n]) => `${s}=${n}`).join(" ")}
				</Text>
			</Box>
		)
	}

	return (
		<Box flexDirection="column">
			<Text>assembling G-NAF Australian addresses…</Text>
			{progress ? <Text dimColor>{progress}</Text> : null}
		</Box>
	)
}

export default GnafAssemble
