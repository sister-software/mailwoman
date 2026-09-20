// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Browser-mode test setup: load the component styles (which pull the tokens in themselves, so a
 *   layout-adjacent assertion reads the same values production does), flag the React act() environment,
 *   wrap the interaction/settle APIs in act() (see `./act.ts`), and unmount rendered trees after each test.
 */

import { afterEach } from "vitest"

import "../styles.css"

import { installActWrappers } from "./act.ts"
import { cleanup } from "./render.tsx"

const actGlobal = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }

// React's act() checks this flag. browser mode doesn't set it for us.
actGlobal.IS_REACT_ACT_ENVIRONMENT = true

// Make `userEvent.*` and `vi.waitFor` act-aware for every test, in one place — no per-test wrapping.
installActWrappers()

afterEach(async () => {
	await cleanup()
})
