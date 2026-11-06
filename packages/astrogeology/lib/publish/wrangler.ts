// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Upload transport that runs `wrangler r2 object put`. Wrangler reads `CLOUDFLARE_API_TOKEN` and
 *   `CLOUDFLARE_ACCOUNT_ID` from the environment.
 */

import { putR2ObjectWithWrangler } from "@mailwoman/core/cloudflare"
import type { UploadTransport } from "mailwoman/tools/tiles/publish"

/**
 * Put one local file at `bucket/key` through wrangler.
 */
export const uploadWithWrangler: UploadTransport = putR2ObjectWithWrangler
