/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Browser-mode test setup: load the component styles + token shim (so layout-adjacent assertions
 *   are meaningful), flag the React act() environment, wrap the interaction/settle APIs in act() (see
 *   `./act.ts`), and unmount rendered trees after each test.
 */

import { afterEach } from "vitest"

import "../styles.css"
import "../.storybook/preview-tokens.css"

import { installActWrappers } from "./act.ts"
import { cleanup } from "./render.tsx"

// React's act() checks this flag; browser mode doesn't set it for us.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Make `userEvent.*` and `vi.waitFor` act-aware for every test, in one place — no per-test wrapping.
installActWrappers()

afterEach(async () => {
	await cleanup()
})
