// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The Developer sheet's storage controls: what the page keeps offline, clearing it by role,
 *   and reloading the model or the gazetteer without a page reload.
 *
 *   The page asks the service worker to report and clear its caches by role,
 *   because the app-asset cache's name changes with each build.
 */

import {
	type CacheRoleUsage,
	CACHE_CONTROL_MESSAGE_TYPE,
	requestCacheControl,
} from "@mailwoman/service-worker-cache/cache-control"
import { useCallback, useEffect, useState } from "react"

import styles from "./cache-panel.module.css"

/**
 * The words the panel shows for each cache role the service worker reports.
 */
const ROLE_LABELS: Readonly<Record<string, string>> = {
	tiles: "Map tiles",
	"release-assets": "Model and release files",
	"db-ranges": "Gazetteer chunks",
	manifests: "Manifests",
	"app-assets": "App runtime files",
}

/**
 * The bytes in a mebibyte, the unit the storage estimate is shown in.
 */
const BYTES_PER_MIB = 1024 * 1024

function formatMiB(bytes: number | undefined): string {
	return typeof bytes === "number" ? `${(bytes / BYTES_PER_MIB).toFixed(0)} MB` : "?"
}

interface StorageState {
	usage: CacheRoleUsage[] | null
	estimate: StorageEstimate | null
	persisted: boolean | null
}

async function readStorageState(): Promise<StorageState> {
	const [reply, estimate, persisted] = await Promise.all([
		requestCacheControl({ type: CACHE_CONTROL_MESSAGE_TYPE, action: "usage" }),
		navigator.storage?.estimate?.().catch(() => null) ?? null,
		navigator.storage?.persisted?.().catch(() => null) ?? null,
	])

	return { usage: reply.action === "usage" ? reply.usage : null, estimate, persisted }
}

export interface CachePanelProps {
	/**
	 * Loads the classifier and gazetteer again, or `null` when the page loads no release.
	 */
	reloadStack: (() => void) | null
	/**
	 * Reopens the gazetteer and keeps the classifier, or `null` when the release has no gazetteer.
	 */
	reloadGazetteer: (() => Promise<void>) | null
}

export function CachePanel({ reloadStack, reloadGazetteer }: CachePanelProps) {
	const [state, setState] = useState<StorageState | null>(null)
	const [status, setStatus] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)

	const refresh = useCallback(async () => {
		setState(await readStorageState())
	}, [])

	// The worker's caches are external state, so the panel reads them when it mounts.
	// A read that settles after unmount is dropped.
	useEffect(() => {
		let mounted = true

		const readOnMount = async (): Promise<void> => {
			const next = await readStorageState()

			if (mounted) {
				setState(next)
			}
		}

		void readOnMount()

		return () => {
			mounted = false
		}
	}, [])

	const run = useCallback(
		async (label: string, work: () => Promise<string>) => {
			setBusy(true)
			setStatus(`${label}…`)

			try {
				setStatus(await work())
			} catch (error) {
				setStatus(`${label} failed: ${error instanceof Error ? error.message : String(error)}`)
			} finally {
				setBusy(false)
				void refresh()
			}
		},
		[refresh]
	)

	const clearRole = (role: string) =>
		run(`Clearing ${ROLE_LABELS[role] ?? role}`, async () => {
			const reply = await requestCacheControl({ type: CACHE_CONTROL_MESSAGE_TYPE, action: "clear", roles: [role] })

			if (reply.action === "error") throw new Error(reply.error)

			return `Cleared ${ROLE_LABELS[role] ?? role}.`
		})

	// Everything includes the precache.
	// The worker doesn't report the precache by role, so the page deletes every cache itself.
	const clearEverything = () =>
		run("Clearing everything", async () => {
			const names = await caches.keys()

			await Promise.all(names.map((name) => caches.delete(name)))

			const registration = await navigator.serviceWorker?.getRegistration()
			const unregistered = (await registration?.unregister()) ?? false

			return unregistered
				? `Deleted ${names.length} caches and removed the service worker. Reload the page to install it again.`
				: `Deleted ${names.length} caches.`
		})

	const requestPersistence = () =>
		run("Requesting persistent storage", async () =>
			(await navigator.storage.persist())
				? "The browser will keep this site's offline data under storage pressure."
				: "The browser declined to keep this site's data persistent."
		)

	const usage = state?.usage ?? null

	return (
		<section className={styles.panel} aria-label="Offline storage">
			<h3 className={styles.heading}>Offline storage</h3>

			<p className={styles.summary}>
				{state?.estimate
					? `Using ${formatMiB(state.estimate.usage)} of ${formatMiB(state.estimate.quota)}`
					: "Storage estimate unavailable"}
				{state?.persisted ? " · persistent" : ""}
			</p>

			{usage ? (
				<ul className={styles.list}>
					{usage.map((entry) => (
						<li key={entry.role} className={styles.row}>
							<span>{ROLE_LABELS[entry.role] ?? entry.role}</span>
							<span className={styles.count}>
								{entry.entries} {entry.entries === 1 ? "file" : "files"}
							</span>
							<button
								type="button"
								className="mw-map-chip"
								disabled={busy || entry.entries === 0}
								onClick={() => void clearRole(entry.role)}
							>
								Clear
							</button>
						</li>
					))}
				</ul>
			) : (
				<p className={styles.summary}>No service worker controls this page, so it keeps no offline copy.</p>
			)}

			<div className={styles.actions}>
				{reloadStack ? (
					<button type="button" className="mw-map-chip" disabled={busy} onClick={reloadStack}>
						Reload model and gazetteer
					</button>
				) : null}
				{reloadGazetteer ? (
					<button
						type="button"
						className="mw-map-chip"
						disabled={busy}
						onClick={() =>
							void run("Reopening the gazetteer", async () => (await reloadGazetteer(), "Gazetteer reopened."))
						}
					>
						Reload gazetteer
					</button>
				) : null}
				{state?.persisted === false ? (
					<button type="button" className="mw-map-chip" disabled={busy} onClick={() => void requestPersistence()}>
						Keep offline data
					</button>
				) : null}
				<button type="button" className="mw-map-chip" disabled={busy} onClick={() => void clearEverything()}>
					Clear everything
				</button>
			</div>

			{status ? (
				<p className={styles.summary} role="status">
					{status}
				</p>
			) : null}
		</section>
	)
}
