// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Core API utilities.
 */

export * from "./APIClient.ts"
export * from "./clock.ts"
export * from "./headless.ts"
export * from "./pacer.ts"
export * from "./responses.ts"
export * from "./retry.ts"

// NOT `./disk-storage.ts` — it imports `node:fs/promises`, and this barrel reaches a browser bundle
// (docs' DashboardMap → @mailwoman/cartographer → tiles/api.ts → @mailwoman/core/api). Import it from
// its own `@mailwoman/core/api/disk-storage` subpath.
