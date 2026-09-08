// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The planetary service worker. This file is the source `vite-plugin-pwa` injects the precache manifest into: the
 *   app shell, its hashed assets, the icons and the manifest. Nothing here caches a tile or the search artifact; those
 *   stay fetched on demand.
 */

/// <reference lib="webworker" />

import { precacheAndRoute } from "workbox-precaching"

declare const self: ServiceWorkerGlobalScope

precacheAndRoute(self.__WB_MANIFEST)
