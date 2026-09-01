# Filer linkage evaluation

This evaluation measures whether two registrants land in the same corporate family and how much of that answer depends
on a disclosed holding company. Predictions come from the shipped `familyRollup` reader over `filer_family`, where
corporate-family membership actually lives. `filer_cluster` is intentionally not used: it answers whether identifiers
refer to the same legal entity, not whether two entities share ownership.

Two builds run over the same authored corpus:

- `withheld` clears every `holdingCompany` before `buildFilerDatabase` sees the inputs. This is the product measurement.
- `control` keeps the disclosures. It must score perfectly, proving that the harness reads a surface the truth can reach.

Truth groups registrants whose holding-company names canonicalize to the same value using the builder's `mintFamilyID`
rule. The scored unit is the registrant rather than the FRN: FRNs sharing one `bdc_provider_id` are one legal entity and
must not appear as conflicting truth identities.

Management-company families are excluded from truth and prediction. Operational control is not ownership, that field is
not withheld, and allowing it to answer an ownership question would leak information from outside the experiment. The
corpus contains a shared-management-company pair so this exclusion is exercised rather than theoretical.

The authored cases, input projections, and truth construction live in `linkage-corpus.ts`. `linkage-eval.ts` owns only
the real scratch-database build, clustering, shipped-reader query, scoring, and report rendering.
