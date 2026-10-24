/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   On-demand weights families in the browser. The input's script selects a family through the router the Node
 *   engine ships, the family's own release manifest selects the release, and that release's bundle loads once per
 *   page and reads every later input in the same script. The base release keeps reading the inputs the router
 *   leaves with the caller.
 */

import { scriptFamilyForText } from "@mailwoman/neural/classifier/script-router"

import { DEFAULT_LOCALE } from "#browser-runtime/classify"
import { fetchReleasesManifest, type ReleaseInfo, type ReleasesManifest } from "#browser-runtime/manifest"
import type { AssetLoadProgress } from "#browser-runtime/types"

/**
 * A progress surface that reports to no one, for a bundle loaded behind a parse
 * rather than behind the page's loading state.
 *
 * The load aborts with `signal` when one is given.
 */
export function silentAssetProgress(signal: AbortSignal = new AbortController().signal): AssetLoadProgress {
	return {
		signal,
		setProgress: () => {},
		setStepLabels: () => {},
		setStepIndex: () => {},
		setBackend: () => {},
	}
}

export interface FamilyBundlesOptions<TAssets> {
	/**
	 * The family the base release reads, `en-us` by default.
	 *
	 * An input the router sends there loads no bundle.
	 */
	baseFamily?: string
	/**
	 * Reads a family's release manifest, or null when the bucket publishes none for it.
	 */
	fetchManifest?: (family: string) => Promise<ReleasesManifest | null>
	/**
	 * Loads the bundle of one release of a family.
	 */
	load: (family: string, release: ReleaseInfo) => Promise<TAssets>
	/**
	 * Gives a loaded bundle's native memory back.
	 */
	dispose?: (assets: TAssets) => Promise<void> | void
}

/**
 * The bundles of the weights families a page has needed so far, each loaded on its first input.
 */
export class FamilyBundles<TAssets> {
	readonly #baseFamily: string
	readonly #fetchManifest: (family: string) => Promise<ReleasesManifest | null>
	readonly #load: (family: string, release: ReleaseInfo) => Promise<TAssets>
	readonly #dispose: ((assets: TAssets) => Promise<void> | void) | null
	readonly #bundles = new Map<string, Promise<TAssets | null>>()

	constructor(options: FamilyBundlesOptions<TAssets>) {
		this.#baseFamily = options.baseFamily ?? DEFAULT_LOCALE
		this.#fetchManifest = options.fetchManifest ?? fetchReleasesManifest
		this.#load = options.load
		this.#dispose = options.dispose ?? null
	}

	/**
	 * The family whose bundle reads `input`, or null when the base release reads it.
	 */
	familyFor(input: string): string | null {
		const family = scriptFamilyForText(input)

		return family && family !== this.#baseFamily ? family : null
	}

	/**
	 * The family's bundle, loaded on the first call and shared by every later one,
	 * or null when the bucket publishes no release for the family.
	 *
	 * A load that fails is forgotten, so the next input in that script retries it.
	 */
	ensure(family: string): Promise<TAssets | null> {
		const pending = this.#bundles.get(family)

		if (pending) return pending

		const load = this.#loadFamily(family)

		this.#bundles.set(family, load)

		load.catch(() => {
			this.#bundles.delete(family)
		})

		return load
	}

	/**
	 * The bundle that reads `input`, or null when the base release reads it
	 * or its family has no published release.
	 */
	async forInput(input: string): Promise<TAssets | null> {
		const family = this.familyFor(input)

		return family ? this.ensure(family) : null
	}

	/**
	 * Gives every loaded bundle back and forgets it.
	 */
	async dispose(): Promise<void> {
		const pending = [...this.#bundles.values()]

		this.#bundles.clear()

		for (const load of pending) {
			const assets = await load.catch(() => null)

			if (assets) {
				await this.#dispose?.(assets)
			}
		}
	}

	async #loadFamily(family: string): Promise<TAssets | null> {
		const manifest = await this.#fetchManifest(family)
		const release = manifest?.releases.find((entry) => entry.version === manifest.defaultVersion) ?? null

		if (!release) return null

		return this.#load(family, release)
	}
}
