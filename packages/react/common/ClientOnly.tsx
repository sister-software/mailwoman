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
 *   The mount flag comes from `useSyncExternalStore` with a constant snapshot pair — `false` on the
 *   server, `true` in the browser — which is the store-shaped statement of exactly this boundary. The
 *   earlier `useState(false)` + `useEffect(() => setMounted(true))` said the same thing with a
 *   render-cascade the react(set-state-in-effect) rule rightly flags: the second render was the
 *   mechanism, not an accident, and the store form gets the same second paint without a set-state.
 */

import { type ReactNode, useSyncExternalStore } from "react"

/**
 * The boundary never changes after mount, so nothing ever notifies.
 */
function subscribeNever(): () => void {
	return () => {}
}

export interface ClientOnlyProps {
	/**
	 * Rendered once mounted in the browser. A thunk so its (browser-only) imports never run on the server.
	 */
	children: () => ReactNode
	/**
	 * Rendered on the server and until the first client mount.
	 */
	fallback?: ReactNode
}

export function ClientOnly({ children, fallback = null }: ClientOnlyProps): ReactNode {
	const mounted = useSyncExternalStore(
		subscribeNever,
		() => true,
		() => false
	)

	return mounted ? children() : fallback
}
