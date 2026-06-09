# Phase 0 — Foundation

**Goal:** lock the contracts (schema, classifier interface, policy, locale) before writing any model code. Refactor existing rule classifiers to use the new interface with zero behavior change.

**Duration estimate:** 1 week.

**Branch:** `neural/phase-0-foundation`

## Pre-flight checks

- [ ] Mailwoman main branch checked out at latest commit
- [ ] `npm test` passes on a clean clone
- [ ] You have read `README.md`, `reference/CONTEXT.md`, `reference/ARCHITECTURE.md`, `reference/SCHEMA.md`, `reference/INTERFACES.md`, `reference/OPERATIONS.md`

## Tasks

### 1. Monorepo restructure

Current Mailwoman is a single TypeScript project. Migrate to a workspaces layout.

- [ ] Set up `pnpm` workspaces (preferred) or yarn workspaces (Mailwoman currently uses yarn — verify and stick with it).
- [ ] Create `packages/core/` and move existing `core/`, `utils/`, `commands/`, `solvers/`, `filters/` into it. Keep import paths working via package.json `exports`.
- [ ] Create `packages/classifiers/` and move existing `classifiers/` into it. Depends on `@mailwoman/core`.
- [ ] Update root `package.json`, `tsconfig.json`, `vitest.config.ts` to be workspace-aware.
- [ ] Verify `npm test` still passes. No behavior change yet.

**Success:** all existing tests pass, `cli.ts` still works, `sdk/` still exports the same surface.

### 2. Schema implementation

Implement `reference/SCHEMA.md` in code.

- [ ] Create `packages/core/src/types/component.ts` with `COMPONENT_TAGS`, `ComponentTag`, `BIO_LABELS`, `BioLabel` as specified.
- [ ] Add unit tests in `packages/core/test/component.test.ts`:
  - Every tag appears exactly once in `COMPONENT_TAGS`
  - `BIO_LABELS` has correct length (1 + 2 × tags)
  - `BioLabel` type narrows correctly
- [ ] Export from `packages/core/src/index.ts`.

**Success:** schema is the single source of truth, importable as `import { ComponentTag } from '@mailwoman/core'`.

### 3. ClassificationProposal and Classifier interfaces

Implement `reference/INTERFACES.md`.

- [ ] Create `packages/core/src/types/classifier.ts` with `ClassificationProposal`, `Classifier`, `ClassifierContext`.
- [ ] Create `packages/classifiers/src/adapter.ts` with `wrapLegacyClassifier`.
- [ ] For every existing rule classifier in `packages/classifiers/src/`, write a wrapper that adapts its output to `ClassificationProposal`. Do not change the rule logic itself.
- [ ] Add unit tests verifying each wrapped classifier produces output equivalent to the pre-wrap output (modulo the new `source` and `source_id` fields).

**Success:** every rule classifier emits `ClassificationProposal[]`. The solver code is updated minimally to consume the new shape but produces identical solutions.

### 4. Policy registry

Implement `ClassifierPolicy` and `PolicyRegistry`.

- [ ] Create `packages/core/src/policy.ts` with the types from `reference/INTERFACES.md`.
- [ ] Create `packages/core/src/policy-defaults.ts` — a default policy table where every component is `rule_only`.
- [ ] Wire the registry into the solver path: before solving, filter proposals through `PolicyRegistry.apply()`.
- [ ] Unit tests: policy filtering is correct for each mode.

**Success:** policy registry exists, defaults to current behavior (rule-only everywhere), is the single place a future migration to neural will edit.

### 5. Locale profile

Implement `LocaleProfile` and `LocaleRegistry`.

- [ ] Create `packages/core/src/locale.ts` with the types from `reference/INTERFACES.md`.
- [ ] Create `packages/core/src/locales/en-us.ts` and `packages/core/src/locales/fr-fr.ts` with initial profiles.
  - `en-US`: all current US-applicable rule classifiers, components `country, region, locality, postcode, house_number, street, street_prefix, street_suffix, unit, venue, attention, po_box, intersection_a, intersection_b`.
  - `fr-FR`: rule classifiers that apply to FR (most of the universal ones), components above plus `cedex, street_prefix_particle, dependent_locality`.
- [ ] Wire locale into `ClassifierContext` and the classification loop. If no locale is provided, all classifiers with `locales: ['*']` plus all registered locales' classifiers run (backward compat with current behavior).
- [ ] Unit tests: locale filtering works, profiles register correctly.

**Success:** the system has a concept of locale. Default behavior is unchanged. Setting a locale narrows the active classifiers.

### 6. CLI flag passthrough

- [ ] Add `--locale <bcp47>` flag to `cli.ts`. When set, passes through to classification.
- [ ] Unit test: `npx mailwoman parse --locale en-US "..."` works.

### 7. Documentation

- [ ] Update root `README.md` with a section on the new architecture. Brief, links to plan docs.
- [ ] Update `docs/` (if it exists) with the new component schema as a reference table.

### 8. Forward-compat sanity check

Before declaring Phase 0 done, verify the design handles Phase 6 (Japan) cleanly:

- [ ] Mentally add a `ja-JP` `LocaleProfile` with `componentsSupported: ['prefecture', 'municipality', 'district', 'block', 'sub_block', 'building_number', 'building_name', 'country', 'postcode']` (no `street`, no `house_number`).
- [ ] Does any core code break? It shouldn't. If it does, the abstraction is wrong — fix it now, not in Phase 6.
- [ ] Verify by running the test suite with a hypothetical JP profile registered (you don't need actual JP classifiers; just verify the registration doesn't throw and the type system is happy).

## Success criteria checklist

Before tagging `neural-phase-0-complete`:

- [ ] `npm test` passes across all workspaces
- [ ] `npm run lint` clean
- [ ] `npx mailwoman parse "Mt Tabor Park, 6220 SE Salmon St, Portland, OR 97215, USA"` produces output equivalent to pre-refactor
- [ ] `npx mailwoman parse --locale fr-FR "8 rue de la République, 75008 Paris, France"` runs without error (output quality not yet judged — that's Phase 2+)
- [ ] Forward-compat JP check passes
- [ ] `LOG.md` has entries for each task
- [ ] `DECISIONS.md` records any non-obvious choices
- [ ] Branch is merged to main, tagged

## Things that look like Phase 0 but aren't

These are tempting in Phase 0; resist:

- ❌ Writing any neural code. `packages/neural/` doesn't exist yet.
- ❌ Building any corpus adapters. `packages/corpus/` doesn't exist yet.
- ❌ Adding new rule classifiers for FR-specific concepts. That's Phase 1 work, after corpus exists to validate against.
- ❌ Optimizing the solver. Don't change behavior in Phase 0; only refactor.

## When to call this phase done

When you can demonstrate: "the system runs identically to before, but every classifier output flows through a typed, locale-aware, policy-gated pipeline ready for a neural classifier to plug into."
