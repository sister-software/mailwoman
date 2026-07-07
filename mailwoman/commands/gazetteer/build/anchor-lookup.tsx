/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build anchor-lookup` — the postcode→anchor JSON lookup (#239/#240; LIVE
 *   consumer: `@mailwoman/neural`'s scorer + the eval harnesses). JSON artifact, write-once semantics
 *   (regenerate, don't edit).
 */

import { Text } from "ink"
import { useEffect, useState } from "react"
import zod from "zod"

import type { CommandComponent } from "../../../sdk/cli.js"

const OptionsSchema = zod.object({
	output: zod.string().describe("Output JSON path (e.g. pilot-anchor-lookup.json)"),
	zcta: zod.string().optional().describe("Census ZCTA Gazetteer file for the US placeholder fill"),
})

export { OptionsSchema as options }

const GazetteerBuildAnchorLookup: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const [error, setError] = useState<string>()
	const [done, setDone] = useState<string>()

	useEffect(() => {
		void (async () => {
			try {
				const { buildAnchorLookup } = await import("../../../gazetteer-pipeline/anchor-lookup.js")
				buildAnchorLookup({ output: options.output, zcta: options.zcta })
				setDone(`anchor lookup → ${options.output}`)
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e))
			}
		})()
	}, [options])

	useEffect(() => {
		if (done || error) {
			setImmediate(() => process.exit(error ? 1 : 0))
		}
	}, [done, error])

	if (error) return <Text color="red">✗ {error}</Text>

	if (done) return <Text color="green">✓ {done}</Text>

	return null
}

export default GazetteerBuildAnchorLookup
