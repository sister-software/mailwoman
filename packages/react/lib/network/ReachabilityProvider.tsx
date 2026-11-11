/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<ReachabilityProvider>` keeps a {@linkcode ConnectivityReading} for one service: the browser's `navigator.onLine`
 *   and the latest probe of a route on that service.
 */

import {
	type ConnectivityReading,
	readNavigatorOnline,
	UNKNOWN_CONNECTIVITY,
} from "@mailwoman/core/network/connectivity"
import { ReachabilityProbe } from "@mailwoman/core/network/reachability"
import {
	createContext,
	type FC,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react"

/**
 * The milliseconds between probes while the service answers.
 */
export const REACHABLE_PROBE_INTERVAL_MS = 60_000

/**
 * The milliseconds between probes while the service doesn't answer,
 * so a recovered service is noticed sooner.
 */
export const UNREACHABLE_PROBE_INTERVAL_MS = 10_000

export interface ConnectivityContextValue {
	/**
	 * The reading as of the last render.
	 */
	reading: ConnectivityReading

	/**
	 * The latest reading, including changes since the last render.
	 *
	 * Its identity is stable, so a long-lived consumer such as a geocoder service can hold it.
	 */
	read: () => ConnectivityReading

	/**
	 * Probes the service now, as after a request to it failed, instead of at the next scheduled probe.
	 */
	recheck: () => void
}

const ConnectivityContext = createContext<ConnectivityContextValue>({
	reading: UNKNOWN_CONNECTIVITY,
	read: () => UNKNOWN_CONNECTIVITY,
	recheck: () => {},
})

ConnectivityContext.displayName = "ConnectivityContext"

/**
 * The connectivity reading of the nearest {@linkcode ReachabilityProvider},
 * with its stable `read` and `recheck`.
 */
export function useConnectivity(): ConnectivityContextValue {
	return useContext(ConnectivityContext)
}

/**
 * Whether neither signal of the nearest {@linkcode ReachabilityProvider} rules out a request to its service.
 * An unknown signal counts as allowing one.
 */
export function useReachability(): boolean {
	const { online, reachable } = useContext(ConnectivityContext).reading

	return online !== false && reachable !== false
}

export interface ReachabilityProviderProps {
	children: ReactNode

	/**
	 * The service route to probe, such as the geocoder API's `/health`.
	 *
	 * It must answer CORS requests from the page's origin.
	 * `null` leaves `reachable` unknown and reports only `navigator.onLine`.
	 */
	url: string | URL | null

	/**
	 * Suspends probing and keeps the last reading.
	 */
	disable?: boolean

	/**
	 * @see {@linkcode REACHABLE_PROBE_INTERVAL_MS}
	 */
	reachableIntervalMs?: number

	/**
	 * @see {@linkcode UNREACHABLE_PROBE_INTERVAL_MS}
	 */
	unreachableIntervalMs?: number
}

/**
 * Keeps a connectivity reading for the service at `url` and provides it to
 * {@linkcode useConnectivity} and {@linkcode useReachability}.
 *
 * The provider probes on mount, on the browser's `online` event, when the page
 * becomes visible again and when a consumer calls `recheck`.
 * Between those it probes on an interval that depends on the last result.
 *
 * It stops probing while the page is hidden, as when a home-screen web app moves to
 * the background, and while the browser reports itself offline.
 */
export const ReachabilityProvider: FC<ReachabilityProviderProps> = ({
	children,
	url,
	disable = false,
	reachableIntervalMs = REACHABLE_PROBE_INTERVAL_MS,
	unreachableIntervalMs = UNREACHABLE_PROBE_INTERVAL_MS,
}) => {
	const [reading, setReading] = useState<ConnectivityReading>(() => ({
		online: readNavigatorOnline(),
		reachable: null,
	}))

	const latest = useRef(reading)
	const recheckRef = useRef<() => void>(() => {})
	const probeURL = url == null ? null : String(url)

	useEffect(() => {
		if (disable) return

		const probe = probeURL ? new ReachabilityProbe(probeURL) : null

		let stopped = false
		let revision = 0
		let timeoutID: ReturnType<typeof setTimeout> | undefined

		const publish = (next: ConnectivityReading) => {
			latest.current = next

			setReading((previous) =>
				previous.online === next.online && previous.reachable === next.reachable ? previous : next
			)
		}

		const refresh = () => {
			if (stopped) return

			clearTimeout(timeoutID)

			// A result from an earlier refresh is discarded once this one starts.
			const currentRevision = ++revision
			const online = readNavigatorOnline()

			if (online === false) {
				probe?.abort()
				publish({ online, reachable: false })

				return
			}

			if (!probe || document.visibilityState === "hidden") {
				publish({ online, reachable: latest.current.reachable })

				return
			}

			void probe.test().then((reachable) => {
				if (stopped || currentRevision !== revision) return

				publish({ online: readNavigatorOnline(), reachable })

				timeoutID = setTimeout(refresh, reachable ? reachableIntervalMs : unreachableIntervalMs)
			})
		}

		const onVisibilityChange = () => {
			if (document.visibilityState === "visible") {
				refresh()
			}
		}

		recheckRef.current = refresh

		self.addEventListener("online", refresh)
		self.addEventListener("offline", refresh)
		document.addEventListener("visibilitychange", onVisibilityChange)

		refresh()

		return () => {
			stopped = true

			++revision
			recheckRef.current = () => {}

			self.removeEventListener("online", refresh)
			self.removeEventListener("offline", refresh)
			document.removeEventListener("visibilitychange", onVisibilityChange)

			clearTimeout(timeoutID)
			probe?.[Symbol.dispose]()
		}
	}, [disable, probeURL, reachableIntervalMs, unreachableIntervalMs])

	const read = useCallback(() => latest.current, [])
	const recheck = useCallback(() => recheckRef.current(), [])
	const value = useMemo(() => ({ reading, read, recheck }), [reading, read, recheck])

	return <ConnectivityContext.Provider value={value}>{children}</ConnectivityContext.Provider>
}
