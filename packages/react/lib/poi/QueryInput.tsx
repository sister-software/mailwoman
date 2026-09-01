/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `QueryInput` — the labelled text field for the POI explorer. Controlled; presentational only.
 */

import type { ReactNode } from "react"

export interface QueryInputProps {
	id: string
	label: string
	value: string
	onChange: (value: string) => void
	placeholder?: string
}

export function QueryInput({ id, label, value, onChange, placeholder }: QueryInputProps): ReactNode {
	return (
		<div className="mw-field">
			<label htmlFor={id}>{label}</label>
			<input id={id} type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
		</div>
	)
}
