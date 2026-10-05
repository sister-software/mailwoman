/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The scenario controls, grouped by the word of #2289's item 4 that each covers: investment, value, evidence,
 *   dates and assumptions. The form applies every control at once when the reader presses Recalculate or Enter, so
 *   the live region announces one recalculation for one change. A field whose text does not read in its unit keeps
 *   the last applied values and says why beside the field.
 */

import { UnitStage } from "@mailwoman/dossier"
import { type ReactNode, type SubmitEvent, useState } from "react"

import { type ControlField, type ControlText, controlText, type ControlValues, parseControls } from "#controls"

export interface ScenarioControlsProps {
	defaults: ControlValues
	currency: string
	onApply: (values: ControlValues) => void
}

interface FieldSpec {
	field: ControlField
	label: string
	type: "number" | "date" | "month" | "select"
	step?: string
}

export function ScenarioControls({ defaults, currency, onApply }: ScenarioControlsProps): ReactNode {
	const [text, setText] = useState<ControlText>(() => controlText(defaults, currency))
	const [errors, setErrors] = useState<Partial<Record<ControlField, string>>>({})

	const groups: readonly { legend: string; fields: readonly FieldSpec[] }[] = [
		{
			legend: "Investment",
			fields: [
				{ field: "costAdjustment", label: "Cost adjustment, percent of the rate card", type: "number", step: "0.01" },
			],
		},
		{
			legend: "Value",
			fields: [
				{ field: "takeRate", label: "Take rate, percent of occupied units", type: "number", step: "0.01" },
				{ field: "monthlyPrice", label: `Monthly price from month 0, ${currency}`, type: "number", step: "0.01" },
			],
		},
		{
			legend: "Evidence",
			fields: [
				{ field: "dossierDate", label: "Dossier date", type: "date" },
				{ field: "unitStage", label: "Unit stage", type: "select" },
			],
		},
		{
			legend: "Dates",
			fields: [{ field: "monthZero", label: "Month zero", type: "month" }],
		},
		{
			legend: "Assumptions",
			fields: [
				{ field: "discountRate", label: "Discount rate, effective annual percent", type: "number", step: "0.01" },
				{ field: "horizon", label: "Horizon in months", type: "number", step: "1" },
			],
		},
	]

	const apply = (event: SubmitEvent<HTMLFormElement>) => {
		event.preventDefault()

		const parsed = parseControls(text, currency)

		if (!parsed.ok) {
			setErrors(parsed.errors)

			return
		}

		setErrors({})
		onApply(parsed.values)
	}

	const restore = () => {
		setText(controlText(defaults, currency))
		setErrors({})
		onApply(defaults)
	}

	const input = (spec: FieldSpec) => {
		const id = `control-${spec.field}`
		const error = errors[spec.field]

		const shared = {
			id,
			value: text[spec.field],
			"aria-invalid": error ? true : undefined,
			"aria-describedby": error ? `${id}-error` : undefined,
		}

		return (
			<div className="control" key={spec.field}>
				<label htmlFor={id}>{spec.label}</label>
				{spec.type === "select" ? (
					<select {...shared} onChange={(event) => setText({ ...text, [spec.field]: event.target.value })}>
						{Object.values(UnitStage).map((stage) => (
							<option key={stage} value={stage}>
								{stage}
							</option>
						))}
					</select>
				) : (
					<input
						{...shared}
						type={spec.type}
						step={spec.step}
						inputMode={spec.type === "number" ? "decimal" : undefined}
						onChange={(event) => setText({ ...text, [spec.field]: event.target.value })}
					/>
				)}
				{error ? (
					<p id={`${id}-error`} className="control__error">
						{error}
					</p>
				) : null}
			</div>
		)
	}

	return (
		<section className="panel" aria-labelledby="controls-heading">
			<h2 id="controls-heading">Scenario controls</h2>
			<p className="panel__note">
				Each control sets one model input. Recalculate applies them all, and the figures come from{" "}
				<code>selectionEconomics</code> for the changed scenario.
			</p>
			<form className="controls" onSubmit={apply} noValidate>
				{groups.map((group) => (
					<fieldset key={group.legend}>
						<legend>{group.legend}</legend>
						{group.fields.map(input)}
					</fieldset>
				))}
				<div className="controls__actions">
					<button type="submit" className="button button--primary">
						Recalculate
					</button>
					<button type="button" className="button" onClick={restore}>
						Restore the scenario's values
					</button>
				</div>
			</form>
		</section>
	)
}
