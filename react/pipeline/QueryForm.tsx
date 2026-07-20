/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `QueryForm` — the address input + submit button for the pipeline explorer. Shows a spinner while
 *   parsing. Presentational; `onSubmit` fires on form submission.
 */

import type { ReactNode } from "react"

import { LoadingIndicator } from "../common/LoadingIndicator.tsx"

export interface QueryFormProps {
	value: string
	onChange: (value: string) => void
	onSubmit: () => void
	disabled?: boolean
	busy?: boolean
	placeholder?: string
}

export function QueryForm({ value, onChange, onSubmit, disabled, busy, placeholder }: QueryFormProps): ReactNode {
	return (
		<form
			className="mw-field"
			onSubmit={(e) => {
				e.preventDefault()
				onSubmit()
			}}
		>
			<label htmlFor="mw-pipeline-input">Address</label>
			<input
				id="mw-pipeline-input"
				type="text"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				disabled={disabled}
				placeholder={placeholder}
			/>
			<button type="submit" disabled={disabled || busy}>
				{busy ? (
					<>
						<LoadingIndicator mode="spinner" size="small" /> Parsing…
					</>
				) : (
					"Parse + resolve"
				)}
			</button>
		</form>
	)
}
