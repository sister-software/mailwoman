# Hierarchy-evidence campaign (waves 2–4) — pre-registration

The consolidated campaign from the placetype-evidence design
(`docs/articles/plan/reference/placetype-evidence.mdx`): extend the proven pair-index mechanism
to the coverage its England/Wales source can't reach, add the first cross-locale placetype
entries (boroughs), fix the production decode-path gap the per-country gauntlet grading exposed,
and lay the census artifact's foundation. Operator-authorized 2026-08-01 ("do it all").

## Rungs, cheapest first (each independently shippable)

### R1 — the decode-path gap (code, no GPU, no new data)

The fixed gauntlet showed: with the en-GB overlay loaded, the bare classifier path
(`parseJSON`) recovers Woodley/Abbey Hey as `dependent_locality`, but the production geocode
path does NOT — comma'd rows classify as `structured_address` → formatted inputMode, and the
pair prior's segment path doesn't fire the same way. **Diagnose exactly which gate eats the
prior (inputMode? probeMode? the street-context gate?), then fix so the production path applies
the pair prior wherever the bare path does.**
**Bar**: the gauntlet GB dep-loc probes (china-red, paws-4-a-rest, bindulged as available) emit
the correct `dependent_locality` through `runOne` with the overlay; zero regressions on the
gated 47 + metamorphic + canaries. D-rule: locale-gated to en-GB/en-NZ paths.

### R2 — borough entries into PIX1 (data artifact, no GPU)

The ~211 WOF boroughs with their parents (NYC 5, London 33, …) appended to the pair artifacts —
the PIX1 tag byte already carries placetype. London boroughs enter `pair-index-gb.bin`; the US
entries wait for R5 (no en-us index ships until the tag is contextually alive — a perfect index
against a dead tag is zero, the v385 control's lesson).
**Bar**: byte-identity on every existing pair lookup (the additions are pure adds); the London
borough rows measurably recoverable on a held-out board; en-us untouched.

### R3 — pair-source extensions: London / NI / IE (data acquisition, no GPU)

PPD leaves CITY empty for London and covers England+Wales only. Acquire in the proven shape:

- **London neighbourhoods**: ONS/OS open data (candidate: OS Open Names populatedPlace →
  borough/London containment) → (neighbourhood, London) pairs.
- **NI**: an open NI gazetteer source (candidate: OSNI open data / Pointer address register's
  locality fields, licence permitting — licence check FIRST, counsel-dossier posture).
- **IE**: an eircode-free open source for (suburb/townland, post town) pairs (candidates:
  OSi/Tailte Éireann open data, logainm.ie licence permitting). IE pairs need an `en-IE` overlay
  package decision — an index needs a carrier (the NZ lesson).
  **Bar per source**: licence recorded → pairs validated on the probe-set rows that motivated them
  (Nine Elms, Clapham North, Islandmagee, Rialto, Portobello) → byte-identity for other locales.

### R4 — the census artifact v0 (design + builder, no GPU)

Per-node children-placetype distributions (projected per the placetype-evidence table), PIX-family
format, built from the WOF admin DB. v0 scope: the distribution data + a loader + an OFFLINE
probe (no decode wiring) measuring how often the census would have voted correctly on the
gauntlet dep-loc boards. Decode wiring is R5's call, informed by that measurement.

### R5 — the training rung (GPU; carries the banked country-tail bars)

Contextual tag aliveness (US dep-loc; any new-locale contexts from R3) via the conditional-bias
approach; whatever run this is ALSO carries the Addendum-3 country-tail bars (T1/T2/T3/B1) so
the venue mechanism gets its verdict without a dedicated launch — unless the parallel v4.1.3 run
(in flight at pre-registration time) already delivered it.

## Standing constraints

Positive evidence only; bias never mask; per-locale conventions gate expectations; every new
artifact provably inert for locales that don't carry it; licence checks precede any data pull
(the counsel-dossier posture); pre-registered bars before each rung's build.
