// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The page-to-worker message that lets a waiting service worker take over.
 *
 *   A worker that doesn't call `skipWaiting` on install waits until the page asks.
 *   `workbox-window`'s `messageSkipWaiting`, which `vite-plugin-pwa`'s update
 *   function calls, posts this message to the waiting worker.
 */

/**
 * The `type` `workbox-window` posts.
 */
export const SKIP_WAITING_MESSAGE_TYPE = "SKIP_WAITING"

/**
 * Whether a message asks the receiving worker to stop waiting.
 */
export function isSkipWaitingMessage(data: unknown): boolean {
	return typeof data === "object" && data != null && (data as { type?: unknown }).type === SKIP_WAITING_MESSAGE_TYPE
}
