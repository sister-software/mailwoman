/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Selects and caches the per-state address-point and interpolation databases for a parse.
 */

import { US_STATE_BY_ABBREVIATION } from "@mailwoman/codex/us"
import type { AddressTree } from "@mailwoman/core/decoder"
import { walkNodes } from "@mailwoman/core/decoder"
import { pathExists } from "@mailwoman/core/fs/readers"
import type { AddressPointLookup, InterpolationLookup, StreetCentroidLookup } from "@mailwoman/core/resolver"
import { addressPointDatabaseRoot, interpolationDatabaseRoot } from "@mailwoman/resolver-wof-sqlite/paths"
import { resolvePath, type PathBuilderLike } from "path-ts"

import { readReleaseManifest, resolveDatabasePath, type DataReleaseManifest } from "#data/release"

/**
 * The per-state databases available to one geocode resolve.
 *
 * Any of them may be absent, in which case resolution falls back to admin records.
 */
export interface RegionDatabases {
	addressPoints?: AddressPointLookup
	interpolation?: InterpolationLookup
	/**
	 * Street centroids rolled up from a national register's rooftop points,
	 * for queries without a house number.
	 *
	 * Only `BANRegionDatabaseProvider` in `@mailwoman/ban` supplies this tier, for France.
	 * The resolver consults it below the address-point and interpolation tiers and above admin.
	 */
	streetCentroids?: StreetCentroidLookup
}

/**
 * Returns the databases for a state slug such as `"tx"`.
 * A `null` slug yields no databases.
 */
export type RegionDatabaseResolver = (stateSlug: string | null) => RegionDatabases

/**
 * Maps a lowercased full US state name to its lowercase two-letter slug.
 */
export const US_STATE_SLUG_BY_NAME: ReadonlyMap<string, string> = new Map(
	Object.entries(US_STATE_BY_ABBREVIATION).map(([abbreviation, name]) => [
		name.toLowerCase(),
		abbreviation.toLowerCase(),
	])
)

/**
 * Returns the lowercase two-letter state slug for a parsed region value or resolver name, or null.
 *
 * Both abbreviations ("MI") and full names ("New York") are accepted.
 * A null result disables the per-state address-point and interpolation tiers for the query.
 */
export function regionToStateSlug(
	regionValue: string | null | undefined,
	resolverName: string | null | undefined
): string | null {
	for (const candidate of [regionValue, resolverName]) {
		if (!candidate) continue
		const trimmed = candidate.trim()

		if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toLowerCase()
		const byName = US_STATE_SLUG_BY_NAME.get(trimmed.toLowerCase())

		if (byName) return byName
	}

	return null
}

/**
 * Returns the per-state database slug, such as `"tx"`, for the region in a parsed or resolved tree.
 *
 * It returns null when the tree has no usable region or resolves to a country other than the US.
 */
export function regionSlugFromTree(tree: AddressTree): string | null {
	let regionValue: string | null = null
	let regionResolverName: string | null = null
	let resolvedCountry: string | null = null

	for (const node of walkNodes(tree.roots)) {
		if (node.tag === "region" && !regionValue) {
			regionValue = node.value.trim() || null
			regionResolverName = (node.metadata?.["resolver_name"] as string | undefined) ?? null
		}

		if (!resolvedCountry) {
			const stamped = (node.metadata?.["resolver_country"] as string | undefined)?.trim()

			if (stamped) {
				resolvedCountry = stamped.toUpperCase()
			}
		}
	}

	// `regionToStateSlug` accepts any two-letter region, so a foreign code such as Italy's `MI`
	// or Spain's `CA` would select a US state's database.
	// A resolved non-US country therefore gets no slug.
	// An unresolved country still gets one so that US addresses keep their street tiers.
	if (resolvedCountry !== null && resolvedCountry !== "US") return null

	return regionToStateSlug(regionValue, regionResolverName)
}

/**
 * Returns the per-state address-point database path under `<dataRoot>/db/address-points/`.
 *
 * It returns null when the slug is null or the file does not exist.
 */
export async function selectAddressPointsDB(dataRoot: string, stateSlug: string | null): Promise<string | null> {
	if (!stateSlug) return null
	const candidate = addressPointDatabaseRoot(dataRoot)(`address-points-us-${stateSlug}.db`)

	return (await pathExists(candidate)) ? candidate.toString() : null
}

/**
 * Returns the per-state interpolation database path under `<dataRoot>/db/interpolation/`.
 *
 * It returns null when the slug is null or the file does not exist.
 */
export async function selectInterpolationDB(dataRoot: string, stateSlug: string | null): Promise<string | null> {
	if (!stateSlug) return null
	const candidate = interpolationDatabaseRoot(dataRoot)(`interpolation-us-${stateSlug}.db`)

	return (await pathExists(candidate)) ? candidate.toString() : null
}

/**
 * The lookup classes that a {@link RegionDatabaseProvider} needs from `@mailwoman/resolver-wof-sqlite`.
 */
export interface RegionDatabaseFactory {
	AddressPointSqliteLookup: new (dbPath: string) => AddressPointLookup & Disposable
	StreetInterpolator: new (opts: { dbPath: string }) => InterpolationLookup & Disposable
}

/**
 * One cached state's open lookups and the paths they were opened from.
 */
export interface RegionDatabaseCacheEntry extends RegionDatabases {
	_ap?: Disposable
	_ip?: Disposable
	/**
	 * The resolved database path. {@link RegionDatabaseProvider.reload} compares it with the new path.
	 */
	apPath: string | null
	ipPath: string | null
}

/**
 * Opens and caches per-state address-point and interpolation lookups,
 * so each state's databases open once per batch.
 *
 * Paths resolve through the `releases.json` manifest when one exists. {@link reload} swaps
 * in a newly published version, and {@link close} releases every cached handle.
 *
 * Because `for` is synchronous, {@linkcode warm} probes every US state and territory path up front.
 * Construct instances with {@linkcode RegionDatabaseProvider.create}, which warms before returning.
 */
export class RegionDatabaseProvider implements Disposable {
	readonly #factory: RegionDatabaseFactory
	readonly #dataRoot: string
	readonly #cache = new Map<string, RegionDatabaseCacheEntry>()
	/**
	 * Handles replaced by the last `reload()`.
	 * The next `reload()` closes them.
	 */
	#retired: Disposable[] = []
	#manifest: DataReleaseManifest | null
	/**
	 * Resolved database paths per slug, filled by {@linkcode warm}.
	 */
	readonly #paths = new Map<string, { apPath: string | null; ipPath: string | null }>()

	private constructor(factory: RegionDatabaseFactory, dataRoot: string, manifest: DataReleaseManifest | null) {
		this.#factory = factory
		this.#dataRoot = dataRoot
		this.#manifest = manifest
	}

	/**
	 * Constructs a provider, reads the release manifest, and warms the path map.
	 */
	static async create(factory: RegionDatabaseFactory, dataRoot: PathBuilderLike): Promise<RegionDatabaseProvider> {
		const root = resolvePath(dataRoot)
		const provider = new RegionDatabaseProvider(factory, root, await readReleaseManifest(root))

		await provider.warm()

		return provider
	}

	/**
	 * Resolves the address-point and interpolation paths for every US state and territory slug.
	 *
	 * Each call replaces the path map. {@linkcode reload} calls it to re-read the disk.
	 */
	async warm(): Promise<void> {
		this.#paths.clear()

		for (const abbreviation of Object.keys(US_STATE_BY_ABBREVIATION)) {
			const slug = abbreviation.toLowerCase()

			const [apPath, ipPath] = await Promise.all([
				resolveDatabasePath(this.#dataRoot, "address-points", slug, this.#manifest),
				resolveDatabasePath(this.#dataRoot, "interpolation", slug, this.#manifest),
			])

			this.#paths.set(slug, { apPath, ipPath })
		}
	}

	#open(stateSlug: string): RegionDatabaseCacheEntry {
		const { apPath, ipPath } = this.#paths.get(stateSlug.toLowerCase()) ?? { apPath: null, ipPath: null }
		const ap = apPath ? new this.#factory.AddressPointSqliteLookup(apPath) : undefined
		const ip = ipPath ? new this.#factory.StreetInterpolator({ dbPath: ipPath }) : undefined

		return { addressPoints: ap, interpolation: ip, _ap: ap, _ip: ip, apPath, ipPath }
	}

	readonly for: RegionDatabaseResolver = (stateSlug) => {
		if (!stateSlug) return {}
		let entry = this.#cache.get(stateSlug)

		if (!entry) {
			entry = this.#open(stateSlug)
			this.#cache.set(stateSlug, entry)
		}

		return { addressPoints: entry.addressPoints, interpolation: entry.interpolation }
	}

	/**
	 * Returns a copy of the release manifest, or null when the data root has none.
	 */
	versions(): DataReleaseManifest | null {
		return this.#manifest ? { ...this.#manifest } : null
	}

	/**
	 * Re-reads the manifest and database paths, and reopens any cached state whose path changed.
	 *
	 * The replaced handles stay open until the next reload.
	 * Lookups are synchronous, so no query still holds one by then.
	 * The method returns the new manifest.
	 */
	async reload(): Promise<DataReleaseManifest | null> {
		for (const h of this.#retired) {
			h[Symbol.dispose]()
		}

		this.#retired = []
		this.#manifest = await readReleaseManifest(this.#dataRoot)
		await this.warm()

		for (const [slug, old] of this.#cache) {
			const { apPath, ipPath } = this.#paths.get(slug.toLowerCase()) ?? { apPath: null, ipPath: null }

			if (apPath === old.apPath && ipPath === old.ipPath) continue
			this.#cache.set(slug, this.#open(slug))

			if (old._ap) {
				this.#retired.push(old._ap)
			}

			if (old._ip) {
				this.#retired.push(old._ip)
			}
		}

		return this.versions()
	}

	close(): void {
		for (const e of this.#cache.values()) {
			e._ap?.[Symbol.dispose]()
			e._ip?.[Symbol.dispose]()
		}

		for (const h of this.#retired) {
			h[Symbol.dispose]()
		}

		this.#cache.clear()
		this.#retired = []
	}

	[Symbol.dispose](): void {
		this.close()
	}
}
