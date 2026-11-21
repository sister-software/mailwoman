// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Hooks that reload one half of the local geocoding stack: the gazetteer while the
 *   classifier stays loaded, or the classifier while the gazetteer stays open.
 *
 *   The gazetteer is a service on the page's scope, and a release bundle only reads it.
 *   A classifier reload therefore finds the gazetteer still open, and a gazetteer
 *   reload is one invalidation of that service.
 */

import type { AssetsLoadContext } from "@mailwoman/react"
import type { ServiceRegistry } from "async-init"
import type { ReleaseAssets } from "mailwoman/browser-runtime/load-assets"
import { loadReleaseAssets } from "mailwoman/browser-runtime/load-assets"
import type { ReleaseInfo } from "mailwoman/browser-runtime/manifest"
import { useCallback } from "react"

import { HeavyPhase } from "#memory/crash-guard"
import { reportModelBytes } from "#memory/ledger"
import { guardHeavyPhase } from "#memory/profile"
import { CandidateLookupService, reopenCandidateLookup } from "#runtime/page-services"

/**
 * The release loader the page's runtime hands to `useReleaseRuntime`.
 *
 * Each load reads the gazetteer from `pageScope`, which opens it once and shares it with later loads.
 */
export function useReleaseAssetLoader(
	pageScope: () => ServiceRegistry,
	ortWASMURL: string
): {
	loadAssets: (release: ReleaseInfo, ctx: AssetsLoadContext) => Promise<ReleaseAssets>
	disposeAssets: (assets: ReleaseAssets) => Promise<void>
} {
	// The disposer frees a superseded bundle's native memory.
	// The page's scope owns the gazetteer and closes it.
	const disposeAssets = useCallback((assets: ReleaseAssets): Promise<void> => assets.release(), [])

	// The load marks the model phase, so a reload after the tab is killed mid-load finds the breadcrumb.
	const loadAssets = useCallback(
		(release: ReleaseInfo, ctx: AssetsLoadContext): Promise<ReleaseAssets> =>
			guardHeavyPhase(HeavyPhase.Model, async () => {
				const assets = await loadReleaseAssets(release, ctx, {
					gazetteer: { open: () => pageScope().resolve(CandidateLookupService) },
					ortWASMURL,
				})

				reportModelBytes(assets.modelBytes ?? null)

				return assets
			}),
		[pageScope, ortWASMURL]
	)

	return { loadAssets, disposeAssets }
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
 *
 * The model reload is the runtime's `retry`: the next load reads the gazetteer the scope already holds.
 * It is `null` when the bundle has no gazetteer, because a full reload then does the same work.
 */
export function useStackReloads(
	rt: ReloadableRuntime,
	pageScope: () => ServiceRegistry
): { reloadGazetteer: (() => Promise<void>) | null; reloadModel: (() => void) | null } {
	const reloadGazetteer = useGazetteerReload(rt.selectedRelease?.hasWOFDB ?? false, pageScope, rt.updateAssets)

	return { reloadGazetteer, reloadModel: rt.assets?.lookup ? rt.retry : null }
}

/**
 * Returns a function that reopens the gazetteer and swaps it into the live bundle through
 * `updateAssets`, or `null` when the selected release ships no gazetteer.
 *
 * The bundle shows no gazetteer while the new one opens, so a query in that time resolves without one.
 * A failed reopen leaves `lookup` null and records the reason in `gazetteerError`.
 */
export function useGazetteerReload(
	releaseHasGazetteer: boolean,
	pageScope: () => ServiceRegistry,
	updateAssets: (update: (assets: ReleaseAssets) => ReleaseAssets) => void
): (() => Promise<void>) | null {
	const reload = useCallback(async (): Promise<void> => {
		// The bundle drops the lookup before the scope closes it, so no query reads a closed range worker.
		updateAssets((assets) => ({ ...assets, lookup: null }))

		const reading = await reopenCandidateLookup(pageScope())

		updateAssets((assets) => ({ ...assets, ...reading }))
	}, [pageScope, updateAssets])

	return releaseHasGazetteer ? reload : null
}
