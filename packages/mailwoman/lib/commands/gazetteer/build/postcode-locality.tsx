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

import {
	CommandError,
	type CommandSpec,
	CommandTaskResult,
	type ParsedCommandComponent,
	useCommandTask,
} from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "postcode-locality",
	description: "Build a postcode-to-locality table.",
	options: {
		recipe: { type: "string", required: true, choices: ["base", "jp", "kr", "tw"], description: "Build recipe" },
		output: { type: "string", required: true, description: "Output database" },
		country: { type: "string", description: "ISO-2 country" },
		"admin-repo": { type: "string", description: "WOF admin repo" },
		"postcode-db": { type: "string", description: "Postcode shard" },
		"radius-km": { type: "number", description: "Candidate radius km" },
		"max-candidates": { type: "number", description: "Candidates per postcode" },
		finalize: { type: "boolean", default: false, description: "Freeze the table" },
		"postal-names": { type: "string", description: "KEN_ALL.CSV" },
		geonames: { type: "string", description: "GeoNames dump" },
		"admin-db": { type: "string", description: "Admin database" },
		"postal-xml": { type: "string", description: "Postal districts XML" },
		divisions: { type: "string", description: "Overture divisions" },
	},
} as const satisfies CommandSpec

interface Options {
	recipe: "base" | "jp" | "kr" | "tw"
	output: string
	country?: string
	adminRepo?: string
	postcodeDB?: string
	radiusKM?: number
	maxCandidates?: number
	finalize: boolean
	postalNames?: string
	geonames?: string
	adminDB?: string
	postalXML?: string
	divisions?: string
}

const GazetteerBuildPostcodeLocality: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const need = (name: string, v: string | undefined): string => {
			if (!v) throw new CommandError(`--${name} is required for --recipe ${options.recipe}`)

			return v
		}

		switch (options.recipe) {
			case "base": {
				const { buildPostcodeLocalityBase, finalizePostcodeLocality } =
					await import("#gazetteer/postcode-locality/base")

				if (options.finalize) {
					await finalizePostcodeLocality(options.output)

					break
				}

				await buildPostcodeLocalityBase({
					country: need("country", options.country),
					adminRepo: need("admin-repo", options.adminRepo),
					postcodeDB: need("postcode-db", options.postcodeDB),
					output: options.output,
					radiusKM: options.radiusKM ?? 10,
					maxCandidates: options.maxCandidates ?? 4,
					finalize: false,
				})

				break
			}
			case "jp": {
				const { buildPostcodeLocalityJP } = await import("#gazetteer/postcode-locality/jp")

				await buildPostcodeLocalityJP({
					country: options.country ?? "JP",
					postalNames: need("postal-names", options.postalNames),
					geonames: need("geonames", options.geonames),
					adminDB: need("admin-db", options.adminDB),
					output: options.output,
				})

				break
			}
			case "kr": {
				const { buildPostcodeLocalityKR } = await import("#gazetteer/postcode-locality/kr")

				await buildPostcodeLocalityKR({
					geonames: need("geonames", options.geonames),
					adminDB: need("admin-db", options.adminDB),
					output: options.output,
				})

				break
			}
			case "tw": {
				const { buildPostcodeLocalityTW } = await import("#gazetteer/postcode-locality/tw")

				await buildPostcodeLocalityTW({
					postalXML: need("postal-xml", options.postalXML),
					divisions: need("divisions", options.divisions),
					adminDB: need("admin-db", options.adminDB),
					output: options.output,
				})

				break
			}
		}

		return `postcode-locality (${options.recipe}): ${options.output} — sealed 0444`
	})

	return <CommandTaskResult state={state} />
}

export default GazetteerBuildPostcodeLocality
