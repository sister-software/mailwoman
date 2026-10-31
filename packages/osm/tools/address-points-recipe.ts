/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `osm-address-points` build recipe: one address-point database per requested country, derived from
 *   a Geofabrik extract. `mailwoman data build osm-address-points --countries <cc>` runs it through the
 *   installer. The installer acquires the inputs, validates each output and activates it.
 *
 *   Countries that share a region read one acquired extract. A country derived from a region that holds
 *   other countries is clipped to its outline, and the outline's digest is recorded in that country's
 *   derivation. A country derived from its own extract is not clipped, as the command-line builder has never
 *   clipped one.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import {
	ArtifactFormat,
	type ArtifactSourceInput,
	type BuildInput,
	type BuildOutput,
	type BuildPlan,
	type BuildPrerequisite,
	type BuildRecipe,
	BuildRecipeName,
	type BuildRequest,
	type BuiltArtifact,
	ServingRole,
} from "@mailwoman/core/layers"
import { runFile } from "@mailwoman/core/process"
import { STREET_KEY_NORMALIZATION } from "@mailwoman/resolver-wof-sqlite/street/normalize"
import type { ParsedGeometry } from "@mailwoman/spatial"
import { resolvePath } from "path-ts"

import {
	ADDRESS_POINT_FILTER,
	extractionPolicyCountries,
	extractionPolicyFor,
	extractionPolicyName,
	type OSMExtractionPolicy,
} from "#extraction-policy"
import { OSM_LICENSE } from "#license"
import { createOutlineContainment } from "#sdk/country-outline"
import { geofabrikExtractURL, type GeofabrikRegion, geofabrikRegions } from "#sdk/geofabrik/regions"
import { streetLocaleForCountry, supportedOSMCountries } from "#street-locale"
import { buildRooftopDatabase } from "#tools/rooftop-database"

/**
 * The base URL of the geoBoundaries API.
 * Its per-country metadata lists each outline's download URL.
 */
export const GEOBOUNDARIES_BASE_URL = "https://www.geoboundaries.org/"

/**
 * Where the recipe's inputs are downloaded from, and which regions it may acquire.
 *
 * A test serves both hosts from a local registry.
 */
export interface OSMRecipeOptions {
	geofabrikBaseURL?: string
	geoBoundariesBaseURL?: string
	/**
	 * The regions a request may name, such as a mirror's own region holding several countries.
	 *
	 * @defaultValue {@linkcode geofabrikRegions}
	 */
	regions?: readonly GeofabrikRegion[]
}

function regionKey(region: GeofabrikRegion): string {
	return `geofabrik:${region.id}`
}

function outlineKey(policy: OSMExtractionPolicy): string {
	return `geoboundaries:${policy.outline.iso3}`
}

/**
 * Whether a country derived from `region` is clipped: the region holds another
 * country, or holds part of this one.
 */
function clipsCountry(region: GeofabrikRegion, country: string): boolean {
	return region.countries.length > 1 || region.partial.includes(country)
}

function regionFileName(region: GeofabrikRegion): string {
	return `${region.id.split("/").at(-1)}.osm.pbf`
}

/**
 * The `osm-address-points` recipe, reading its inputs from `sources`.
 */
export function createOSMAddressPointsRecipe(recipeOptions: OSMRecipeOptions = {}): BuildRecipe {
	const geofabrik = recipeOptions.geofabrikBaseURL
	const geoBoundaries = recipeOptions.geoBoundariesBaseURL ?? GEOBOUNDARIES_BASE_URL
	const regions = new Map((recipeOptions.regions ?? geofabrikRegions()).map((region) => [region.id, region]))
	const regionOf = (id: string) => regions.get(id.replaceAll(/^\/+|\/+$/g, "")) ?? null
	const located = new Set(supportedOSMCountries().map((country) => country.toUpperCase()))
	const buildable = extractionPolicyCountries().filter((country) => located.has(country))

	const plan = (request: BuildRequest): BuildPlan => {
		const problems: string[] = []
		const inputs = new Map<string, BuildInput>()
		const outputs: BuildOutput[] = []
		const named = request.region ? regionOf(request.region) : null

		if (request.region && !named) {
			problems.push(`region ${request.region} is not a Geofabrik region this build lists`)
		}

		if (!request.countries.length) {
			problems.push("the request names no country")
		}

		for (const requested of request.countries) {
			const country = requested.toUpperCase()
			const policy = buildable.includes(country) ? extractionPolicyFor(country) : null

			if (!policy) {
				problems.push(`${country} has no OpenStreetMap extraction policy; the build supports ${buildable.join(", ")}`)

				continue
			}

			// The request's `--region` is used when it holds the country.
			// Otherwise the policy's first region is the country's own extract.
			const region = named ?? regionOf(policy.regions[0]!)

			if (!region) {
				problems.push(`${country}'s policy names region ${policy.regions[0]}, which this build does not list`)

				continue
			}

			if (!region.countries.includes(country)) {
				problems.push(
					`region ${region.id} does not hold ${country}; ${country}'s policy lists ${policy.regions.join(", ")}`
				)

				continue
			}

			inputs.set(regionKey(region), {
				key: regionKey(region),
				source: "geofabrik",
				name: region.id,
				publisher: "Geofabrik",
				url: geofabrikExtractURL(region, geofabrik),
				locate: null,
				md5Sidecar: true,
				fileName: regionFileName(region),
				license: OSM_LICENSE,
			})

			const keys = [regionKey(region)]

			if (clipsCountry(region, country)) {
				const iso3 = policy.outline.iso3

				inputs.set(outlineKey(policy), {
					key: outlineKey(policy),
					source: "geoboundaries",
					name: `${iso3}-ADM0`,
					publisher: "geoBoundaries",
					url: new URL(`api/current/gbOpen/${iso3}/ADM0/`, geoBoundaries).toString(),
					locate: { field: "gjDownloadURL" },
					md5Sidecar: false,
					fileName: `${iso3}-ADM0.geojson`,
					// geoBoundaries states a license per boundary, in the metadata the download URL is read from.
					license: "LicenseRef-geoBoundaries-per-boundary",
				})

				keys.push(outlineKey(policy))
			}

			outputs.push({
				country,
				role: ServingRole.AddressPoints,
				fileName: `address-points-${country.toLowerCase()}.db`,
				inputs: keys,
				policy: { name: extractionPolicyName(policy), version: policy.version },
				scope: { countries: [country], subdivisions: null },
			})
		}

		return {
			recipe: BuildRecipeName.OSMAddressPoints,
			request,
			inputs: [...inputs.values()],
			outputs,
			problems,
		}
	}

	return {
		name: BuildRecipeName.OSMAddressPoints,
		countries: () => buildable,
		plan,
		async prerequisites(): Promise<BuildPrerequisite[]> {
			try {
				const { stdout } = await runFile("ogr2ogr", ["--version"])

				return [{ name: "ogr2ogr", satisfied: true, detail: stdout.trim() }]
			} catch (error) {
				return [
					{
						name: "ogr2ogr",
						satisfied: false,
						detail:
							`ogr2ogr could not run (${(error as Error).message}). The OpenStreetMap build reads the extract ` +
							"with GDAL's OSM driver: install GDAL (the gdal-bin package on Debian and Ubuntu, `brew install gdal` on macOS).",
					},
				]
			}
		},
		async build(buildPlan, acquired, options) {
			const built: BuiltArtifact[] = []

			for (const output of buildPlan.outputs) {
				options.signal?.throwIfAborted()

				const [dataKey, clipKey] = output.inputs
				const data = acquired.get(dataKey!)

				if (!data) throw new Error(`${output.country}: input ${dataKey} was not acquired`)

				const clip = clipKey ? acquired.get(clipKey) : null

				if (clipKey && !clip) throw new Error(`${output.country}: outline ${clipKey} was not acquired`)

				let within: ((lon: number, lat: number) => boolean) | undefined

				if (clip) {
					const outline = await readLocalJSONFile<{ features?: Array<{ geometry: ParsedGeometry }> }>(clip.path)
					const geometry = outline.features?.[0]?.geometry

					if (!geometry) throw new Error(`${clip.path} holds no outline feature`)

					within = createOutlineContainment(geometry)
				}

				const country = output.country.toLowerCase()
				const path = resolvePath(options.directory, output.fileName)

				options.onProgress?.(
					`building ${output.country} from ${data.input.name}${clip ? `, clipped to ${clip.input.name}` : ""}`
				)

				const counts = await buildRooftopDatabase({
					country,
					slug: country,
					pbf: data.path,
					release: data.release ?? "unknown",
					createdAt: options.createdAt,
					buildSHA: options.builderSHA,
					buildCmd: `mailwoman data build ${BuildRecipeName.OSMAddressPoints} --countries ${output.country}`,
					output: path,
					provenance: { sourceURL: data.url, sourceSHA256: data.sha256, snapshotDate: data.release },
					recover: false,
					recoverRadiusKm: 0,
					...(within ? { within } : {}),
					...(options.signal ? { signal: options.signal } : {}),
					...(options.onProgress ? { log: options.onProgress } : {}),
				})

				const sourceOf = (input: typeof data): ArtifactSourceInput => ({
					publisher: input.input.publisher,
					release: input.release,
					url: input.url,
					sha256: input.sha256,
					md5: input.md5,
				})

				built.push({
					output,
					path,
					manifest: {
						role: ServingRole.AddressPoints,
						format: ArtifactFormat.SQLite,
						schemaVersion: 1,
						normalization: { ...STREET_KEY_NORMALIZATION, locale: streetLocaleForCountry(country) },
						scope: output.scope,
						observedCountries: counts.written ? [output.country] : [],
						// The spine schema writes no per-cell coverage table, so a miss supports no negative answer.
						coverageEvidence: false,
						sources: clip ? [sourceOf(data), sourceOf(clip)] : [sourceOf(data)],
						recipe: BuildRecipeName.OSMAddressPoints,
						builderSHA: options.builderSHA,
						license: OSM_LICENSE,
						derivation: {
							policy: output.policy,
							clipping: clip
								? { description: `geoBoundaries gbOpen ADM0 ${clip.input.name.split("-")[0]}`, sha256: clip.sha256 }
								: null,
							filter: ADDRESS_POINT_FILTER,
							counts: { ...counts },
						},
					},
				})
			}

			return built
		},
	}
}
