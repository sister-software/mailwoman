/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The planetary service worker. This file is the source `vite-plugin-pwa` injects the precache manifest into: the
 *   app shell, its hashed assets, the icons and the manifest. Nothing here caches a tile or the search artifact; those
 *   stay fetched on demand.
 */

/// <reference lib="webworker" />

import { precacheAndRoute } from "workbox-precaching"

declare const self: ServiceWorkerGlobalScope

precacheAndRoute(self.__WB_MANIFEST)
