// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   A state machine as a pure transition function and a shell that applies its steps.
 *
 *   `transition(state, event)` decides a step: the next state, the values its carrier
 *   writes in the same write as the state, and the effects to run once that write lands,
 *   each described rather than performed and tagged with an {@link OperationEffect}.
 *   A test reads every step without a database or a network. {@link applyStep} writes a
 *   step through a {@link StateCarrier} with compare-and-set, so a step decided from a
 *   state another writer has since left is refused rather than written over it.
 */

import type { OperationEffect } from "#scripting/operation"

/**
 * A write a transition asks its shell to run after the state lands, described rather than performed.
 */
export interface MachineEffect<TKind extends string = string> {
	readonly kind: TKind
	/**
	 * What the write does to the world.
	 */
	readonly effect: OperationEffect
}

/**
 * What a transition decides from one state and one event.
 */
export interface Step<TState extends string, TRecord extends object, TEffect extends MachineEffect = MachineEffect> {
	readonly next: TState
	/**
	 * Values the carrier writes in the same compare-and-set as the state, such as a row's other columns.
	 * A key holding `undefined` leaves its column as it was.
	 */
	readonly record: Readonly<Partial<TRecord>>
	/**
	 * Writes to run, in order, once the state lands.
	 */
	readonly effects: readonly TEffect[]
}

/**
 * A machine's states and its pure transition function.
 */
export interface StateMachine<
	TState extends string,
	TEvent,
	TRecord extends object = Record<never, never>,
	TEffect extends MachineEffect = MachineEffect,
> {
	readonly name: string
	readonly states: readonly TState[]
	/**
	 * One event for each case the transition distinguishes, keyed by a label for that case.
	 *
	 * The effects register applies every event to every state to print the machine's
	 * transition table, and a test can assert the same table.
	 */
	readonly events?: Readonly<Record<string, TEvent>>
	/**
	 * The step from `state` on `event`.
	 *
	 * It reads only its arguments, and its caller performs every write.
	 */
	transition(state: TState, event: TEvent): Step<TState, TRecord, TEffect>
}

/**
 * Declares a machine, keeping its types for the shell and its tests.
 */
export function defineStateMachine<
	TState extends string,
	TEvent,
	TRecord extends object = Record<never, never>,
	TEffect extends MachineEffect = MachineEffect,
>(machine: StateMachine<TState, TEvent, TRecord, TEffect>): StateMachine<TState, TEvent, TRecord, TEffect> {
	return machine
}

/**
 * Where a machine's state is stored.
 *
 * `compareAndSet` writes `to` and the step's record only while the store still
 * holds `from`, and reports whether it wrote.
 */
export interface StateCarrier<TState extends string, TRecord extends object> {
	compareAndSet(from: TState, to: TState, record: Readonly<Partial<TRecord>>): Promise<boolean>
}

/**
 * How {@link applyStep} ended.
 *
 * - `unchanged`: the step keeps the state with an empty record and an empty effect list,
 *   and the carrier was not called.
 * - `applied`: the carrier wrote the step, and every effect ran.
 * - `conflict`: the store left `from` before the write.
 *   The row keeps the other writer's values, and the effects didn't run.
 *   The caller reads the state again and decides from it.
 */
export interface StepOutcome<TState extends string, TRecord extends object, TEffect extends MachineEffect> {
	status: "unchanged" | "applied" | "conflict"
	from: TState
	step: Step<TState, TRecord, TEffect>
}

/**
 * Whether a step leaves the store as it is: it keeps the state, its record holds
 * only `undefined`, and its effect list is empty.
 */
export function isNoopStep<TState extends string, TRecord extends object, TEffect extends MachineEffect>(
	from: TState,
	step: Step<TState, TRecord, TEffect>
): boolean {
	return step.next === from && Object.values(step.record).every((value) => value === undefined) && !step.effects.length
}

/**
 * Decides the step from `current` on `event`, writes it through `carrier`,
 * and runs its effects with `runEffect`.
 *
 * @throws When the step has effects and no `runEffect` was given, or
 * when an effect throws after the state landed.
 */
export async function applyStep<TState extends string, TEvent, TRecord extends object, TEffect extends MachineEffect>(
	machine: StateMachine<TState, TEvent, TRecord, TEffect>,
	carrier: StateCarrier<TState, TRecord>,
	current: TState,
	event: TEvent,
	runEffect?: (effect: TEffect) => Promise<void>
): Promise<StepOutcome<TState, TRecord, TEffect>> {
	const step = machine.transition(current, event)

	if (isNoopStep(current, step)) return { status: "unchanged", from: current, step }

	if (step.effects.length && !runEffect) {
		throw new Error(`${machine.name}: the step from ${current} to ${step.next} has effects and no runner`)
	}

	if (!(await carrier.compareAndSet(current, step.next, step.record)))
		return { status: "conflict", from: current, step }

	for (const effect of step.effects) {
		await runEffect!(effect)
	}

	return { status: "applied", from: current, step }
}
