// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Hooks that reload one half of the local geocoding stack: the gazetteer while the
 *   classifier stays loaded, or the classifier while the gazetteer stays open.
 */

import type { AssetsLoadContext } from "@mailwoman/react"
import type { MailwomanLookupLike } from "@mailwoman/resolver-wof-wasm/browser-cascade"
import type { ReleaseAssets } from "mailwoman/browser-runtime/load-assets"
import { loadReleaseAssets, openCandidateTableLookup } from "mailwoman/browser-runtime/load-assets"
import type { ReleaseInfo } from "mailwoman/browser-runtime/manifest"
import { useCallback, useMemo, useRef } from "react"

import { HeavyPhase } from "#memory/crash-guard"
import { reportModelBytes } from "#memory/ledger"
import { guardHeavyPhase } from "#memory/profile"

/**
 * The gazetteer a model-only reload hands from the outgoing bundle to the next load.
 */
export interface KeptGazetteer {
	keep(lookup: MailwomanLookupLike | null): void
	/**
	 * Returns the kept gazetteer and clears it, so only the next load takes it.
	 */
	take(): MailwomanLookupLike | null
	/**
	 * Returns the kept gazetteer without clearing it, so a disposer can leave it open.
	 */
	peek(): MailwomanLookupLike | null
}

/**
 * A stable {@link KeptGazetteer}.
 */
export function useKeptGazetteer(): KeptGazetteer {
	const kept = useRef<MailwomanLookupLike | null>(null)

	return useMemo(
		() => ({
			keep: (lookup) => {
				kept.current = lookup
			},
			take: () => {
				const lookup = kept.current

				kept.current = null

				return lookup
			},
			peek: () => kept.current,
		}),
		[]
	)
}

/**
 * The release loader the page's runtime hands to `useReleaseRuntime`,
 * with the kept gazetteer a model-only reload passes to it.
 */
export function useReleaseAssetLoader(
	sqliteRuntimeBaseURL: string,
	ortWASMURL: string
): {
	keptGazetteer: KeptGazetteer
	loadAssets: (release: ReleaseInfo, ctx: AssetsLoadContext) => Promise<ReleaseAssets>
	disposeAssets: (assets: ReleaseAssets) => Promise<void>
} {
	const keptGazetteer = useKeptGazetteer()

	// The disposer frees a superseded bundle's native memory, including a gazetteer reopened after the load.
	// The bundle's own `release` closes only the gazetteer its load opened.
	// A gazetteer a model-only reload keeps for the next load stays open.
	const disposeAssets = useCallback(
		(assets: ReleaseAssets): Promise<void> => {
			const keepLookup = assets.lookup != null && assets.lookup === keptGazetteer.peek()

			if (!keepLookup) {
				assets.lookup?.close?.()
			}

			return assets.release({ keepLookup })
		},
		[keptGazetteer]
	)

	// The load marks the model phase, so a reload after the tab is killed mid-load finds the breadcrumb.
	const loadAssets = useCallback(
		(release: ReleaseInfo, ctx: AssetsLoadContext): Promise<ReleaseAssets> =>
			guardHeavyPhase(HeavyPhase.Model, async () => {
				const assets = await loadReleaseAssets(release, ctx, {
					gazetteer: { sqliteRuntimeBaseURL, lookup: keptGazetteer.take() },
					ortWASMURL,
				})

				reportModelBytes(assets.modelBytes ?? null)

				return assets
			}),
		[sqliteRuntimeBaseURL, ortWASMURL, keptGazetteer]
	)

	return { keptGazetteer, loadAssets, disposeAssets }
}

/**
 * The release-runtime state the stack reloads read.
 */
interface ReloadableRuntime {
	selectedRelease: { hasWOFDB?: boolean } | null
	assets: ReleaseAssets | null
	retry: () => void
	updateAssets: (update: (assets: ReleaseAssets) => ReleaseAssets) => void
}

/**
 * The gazetteer-only and model-only reloads for the Developer sheet, each `null` when it doesn't apply.
 */
export function useStackReloads(
	rt: ReloadableRuntime,
	sqliteRuntimeBaseURL: string,
	kept: KeptGazetteer
): { reloadGazetteer: (() => Promise<void>) | null; reloadModel: (() => void) | null } {
	const reloadGazetteer = useGazetteerReload(
		rt.selectedRelease?.hasWOFDB ?? false,
		sqliteRuntimeBaseURL,
		rt.updateAssets
	)

	const reloadModel = useModelReload(kept, rt.assets?.lookup ?? null, rt.retry)

	return { reloadGazetteer, reloadModel }
}

/**
 * Returns a function that reloads the classifier and keeps the open gazetteer, or `null`
 * when the bundle has no gazetteer to keep and a full reload does the same work.
 */
export function useModelReload(
	kept: KeptGazetteer,
	lookup: MailwomanLookupLike | null,
	retry: () => void
): (() => void) | null {
	const reload = useCallback(() => {
		kept.keep(lookup)
		retry()
	}, [kept, lookup, retry])

	return lookup ? reload : null
}

/**
 * Returns a function that reopens the gazetteer and swaps it into the live bundle through
 * `updateAssets`, or `null` when the selected release ships no gazetteer.
 *
 * A failed reopen leaves `lookup` null and records the reason in `gazetteerError`.
 */
export function useGazetteerReload(
	releaseHasGazetteer: boolean,
	sqliteRuntimeBaseURL: string,
	updateAssets: (update: (assets: ReleaseAssets) => ReleaseAssets) => void
): (() => Promise<void>) | null {
	const reload = useCallback(async (): Promise<void> => {
		// The replaced lookup's range worker is closed, so a reload doesn't leave a second sqlite-wasm heap behind.
		try {
			const lookup = await openCandidateTableLookup(sqliteRuntimeBaseURL)

			updateAssets((assets) => {
				assets.lookup?.close?.()

				return { ...assets, lookup, gazetteerError: null }
			})
		} catch (error) {
			const gazetteerError = error instanceof Error ? error.message : String(error)

			updateAssets((assets) => {
				assets.lookup?.close?.()

				return { ...assets, lookup: null, gazetteerError }
			})
		}
	}, [sqliteRuntimeBaseURL, updateAssets])

	return releaseHasGazetteer ? reload : null
}
