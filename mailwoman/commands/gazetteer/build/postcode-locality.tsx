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

import { Text } from "ink"
import zod from "zod"

import { commandError, type CommandComponent, useCommandTask } from "../../../cli-kit/index.ts"

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
	const state = useCommandTask(async () => {
		const need = (name: string, v: string | undefined): string => {
			if (!v) throw commandError(`--${name} is required for --recipe ${options.recipe}`)

			return v
		}

		switch (options.recipe) {
			case "base": {
				const { buildPostcodeLocalityBase, finalizePostcodeLocality } =
					await import("../../../gazetteer-pipeline/postcode-locality/base.ts")

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
				const { buildPostcodeLocalityJP } = await import("../../../gazetteer-pipeline/postcode-locality/jp.ts")
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
				const { buildPostcodeLocalityKR } = await import("../../../gazetteer-pipeline/postcode-locality/kr.ts")
				await buildPostcodeLocalityKR({
					geonames: need("geonames", options.geonames),
					adminDb: need("admin-db", options.adminDb),
					output: options.output,
				})
				break
			}
			case "tw": {
				const { buildPostcodeLocalityTW } = await import("../../../gazetteer-pipeline/postcode-locality/tw.ts")
				await buildPostcodeLocalityTW({
					postalXml: need("postal-xml", options.postalXml),
					divisions: need("divisions", options.divisions),
					adminDb: need("admin-db", options.adminDb),
					output: options.output,
				})
				break
			}
		}

		return `postcode-locality (${options.recipe}): ${options.output} — sealed 0444`
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") return <Text color="green">✓ {state.result}</Text>

	return null // progress streams to stderr until the summary lands
}

export default GazetteerBuildPostcodeLocality
