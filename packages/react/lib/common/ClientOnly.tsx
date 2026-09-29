/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `ClientOnly` — a portable SSR boundary that renders `fallback` on the server and first client paint. It swaps to `children()` after mounting, keeping timers, clipboard and dynamic imports off the server render.
 */

import { type ReactNode, useSyncExternalStore } from "react"

function subscribeNever(): () => void {
	return () => {}
}

export interface ClientOnlyProps {
	/**
	 * Rendered once mounted in the browser, as a thunk so its browser-only imports never run on the server.
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
