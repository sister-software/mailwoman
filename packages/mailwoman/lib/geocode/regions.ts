// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The street-tier databases of one first-level subdivision of a country,
 *   and the provider that opens them.
 *
 *   A region is keyed by its ISO 3166-2 code, such as `US-TX`.
 *   The provider learns which regions have a file from its sources
 *   and holds no list of countries of its own.
 *
 *   The address layer's manifests are the source for every country that has one.
 */

import { matchSubdivision, matchSubdivisionIn } from "@mailwoman/codex/country/subdivision"
import type { AddressTree } from "@mailwoman/core/decoder"
import { walkNodes } from "@mailwoman/core/decoder"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import type {
	AddressPointLookup,
	InterpolationLookup,
	RegionDatabaseProvider,
	RegionDatabases,
	RegionLayerDatabase,
} from "@mailwoman/core/resolver"
import type { AddressLayerCountryManifest } from "@mailwoman/resolver-wof-sqlite/address/keys/layout"
import type { StreetLocale } from "@mailwoman/resolver-wof-sqlite/street/normalize"
import { resolvePath, type PathBuilderLike } from "path-ts"

import type { LayerCatalog } from "#data/catalog"
import { usStateFileSources } from "#geocode/us/state-files"

/**
 * Returns the databases of one region, by its ISO 3166-2 code such as `US-TX`.
 * A `null` code yields a bundle with zero members.
 */
export type RegionDatabaseResolver = (subdivision: string | null) => RegionDatabases

/**
 * Returns the ISO 3166-2 code, such as `US-MI`, of the region a parsed or resolved tree states, or null.
 *
 * The region's value is read first and its resolved name second, as a code (`MI`) or a name (`Michigan`).
 * A tree the resolver placed in a country is read against only that country's subdivisions,
 * so Italy's `MI` and Spain's `CA` answer null in place of a United States state.
 *
 * A tree with no resolved country is read against every subdivision table the codex holds.
 *
 * A null answer leaves the per-region address-point and interpolation tiers out of the query.
 */
export function regionSubdivisionOfTree(tree: AddressTree): string | null {
	let regionValue: string | null = null
	let regionResolverName: string | null = null
	let resolvedCountry: string | null = null

	for (const node of walkNodes(tree.roots)) {
		if (node.tag === "region" && !regionValue) {
			regionValue = node.value.trim() || null
			regionResolverName = (node.metadata?.["resolver_name"] as string | null) ?? null
		}

		if (!resolvedCountry) {
			const stamped = (node.metadata?.["resolver_country"] as string | null)?.trim()

			if (stamped) {
				resolvedCountry = stamped.toUpperCase()
			}
		}
	}

	for (const candidate of [regionValue, regionResolverName]) {
		if (!candidate) continue

		const token = candidate.trim()
		const match = resolvedCountry ? matchSubdivisionIn(resolvedCountry, token) : matchSubdivision(token)

		if (match) return `${match.country}-${match.code}`

		// A two-letter value is a code, and a code no table holds is the tree's answer.
		// The resolved name is read only for a value that isn't a code.
		if (/^[A-Za-z]{2}$/.test(token)) return null
	}

	return null
}

/**
 * One region's file for one tier, and how to open it.
 */
export interface RegionFile<Lookup> {
	path: string

	/**
	 * Opens the file.
	 *
	 * @throws When the file can't be read.
	 * A provider never turns that failure into an absent region.
	 */
	open(): Lookup & Disposable
}

/**
 * Where a provider finds the files of one tier.
 *
 * `locate` answers one file for each ISO 3166-2 code the source holds, in upper case.
 * A whole-country file is keyed by the country's ISO 3166-1 code.
 *
 * A source with zero files for a country answers zero entries for it.
 * Zero entries state that the source has no data there.
 * A source that finds a listing it can't read throws.
 */
export type RegionFileSource =
	| { tier: "addressPoints"; locate(): Promise<ReadonlyMap<string, RegionFile<AddressPointLookup>>> }
	| { tier: "interpolation"; locate(): Promise<ReadonlyMap<string, RegionFile<InterpolationLookup>>> }

/**
 * What the address layer's source needs from `@mailwoman/resolver-wof-sqlite`.
 */
export interface AddressLayerFactory {
	/**
	 * Opens one region's address-layer `lookup.db`.
	 */
	openAddressLayerLookup: (lookupPath: string, country: string) => AddressPointLookup & Disposable
	readLatestAddressLayerManifests: (root: string) => Promise<AddressLayerCountryManifest[]>
}

/**
 * The lookup classes and readers that {@link createRegionDatabaseProvider} needs
 * from `@mailwoman/resolver-wof-sqlite`.
 *
 * A factory without the two address-layer members reads only the older per-state files.
 */
export interface RegionDatabaseFactory extends Partial<AddressLayerFactory> {
	AddressPointSqliteLookup: new (
		dbPath: string,
		opts: { streetLocale: StreetLocale }
	) => AddressPointLookup & Disposable
	StreetInterpolator: new (opts: { dbPath: string }) => InterpolationLookup & Disposable
}

/**
 * The address points of every region that an address-layer manifest under `<dataRoot>/db` lists.
 *
 * A country with no manifest contributes zero regions, and so does a data root with no address layer.
 * A region whose manifest lists a `lookup.db` that isn't on disk is kept, and opening it throws,
 * so a missing file reads as a failed read and never as a region without data.
 *
 * @throws From `locate`, when a manifest exists and can't be read.
 */
export function addressLayerSource(factory: AddressLayerFactory, dataRoot: PathBuilderLike): RegionFileSource {
	return {
		tier: "addressPoints",
		async locate() {
			const layerRoot = resolvePath(dataRoot, "db")
			const files = new Map<string, RegionFile<AddressPointLookup>>()

			for (const manifest of await factory.readLatestAddressLayerManifests(layerRoot)) {
				for (const region of manifest.regions) {
					const path = resolvePath(layerRoot, region.lookup.path)
					const present = await pathExists(path)

					files.set((region.subdivision ?? manifest.country).toUpperCase(), {
						path,
						open: () => {
							if (!present) {
								throw new Error(
									`The address layer of ${manifest.country} at version ${manifest.version} lists ${path} for ${region.region}, and the file doesn't exist.`
								)
							}

							return factory.openAddressLayerLookup(path, manifest.country)
						},
					})
				}
			}

			return files
		},
	}
}

interface OpenRegion extends RegionDatabases {
	handles: Disposable[]
}

/**
 * Opens and caches the address-point and interpolation lookups of each region,
 * so a region's files open once.
 *
 * For each tier the first source that lists a region supplies its file,
 * so the order of the sources is their precedence.
 * `for` is synchronous, so {@linkcode warm} asks every source for its files up front.
 *
 * Construct instances with {@linkcode SubdivisionDatabaseProvider.create}, which warms before it returns.
 *
 * `for` answers a bundle with zero members for a region no source lists, and for a null code.
 * It throws when a listed file can't be opened.
 *
 * A geocode session builds one for each data generation, and disposal closes every cached handle.
 */
export class SubdivisionDatabaseProvider implements RegionDatabaseProvider<string, RegionDatabases> {
	readonly #sources: readonly RegionFileSource[]
	readonly #addressPoints = new Map<string, RegionFile<AddressPointLookup>>()
	readonly #interpolation = new Map<string, RegionFile<InterpolationLookup>>()
	readonly #cache = new Map<string, OpenRegion>()

	private constructor(sources: readonly RegionFileSource[]) {
		this.#sources = sources
	}

	/**
	 * Constructs a provider over `sources`, in their order of precedence, and warms it.
	 */
	static async create(sources: readonly RegionFileSource[]): Promise<SubdivisionDatabaseProvider> {
		const provider = new SubdivisionDatabaseProvider(sources)

		await provider.warm()

		return provider
	}

	/**
	 * Asks every source for its files.
	 * Each call replaces what the earlier one found.
	 */
	async warm(): Promise<void> {
		this.#addressPoints.clear()
		this.#interpolation.clear()

		for (const source of this.#sources) {
			if (source.tier === "addressPoints") {
				keepFirst(this.#addressPoints, await source.locate())
			} else {
				keepFirst(this.#interpolation, await source.locate())
			}
		}
	}

	/**
	 * The ISO 3166-2 codes, and the ISO 3166-1 codes of whole-country files, that a source lists a file for.
	 */
	regions(): string[] {
		return [...new Set([...this.#addressPoints.keys(), ...this.#interpolation.keys()])].toSorted()
	}

	/**
	 * The files `for(subdivision)` reads.
	 *
	 * The files record no source this package can locate, so each file's location table is empty.
	 */
	readonly layerDatabases = (subdivision: string): RegionLayerDatabase[] => {
		const key = subdivision.toUpperCase()
		const addressPoints = this.#addressPoints.get(key)
		const interpolation = this.#interpolation.get(key)

		return [
			...(addressPoints ? [{ tier: "addressPoints" as const, path: addressPoints.path, sourceLocations: {} }] : []),
			...(interpolation ? [{ tier: "interpolation" as const, path: interpolation.path, sourceLocations: {} }] : []),
		]
	}

	readonly for: RegionDatabaseResolver = (subdivision) => {
		if (!subdivision) return {}

		const key = subdivision.toUpperCase()
		let entry = this.#cache.get(key)

		if (!entry) {
			const addressPoints = this.#addressPoints.get(key)?.open() ?? null
			const interpolation = this.#interpolation.get(key)?.open() ?? null

			entry = {
				addressPoints,
				interpolation,
				handles: [addressPoints, interpolation].filter((handle) => handle != null),
			}

			this.#cache.set(key, entry)
		}

		return { addressPoints: entry.addressPoints, interpolation: entry.interpolation }
	};

	[Symbol.dispose](): void {
		for (const entry of this.#cache.values()) {
			for (const handle of entry.handles) {
				handle[Symbol.dispose]()
			}
		}

		this.#cache.clear()
	}
}

function keepFirst<Lookup>(
	files: Map<string, RegionFile<Lookup>>,
	located: ReadonlyMap<string, RegionFile<Lookup>>
): void {
	for (const [key, file] of located) {
		if (!files.has(key.toUpperCase())) {
			files.set(key.toUpperCase(), file)
		}
	}
}

/**
 * Builds the region provider a geocode reads: the address layer of every country that
 * has a manifest, then the older per-state files of the United States.
 *
 * A region the address layer lists reads its address points there, and any other
 * region reads the older per-state file when one exists.
 * Interpolation has no manifest, so every region reads the older per-state file.
 *
 * @param catalog The snapshot a session already read, so the provider resolves
 * from the session's generation.
 * Absent, the older per-state files are resolved from the active selection.
 */
export async function createRegionDatabaseProvider(
	factory: RegionDatabaseFactory,
	dataRoot: PathBuilderLike,
	catalog?: LayerCatalog
): Promise<SubdivisionDatabaseProvider> {
	const { openAddressLayerLookup, readLatestAddressLayerManifests } = factory

	return SubdivisionDatabaseProvider.create([
		...(openAddressLayerLookup && readLatestAddressLayerManifests
			? [addressLayerSource({ openAddressLayerLookup, readLatestAddressLayerManifests }, dataRoot)]
			: []),
		...usStateFileSources(factory, dataRoot, catalog),
	])
}
