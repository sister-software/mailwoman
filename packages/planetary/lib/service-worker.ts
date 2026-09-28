/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The planetary service worker: the source `vite-plugin-pwa` injects the precache manifest into for the app
 *   shell, its hashed assets, the icons and the manifest — no code here caches a tile or the search artifact,
 *   which stays fetched on demand.
 */

/// <reference lib="webworker" />

import { precacheAndRoute } from "workbox-precaching"

declare const self: ServiceWorkerGlobalScope

precacheAndRoute(self.__WB_MANIFEST)
