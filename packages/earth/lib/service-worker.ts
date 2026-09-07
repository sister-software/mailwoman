/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Earth service worker. This file is the source `vite-plugin-pwa` injects the precache manifest into: the app
 *   shell, its hashed assets, the icons and the manifest. The range cache for the gazetteer databases joins this file
 *   when the runtime moves in; nothing here caches a model, a database or a tile.
 */

/// <reference lib="webworker" />

import { precacheAndRoute } from "workbox-precaching"

declare const self: ServiceWorkerGlobalScope

precacheAndRoute(self.__WB_MANIFEST)
