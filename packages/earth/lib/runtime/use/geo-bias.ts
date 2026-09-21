/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @file Device-location map bias.
 */

import { useCallback, useRef, useState, type RefObject } from "react"

/**
 * Why a device location could not be used. `null` while nothing has gone wrong.
 */
export type GeoBiasError = "denied" | "unavailable" | "unsupported"

/**
 * Device-location proximity-bias control (the "📍 Use my location" button state + toggle).
 */
export interface GeoBiasControl {
	/**
	 * Whether a device location is currently applied as a soft bias.
	 */
	active: boolean
	/**
	 * Why the last attempt failed, or `null`. The chip alone cannot say this: a denial turns it
	 * back off, which looks exactly like a visitor toggling it off themselves, and pressing it
	 * again does nothing visible because the browser remembers the denial and never prompts twice.
	 */
	error: GeoBiasError | null
	/**
	 * Toggle the device-location bias on/off (prompts for geolocation when turning on).
	 */
	toggle: () => void
}

export interface GeoBiasState extends GeoBiasControl {
	locationRef: RefObject<{ lat: number; lon: number } | null>
}

export function useGeoBias(): GeoBiasState {
	const geoBiasRef = useRef<{ lat: number; lon: number } | null>(null)
	const [active, setActive] = useState(false)
	const [error, setError] = useState<GeoBiasError | null>(null)

	const toggle = useCallback(() => {
		if (geoBiasRef.current) {
			geoBiasRef.current = null
			setActive(false)
			setError(null)

			return
		}

		setError(null)

		if (typeof navigator === "undefined" || !navigator.geolocation) {
			setError("unsupported")

			return
		}

		navigator.geolocation.getCurrentPosition(
			(position) => {
				geoBiasRef.current = { lat: position.coords.latitude, lon: position.coords.longitude }
				setActive(true)
			},
			(positionError) => {
				setActive(false)
				setError(positionError.code === positionError.PERMISSION_DENIED ? "denied" : "unavailable")
			},
			{ maximumAge: 600_000, timeout: 8000 }
		)
	}, [])

	return { active, error, toggle, locationRef: geoBiasRef }
}
