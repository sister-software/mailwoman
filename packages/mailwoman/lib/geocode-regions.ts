/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Per-state artifact routing: which address-point / interpolation database serves a parse, the state-slug
 *   derivation that picks it, and `RegionDatabaseProvider`, the bounded cache of open handles. Split from `geocode-core.ts`,
 *   which consumes these through `GeocodeDeps`.
 */

import { US_STATE_BY_ABBREVIATION } from "@mailwoman/codex/us"
import type { AddressTree } from "@mailwoman/core/decoder"
import { walkNodes } from "@mailwoman/core/decoder"
import { pathExists } from "@mailwoman/core/fs/readers"
import type { AddressPointLookup, InterpolationLookup, StreetCentroidLookup } from "@mailwoman/resolver"
import { resolvePath, type PathBuilderLike } from "path-ts"

import { readReleaseManifest, resolveShardPath, type DataReleaseManifest } from "#data-release"

/**
 * The per-state shards to wire into a single geocode resolve. Either/both may be absent (admin-only).
 */
export interface RegionDatabases {
	addressPoints?: AddressPointLookup
	interpolation?: InterpolationLookup
	/**
	 * Derived street-centroid tier (#1042) — a `GROUP BY street` roll-up of a national register's rooftop points, keyed
	 * for a street-only query (no house number). Supplied today only by `@mailwoman/ban`'s `BANRegionDatabaseProvider`
	 * for FR (the US per-state {@link RegionDatabaseProvider} never opens one), so the tier is FR-only in practice and
	 * every non-FR path stays byte-stable. Consulted BELOW the address-point/interpolation tiers, ABOVE admin.
	 */
	streetCentroids?: StreetCentroidLookup
}

/**
 * Resolve the situs/interpolation shards for a state slug (e.g. `"tx"`). `null` slug → no shards.
 */
export type RegionDatabaseResolver = (stateSlug: string | null) => RegionDatabases

/**
 * Full US state name (case-folded) → lowercase 2-letter slug, from the codex table. Built once — the inverse the codex
 * doesn't ship directly.
 */
export const US_STATE_SLUG_BY_NAME: ReadonlyMap<string, string> = new Map(
	Object.entries(US_STATE_BY_ABBREVIATION).map(([abbreviation, name]) => [
		name.toLowerCase(),
		abbreviation.toLowerCase(),
	])
)

/**
 * Lowercase 2-letter state slug from a parsed region value / resolver name, else null. Accepts the abbreviation
 * register ("MI") and the full-name register ("Michigan", "New York") — a user spells the state however they spell it,
 * and a null here silently drops the WHOLE per-state street tier (situs + interpolation), which is how "…, Fraser MI"
 * reached the register while "…, Brooklyn New York" never loaded a shard.
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
 * Walk a (parsed or resolved) tree for its region → the per-state shard slug (e.g. `"tx"`), else null.
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

	// A slug names a US shard and nothing else, but `regionToStateSlug` accepts ANY two-letter region, so a foreign
	// subnational code that happens to spell a US state selects that state's rooftop shard. Measured against the shards
	// on disk: 8 of 16 Italian province codes reach one (MI→Michigan, CO→Colorado, PA→Pennsylvania, VA→Virginia,
	// CA→California, MO→Missouri, AL→Alabama, MT→Montana), 5 of 5 Spanish, 6 of 12 Brazilian, and AU's WA→Washington.
	// IT and ES are tier-1 and write the code in ordinary postal form — `20121 Milano MI`.
	//
	// Nothing WRONG comes back today, and the reason is not structural: the lookup keys on (postcode, street, number) or
	// (locality, street, number), and Milano's 20xxx simply does not collide with Michigan's 48xxx–49xxx. Cádiz province
	// is `CA`, Cadiz is a real California locality and Calle Real a real California street, so the locality variant is one
	// coincident house number away from a ROOFTOP-tier answer on the wrong continent — the highest-confidence thing this
	// pipeline emits.
	//
	// An UNKNOWN country still passes: dropping the slug there would take the street tier away from every US address whose
	// country never resolved, which is the failure #1787 exists to avoid, not to cause.
	if (resolvedCountry !== null && resolvedCountry !== "US") return null

	return regionToStateSlug(regionValue, regionResolverName)
}

/**
 * Per-state situs shard path under `<dataRoot>/address-points/`, or null if the slug/file is absent.
 */
export async function selectAddressPointsDB(dataRoot: string, stateSlug: string | null): Promise<string | null> {
	if (!stateSlug) return null
	const candidate = `${dataRoot}/address-points/address-points-us-${stateSlug}.db`

	return (await pathExists(candidate)) ? candidate : null
}

/**
 * Per-state interpolation shard path under `<dataRoot>/interpolation/`, or null if absent.
 */
export async function selectInterpolationDB(dataRoot: string, stateSlug: string | null): Promise<string | null> {
	if (!stateSlug) return null
	const candidate = `${dataRoot}/interpolation/interpolation-us-${stateSlug}.db`

	return (await pathExists(candidate)) ? candidate : null
}

/**
 * The lookup-class surface a {@link RegionDatabaseProvider} needs from `@mailwoman/resolver-wof-sqlite`.
 */
export interface RegionDatabaseFactory {
	AddressPointSqliteLookup: new (dbPath: string) => AddressPointLookup & Disposable
	StreetInterpolator: new (opts: { dbPath: string }) => InterpolationLookup & Disposable
}

export interface RegionDatabaseCacheEntry extends RegionDatabases {
	_ap?: Disposable
	_ip?: Disposable
	/**
	 * The resolved on-disk paths this entry was opened from — reload() diffs against these.
	 */
	apPath: string | null
	ipPath: string | null
}

/**
 * Opens + CACHES per-state situs/interpolation lookups so a batch geocoding many addresses in one state opens that
 * state's (possibly multi-GB) shards once, not once per row. Versioned-data aware (#485): paths resolve through the
 * `releases.json` manifest (legacy unversioned fallback), and {@link reload} performs a zero-downtime atomic switchover
 * when a new version is published. Call {@link close} when done to release every cached handle.
 *
 * `for` is synchronous, so on-disk existence is probed asynchronously ONCE instead of per call: {@linkcode warm} awaits
 * the #2029-async manifest read + `resolveShardPath` for every US state/territory slug and records what exists; `for`
 * then consults that map. Prefer {@linkcode RegionDatabaseProvider.create}, which constructs AND warms before answering
 * — the constructor itself is private because it cannot await those probes.
 */
export class RegionDatabaseProvider implements Disposable {
	readonly #factory: RegionDatabaseFactory
	readonly #dataRoot: string
	readonly #cache = new Map<string, RegionDatabaseCacheEntry>()
	/**
	 * Previous-generation handles, retired by reload() and closed on the NEXT reload (one-gen grace).
	 */
	#retired: Disposable[] = []
	#manifest: DataReleaseManifest | null
	/**
	 * Per-slug resolved shard paths, preloaded by {@linkcode warm} so `for` never touches the filesystem.
	 */
	readonly #paths = new Map<string, { apPath: string | null; ipPath: string | null }>()

	private constructor(factory: RegionDatabaseFactory, dataRoot: string, manifest: DataReleaseManifest | null) {
		this.#factory = factory
		this.#dataRoot = dataRoot
		this.#manifest = manifest
	}

	/**
	 * Construct a provider and warm its path map before answering. The constructor cannot await the #2029-async manifest
	 * read + shard-path probes, so this static factory does.
	 */
	static async create(factory: RegionDatabaseFactory, dataRoot: PathBuilderLike): Promise<RegionDatabaseProvider> {
		const root = resolvePath(dataRoot)
		const provider = new RegionDatabaseProvider(factory, root, await readReleaseManifest(root))

		await provider.warm()

		return provider
	}

	/**
	 * Preload shard paths for every US state/territory slug. Awaits `resolveShardPath` for each slug's rooftop shard and
	 * its interpolation tier, recording the paths that exist so `for` never touches the filesystem. Safe to call more
	 * than once: it re-probes the same slug set and overwrites the map, which is how {@linkcode reload} re-reads the disk.
	 */
	async warm(): Promise<void> {
		this.#paths.clear()

		for (const abbreviation of Object.keys(US_STATE_BY_ABBREVIATION)) {
			const slug = abbreviation.toLowerCase()

			const [apPath, ipPath] = await Promise.all([
				resolveShardPath(this.#dataRoot, "address-points", slug, this.#manifest),
				resolveShardPath(this.#dataRoot, "interpolation", slug, this.#manifest),
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
	 * The current data-release versions ({@link readReleaseManifest}), or null in legacy mode.
	 */
	versions(): DataReleaseManifest | null {
		return this.#manifest ? { ...this.#manifest } : null
	}

	/**
	 * Re-read the manifest, re-probe the shard paths, and atomically swap any cached shard whose resolved path changed.
	 * New requests see the new version immediately; the old handles are RETIRED and closed on the next reload
	 * (one-generation grace — safe because find() is synchronous, so no in-flight query can still hold a handle once a
	 * request yields). Returns the new version map.
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

			if (apPath === old.apPath && ipPath === old.ipPath) continue // unchanged — keep the open handle
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
