// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * A promise for an emitter's next named event — `await once(child, "exit")` — rejecting on its `error`.
 */
export { once } from "node:events"
