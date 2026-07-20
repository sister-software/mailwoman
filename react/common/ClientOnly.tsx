/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `ClientOnly` — a portable SSR boundary. The docs explorers wrapped Docusaurus's `<BrowserOnly>`;
 *   this is the framework-agnostic equivalent so the components stay usable in any React app (Next,
 *   Remix, Docusaurus). It renders `fallback` on the server and the first client paint, then swaps to
 *   `children()` once mounted — keeping timers, clipboard, and dynamic imports off the server render.
 *
 *   The mount flag is derived from a `useEffect` that fires only in the browser; this is a legitimate
 *   external-sync effect (bridging the server/client rendering boundary), not derived state.
 */

import { type ReactNode, useEffect, useState } from "react"

export interface ClientOnlyProps {
	/** Rendered once mounted in the browser. A thunk so its (browser-only) imports never run on the server. */
	children: () => ReactNode
	/** Rendered on the server and until the first client mount. */
	fallback?: ReactNode
}

export function ClientOnly({ children, fallback = null }: ClientOnlyProps): ReactNode {
	const [mounted, setMounted] = useState(false)

	useEffect(() => setMounted(true), [])

	return mounted ? children() : fallback
}
