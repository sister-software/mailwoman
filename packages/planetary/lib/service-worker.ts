// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The planetary service worker receives the precache manifest that `vite-plugin-pwa`
 * injects for the app shell, its hashed assets, the icons and the manifest.
 *
 * The service worker doesn't cache tiles or the search artifact.
 * The app fetches both on demand.
 */

/// <reference lib="webworker" />

import { precacheAndRoute } from "workbox-precaching"

declare const self: ServiceWorkerGlobalScope

precacheAndRoute(self.__WB_MANIFEST)
