# #655 option 2 — a cross-source weak-label scorer has no non-circular anchor (the gate is blocked)

_Feasibility analysis, not a measurement. #655 option 2 proposes a learned cross-source link scorer
trained on a weak-label pipeline. Before building it, we check the gate it was explicitly conditioned
on — "can we build cross-source weak labels?" — and find we cannot, for a structural reason in the
data. This documents why, so the idea isn't re-tread without a new data source._

## The question

The dedup (within-NPPES) matcher has a learned scorer (the GBT, #603) because it has clean ground
truth: the NPI groups records, so labels are free. Cross-**source** matching (NPPES ↔ FCC RHC ↔ TX
HHSC) has no such key — that is the whole difficulty, and the reason FS is **pinned** for cross-source
by design (#664 showed a re-thresholded GBT can't beat it there). Option 2 asks: could a _weak-label_
pipeline manufacture enough signal to train a cross-source scorer anyway?

A weak-label pipeline is only useful if the labels come from a signal **independent** of the features
the scorer will use. Otherwise it is circular — the scorer just learns to imitate whatever produced
the labels.

## What the sources actually share

Inspecting the raw headers of every source in the matcher's catalog:

| source | rows' identity key | shares a clean strong ID? |
|---|---|---|
| NPPES registry | **NPI** (+ EIN, taxonomy) | — |
| FCC RHC posted-services (71 cols) | FCC HCP number | **no** NPI / EIN / TIN / tax-ID field |
| FCC RHC commitments (53 cols) | Participating HCP number | **no** NPI / EIN / TIN / tax-ID field |
| TX HHSC nursing facilities (43 cols) | TX license number | **no** NPI / EIN / TIN / tax-ID field |

NPPES is the **only** source carrying a clean strong identifier (NPI, EIN). The FCC and TX sources
key on their own program-internal IDs and carry no crosswalk back to NPI/EIN. The fields shared
across all sources reduce to: **organization name**, **address / geocode**, and **phone**.

## Why each candidate weak-label source fails

- **Name + address/geocode** — these are precisely the features the Fellegi-Sunter scorer already
  uses. Weak labels drawn from agreement on them, fed to a scorer over the same features, is
  **circular**: the model learns to reproduce FS. This is the mechanism behind #664's result — the
  GBT, re-thresholded over the FS feature vector, has nothing independent to add cross-source.
- **Phone** — shared across all sources, and the one candidate _independent_ signal. But #625
  established NPPES phone is an **unreliable** secondary identifier: institutional switchboard lines
  are shared by many distinct providers, so phone agreement over-links. A scorer trained on
  phone-anchored weak labels would learn to over-link on the switchboard noise — worse than FS, not
  better.
- **An external crosswalk** (an NPI↔HCP or EIN↔license table) — would give clean labels, but none
  exists in the data we hold, and sourcing one is a data-acquisition task, not a modeling one.

## Conclusion

**The gate #655 option 2 was conditioned on does not open with the current data.** There is no
cross-source signal that is both _strong enough_ to label and _independent_ of the features a scorer
would use. So FS stays pinned for cross-source — that is a property of the data (no shared clean key),
not a modeling shortfall. The honest move is to record this rather than run a circular experiment that
would post a misleadingly-positive number.

**What would change the answer:** a new source carrying a shared strong identifier (an NPI or EIN that
also appears in the FCC/TX records, or a published crosswalk). With that, the weak-label pipeline
becomes viable — train a geocode+name scorer to predict the strong-ID matches, then apply it to the
records that lack the strong ID. Until such a source exists, option 2 is blocked. Recommend closing
#655 with this finding (option 1 was answered by #664; option 2 is data-blocked).

_Neutral entity-resolution framing: this is about whether two records denote the same organization,
nothing about what that resolution implies._
