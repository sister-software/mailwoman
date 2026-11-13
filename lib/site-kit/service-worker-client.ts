// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The page side of an app's service worker.
 *
 *   When a deploy's new worker takes control of an open page, the page keeps running the
 *   JavaScript the previous worker served, while every fetch it makes from then on reaches
 *   current data, such as a releases manifest that points at a model the old code cannot load.
 *   A single reload on that takeover makes the page run the code the new worker serves.
 *
 *   A worker that calls `skipWaiting` on install takes control as soon as it installs.
 *   A worker that waits for a `SKIP_WAITING` message takes control when a page asks, and
 *   {@linkcode registerServiceWorkerUpdates} gives the page the notice and the action for that.
 */

/**
 * Reloads the page once when a new service worker takes control of a page an earlier worker served.
 *
 * A first visit has no controlling worker, so its first worker's takeover doesn't reload the page.
 */
export function reloadOnServiceWorkerTakeover(): void {
	if (!("serviceWorker" in navigator)) return

	const servedByEarlierWorker = Boolean(navigator.serviceWorker.controller)
	let reloading = false

	navigator.serviceWorker.addEventListener("controllerchange", () => {
		if (!servedByEarlierWorker || reloading) return

		reloading = true
		globalThis.location.reload()
	})
}

/**
 * How the page stood when {@linkcode serviceWorkerControl} resolved.
 *
 * - `controlled`: a service worker controls the page, so requests made from now on reach it.
 * - `unsupported`: the browser has no service workers, as in a private window of some browsers.
 * - `timed-out`: no worker took control within the wait, and requests go to the network directly.
 */
export type ServiceWorkerControl = "controlled" | "unsupported" | "timed-out"

/**
 * Resolves once a service worker controls the page.
 *
 * A dedicated worker takes its controller from the page when it is created and keeps it,
 * so a worker created before the first visit's service worker claims the page sends
 * every request to the network for its whole life.
 * An app awaits this before it starts a worker whose requests the service worker must answer,
 * such as a range reader whose whole-file answers the service worker refuses.
 *
 * The app's worker calls `clients.claim()` on activate, so on a first visit the page
 * is controlled once the install finishes, without a reload.
 */
export function serviceWorkerControl(timeoutMs: number): Promise<ServiceWorkerControl> {
	if (!("serviceWorker" in navigator)) return Promise.resolve("unsupported")

	if (navigator.serviceWorker.controller) return Promise.resolve("controlled")

	return new Promise((resolve) => {
		const controlled = (): void => {
			clearTimeout(timer)
			resolve("controlled")
		}

		const timer = setTimeout(() => {
			navigator.serviceWorker.removeEventListener("controllerchange", controlled)
			resolve("timed-out")
		}, timeoutMs)

		navigator.serviceWorker.addEventListener("controllerchange", controlled, { once: true })
	})
}

/**
 * What the page should tell the reader about its code.
 *
 * - `none`: the page shows no notice.
 * - `update-ready`: a new worker is waiting, and {@linkcode ServiceWorkerUpdates.applyUpdate} lets it take over.
 * - `update-needs-connection`: a module of this page's build failed to load while offline.
 *   The page reloads when the connection returns.
 */
export type ServiceWorkerNotice = "none" | "update-ready" | "update-needs-connection"

/**
 * The page's update state, in the shape React's `useSyncExternalStore` reads.
 */
export interface ServiceWorkerUpdates {
	subscribe(listener: () => void): () => void
	getSnapshot(): ServiceWorkerNotice

	/**
	 * Asks the waiting worker to take over.
	 *
	 * Every page an earlier worker served, this one included, then reloads once.
	 */
	applyUpdate(): void
}

/**
 * The part of `vite-plugin-pwa`'s `registerSW` this module calls.
 *
 * The real function comes from the `virtual:pwa-register` module.
 * That module exists only inside a Vite build, so the app passes the function in.
 */
export type RegisterServiceWorker = (options: {
	onNeedRefresh?: () => void
	onNeedReload?: () => void
}) => (reloadPage?: boolean) => Promise<void>

/**
 * The session-storage key holding the time of the last reload after a module failed to load.
 */
const STALE_MODULE_RELOAD_KEY = "mailwoman:stale-module-reload"

/**
 * The shortest interval between two reloads after a module failed to load.
 *
 * A module that fails again right after a reload is missing from the deploy
 * rather than stale, and another reload would repeat without end.
 */
const STALE_MODULE_RELOAD_INTERVAL_MS = 30_000

function reloadedForStaleModuleRecently(now: number): boolean {
	try {
		const last = Number(globalThis.sessionStorage.getItem(STALE_MODULE_RELOAD_KEY))

		return Number.isFinite(last) && now - last < STALE_MODULE_RELOAD_INTERVAL_MS
	} catch {
		return false
	}
}

function recordStaleModuleReload(now: number): void {
	try {
		globalThis.sessionStorage.setItem(STALE_MODULE_RELOAD_KEY, String(now))
	} catch {
		// Without session storage the interval check reads no earlier reload.
	}
}

/**
 * Handles Vite's `vite:preloadError`, raised when the page imports a module of its build that
 * the server no longer has, as after a deploy replaced the build's hashed files.
 *
 * Online, the page reloads once to run the current build.
 * Offline, a reload would fail to fetch the page.
 * `onOffline` runs instead, and the page reloads when the `online` event fires.
 * A second failure within {@link STALE_MODULE_RELOAD_INTERVAL_MS} of a reload is left to Vite.
 * Vite then raises the import error.
 */
export function reloadOnStaleModule(onOffline: () => void): void {
	const reload = (): void => {
		recordStaleModuleReload(Date.now())
		globalThis.location.reload()
	}

	globalThis.addEventListener("vite:preloadError", (event) => {
		if (reloadedForStaleModuleRecently(Date.now())) return

		event.preventDefault()

		if (navigator.onLine) {
			reload()

			return
		}

		onOffline()
		globalThis.addEventListener("online", reload, { once: true })
	})
}

/**
 * Registers the app's service worker for a worker that waits for `SKIP_WAITING`,
 * and returns the update state the page renders.
 *
 * It installs {@linkcode reloadOnServiceWorkerTakeover} and {@linkcode reloadOnStaleModule}.
 * The takeover reload covers every open page, so the page that applies the update
 * doesn't reload a second time from `registerSW`.
 */
export function registerServiceWorkerUpdates(register: RegisterServiceWorker): ServiceWorkerUpdates {
	const listeners = new Set<() => void>()
	let notice: ServiceWorkerNotice = "none"

	const show = (next: ServiceWorkerNotice): void => {
		if (notice === next) return

		notice = next

		for (const listener of listeners) {
			listener()
		}
	}

	reloadOnServiceWorkerTakeover()
	reloadOnStaleModule(() => show("update-needs-connection"))

	const updateServiceWorker = register({
		onNeedRefresh: () => show("update-ready"),
		// The takeover reload above reloads this page with every other one.
		onNeedReload: () => {},
	})

	return {
		subscribe(listener) {
			listeners.add(listener)

			return () => listeners.delete(listener)
		},
		getSnapshot: () => notice,
		applyUpdate() {
			void updateServiceWorker(false)
		},
	}
}
