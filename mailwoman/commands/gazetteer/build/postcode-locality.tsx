/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build postcode-locality --recipe base|jp|kr|tw` — the postcode →
 *   containing-locality tables (Direction E / #274/#292/#293/#473), ported from the four standalone
 *   builders. Per-recipe options:
 *
 *   - `base` — PIP-containment from a WOF admin repo: `--country --admin-repo --postcode-db --output`
 *     (+ `--radius-km`, `--max-candidates`); `--finalize` freezes an accumulated multi-country table.
 *   - `jp` — KEN_ALL authoritative name-match: `--country JP --postal-names --geonames --admin-db --output`.
 *   - `kr` — GeoNames point-primary match: `--geonames --admin-db --output`.
 *   - `tw` — postal XML + polygon bridge: `--postal-xml --divisions --admin-db --output`.
 *
 *   Every recipe seals its artifact 0444. The pipeline modules are lazy-imported so `--help` never
 *   faults without the optional `@mailwoman/resolver-wof-sqlite` peer.
 */

import { Box, Text } from "ink"
import { useEffect, useState } from "react"
import zod from "zod"

import type { CommandComponent } from "../../../sdk/cli.js"

const OptionsSchema = zod.object({
	recipe: zod.enum(["base", "jp", "kr", "tw"]).describe("Which postcode-locality table to build"),
	output: zod.string().describe("Output DB path (sealed 0444)"),
	country: zod.string().optional().describe("base/jp: ISO-2 country"),
	adminRepo: zod.string().optional().describe("base: WOF admin repo dir"),
	postcodeDb: zod.string().optional().describe("base: postcode shard DB"),
	radiusKm: zod.string().optional().describe("base: candidate radius km (default 10)"),
	maxCandidates: zod.string().optional().describe("base: max candidates per postcode (default 4)"),
	finalize: zod.boolean().default(false).describe("base: freeze an accumulated multi-country table"),
	postalNames: zod.string().optional().describe("jp: KEN_ALL.CSV path"),
	geonames: zod.string().optional().describe("jp/kr: GeoNames dump path"),
	adminDb: zod.string().optional().describe("jp/kr/tw: admin gazetteer DB"),
	postalXml: zod.string().optional().describe("tw: postal districts XML"),
	divisions: zod.string().optional().describe("tw: Overture divisions parquet/dir"),
})

export { OptionsSchema as options }

const GazetteerBuildPostcodeLocality: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const [error, setError] = useState<string>()
	const [done, setDone] = useState<string>()

	useEffect(() => {
		void (async () => {
			try {
				const need = (name: string, v: string | undefined): string => {
					if (!v) throw new Error(`--${name} is required for --recipe ${options.recipe}`)

					return v
				}

				switch (options.recipe) {
					case "base": {
						const { buildPostcodeLocalityBase, finalizePostcodeLocality } =
							await import("../../../gazetteer-pipeline/postcode-locality/base.js")

						if (options.finalize) {
							await finalizePostcodeLocality(options.output)
							break
						}
						await buildPostcodeLocalityBase({
							country: need("country", options.country),
							adminRepo: need("admin-repo", options.adminRepo),
							postcodeDB: need("postcode-db", options.postcodeDb),
							output: options.output,
							radiusKm: Number(options.radiusKm ?? "10.0"),
							maxCandidates: Number.parseInt(options.maxCandidates ?? "4", 10),
							finalize: false,
						})
						break
					}
					case "jp": {
						const { buildPostcodeLocalityJP } = await import("../../../gazetteer-pipeline/postcode-locality/jp.js")
						await buildPostcodeLocalityJP({
							country: options.country ?? "JP",
							postalNames: need("postal-names", options.postalNames),
							geonames: need("geonames", options.geonames),
							adminDb: need("admin-db", options.adminDb),
							output: options.output,
						})
						break
					}
					case "kr": {
						const { buildPostcodeLocalityKR } = await import("../../../gazetteer-pipeline/postcode-locality/kr.js")
						await buildPostcodeLocalityKR({
							geonames: need("geonames", options.geonames),
							adminDb: need("admin-db", options.adminDb),
							output: options.output,
						})
						break
					}
					case "tw": {
						const { buildPostcodeLocalityTW } = await import("../../../gazetteer-pipeline/postcode-locality/tw.js")
						await buildPostcodeLocalityTW({
							postalXml: need("postal-xml", options.postalXml),
							divisions: need("divisions", options.divisions),
							adminDb: need("admin-db", options.adminDb),
							output: options.output,
						})
						break
					}
				}
				setDone(`postcode-locality (${options.recipe}): ${options.output} — sealed 0444`)
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e))
			}
		})()
	}, [options])

	useEffect(() => {
		if (done || error) setImmediate(() => process.exit(error ? 1 : 0))
	}, [done, error])

	if (error) return <Text color="red">✗ {error}</Text>

	if (done) return <Text color="green">✓ {done}</Text>

	return null // progress streams to stderr until the summary lands
}

export default GazetteerBuildPostcodeLocality
