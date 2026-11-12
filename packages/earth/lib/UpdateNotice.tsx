// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The notice Earth shows when a deploy's service worker is waiting to take over,
 *   or when a module of the running build couldn't load offline.
 */

import type { ServiceWorkerUpdates } from "@mailwoman/universe/site-kit/service-worker-client"
import { useSyncExternalStore } from "react"

import styles from "./update-notice.module.css"

export interface UpdateNoticeProps {
	updates: ServiceWorkerUpdates
}

/**
 * Renders `null` while the update state is `none`.
 *
 * "Update ready · Reload" lets the waiting worker take over, after which every open tab reloads once.
 * "Update needs a connection" stays until the page reloads itself on reconnecting.
 */
export function UpdateNotice({ updates }: UpdateNoticeProps) {
	const notice = useSyncExternalStore(updates.subscribe, updates.getSnapshot, () => "none" as const)

	if (notice === "none") return null

	return (
		<div className={styles.notice} role="status">
			{notice === "update-ready" ? (
				<>
					<span>Update ready</span>
					<span aria-hidden="true">·</span>
					<button type="button" className={styles.action} onClick={() => updates.applyUpdate()}>
						Reload
					</button>
				</>
			) : (
				<span>Update needs a connection</span>
			)}
		</div>
	)
}
