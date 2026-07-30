# The Lite artifact line — free channel vs subscriber channel (design)

2026-07-30. Operator + Claude. GTM item D1. Companion to D2, the public
[database products catalog](../../articles/licensing/data-products.md), which is the artifact
inventory this policy is applied to. The pricing page shipped first (PRs #1353 / #1355) and
already publishes the OEM band this doc's registration mechanic hangs off.

**No legal counsel exists on this project** (see `docs/superpowers/plans/counsel-dossier.md`).
This document defines policy and mechanics only. It does not draft license text, terms of
service, or a data-use agreement. Every place where an instrument would eventually have to be
written carries a **PENDING COUNSEL** marker, and each such marker gets a numbered entry in the
counsel dossier before anything ships.

## 1. What is actually being sold

Mailwoman's engine is AGPL and stays AGPL. The commercial license sells release from the
copyleft condition, not access to the code. Neither of those is a recurring cost to us, which is
the flaw in pricing them alone: a perpetual grant against a one-time build.

The recurring cost is the **data**. Rebuilding the admin gazetteer is a ten-minute build on top
of a multi-hour ingest, a verify gate, a swap, and a publish; poi.db is a four-country DuckDB
pass over a 13.68M-row Overture release; the situs shards are a 50-state ingest. Somebody has to
run those, grade them, and eat the R2 bill. That work is periodic, so a subscription is the
honest shape for it.

This is the MaxMind GeoLite motion, and it is worth naming the parts precisely rather than
gesturing at the brand:

1. The engine is free and open. Nothing about the data channel touches it.
2. There is a free data channel, on worse terms than the paid one, and the difference is a
   published, mechanical rule — not a quality knob we get to fiddle with.
3. The free channel requires **registration with a key**, which is how we learn who is embedding
   the thing and how we get a name to email.
4. The free channel requires **attribution**. The paid channel does not (beyond whatever the
   upstream data's own license demands, which no contract of ours can waive).

## 2. Delay, not degradation

The first design fork: does Lite differ from the subscriber artifact by being **older** or by
being **worse**?

**Decision: older.** Lite and subscriber are the same bytes at different times. There is one
build, one verify gate, one artifact, and two publish dates.

The argument against degradation is operational, not philosophical. A degraded artifact is a
second product line: a second build recipe, a second verify baseline, a second set of eval
numbers, a second thing to regress. Worse, "degraded" has no natural stopping point — every
support conversation becomes an argument about whether a given miss is the degradation or a bug.
A delayed artifact has neither problem. Its quality is exactly the quality we already graded and
published, and "how far behind is it" is a subtraction anyone can do.

It also matches what the data actually is. An address register is a moving record of the world.
The value in paying is having this quarter's buildings, not a secret better version of last
quarter's.

### 2.1 The cadence proposal

|             | Lite channel                                             | Subscriber channel                           |
| ----------- | -------------------------------------------------------- | -------------------------------------------- |
| Cadence     | the subscriber artifact, republished on a delay          | weekly, where the upstream supports it       |
| Delay       | **90 days** (proposed; operator's call)                  | none                                         |
| Price       | free                                                     | included in the commercial license and above |
| Access      | keyed registration, self-serve                           | keyed, issued with the license               |
| Attribution | required (§4)                                            | upstream obligations only                    |
| Coverage    | identical to the subscriber artifact of the same version | current                                      |
| Support     | none; community issues only                              | per the license tier                         |

Two honesty constraints on the "weekly" claim, both of which have to be true before it is
published anywhere customer-facing:

- **Weekly is a ceiling set by upstream, not a promise per artifact.** Overture releases
  monthly-ish; WOF changes continuously; TIGER is annual; BAN is frequent; the FCC BDC vintage
  is biannual. An artifact cannot be fresher than its source. The subscriber commitment is
  therefore "we publish within one week of a source release we ingest," not "a new artifact
  every Monday." Per-artifact source cadence belongs in the catalog page, one column, verified.
- **The cadence claim is currently unbacked by machinery.** Today the gazetteer is rebuilt when
  the operator rebuilds it (`RELEASING.md`: "Rebuilt periodically as WOF upstream changes"), and
  the HF dataset card has not been touched since 2026-05-28. A published weekly commitment
  without a scheduled build is a promise we would immediately break. §7 makes the scheduled
  build a prerequisite, not a follow-up.

### 2.2 What the delay is measured against

The delay is measured on the **artifact version**, which is already a date on every published
path (`gazetteer/2026-07-07a/candidate.db`, `poi/2026-07-20a/poi.db`,
`street/fr/2026-07-10/situs.db`). No schema change and no new field: an artifact becomes Lite by
being re-published under the Lite prefix once its version date is 90 days old. The layer
manifest's `version` and `source_vintage` already tell a consumer exactly how stale their copy
is, which means a Lite user can always answer "how far behind am I" from the file itself,
offline. That property is worth protecting — do not move the channel into the manifest, because
then the same bytes would need two manifests and the two would drift.

## 3. Keyed registration

A key is a **relationship instrument and a telemetry instrument**. It is explicitly not a
license-enforcement instrument, and the docs must say so in those words, because the AGPL grant
on everything already published is irrevocable and the pricing page publishes that commitment
("Published releases stay published").

### 3.1 What a key buys us

- **A name.** An email address and a company, attached to a download. Today an embedder is
  invisible until they file an issue. This is the entire GeoLite mechanic: MaxMind's free tier
  is a lead list that also happens to be a useful product.
- **Volume and shape.** Which artifacts, which versions, how often, roughly how many
  distinct downloaders. Enough to answer "is anyone actually using the FR shard" without
  instrumenting anyone's runtime.
- **A notification channel.** When an artifact is rebuilt because the previous one had a bug
  (the #1015 class), we currently have no way to tell anyone.

### 3.2 What a key must never do

- **Never phone home from the runtime.** The key is presented at **download** time and nowhere
  else. Mailwoman parses and geocodes in-process against local files; that stays true, and the
  privacy page's architectural claim must not be weakened by this feature. A sealed artifact
  keeps working forever with no key, no network, and no expiry.
- **Never expire an artifact.** A lapsed key stops future downloads. It does not disable, phase
  out, or degrade a copy already on disk. There is no kill switch, and adding one later would
  contradict a published commitment.
- **Never gate the engine.** npm installs stay keyless.

### 3.3 Mechanics

The publish path today is Cloudflare R2 behind `public.sister.software`, unauthenticated, with a
WAF rule that blocks full-file downloads of byte-ranged `.db` objects so the demo's range
requests survive without paying for whole-file egress. The channel split rides that same
infrastructure:

- **Two prefixes.** `lite/` and `subscriber/` under the existing artifact layout. Everything
  else — dated immutable paths, byte-range access, immutable `Cache-Control` — is unchanged.
- **The demo keeps its own path.** The docs demo range-loads `candidate.db` and `poi.db` from
  the public prefix with no key. That is a first-party use of our own artifact and must not
  break; it is also the reason the split cannot be "authenticate everything."
- **Key check at the edge.** A key presented on the request, validated by a Worker, granting a
  short-lived signed URL for the subscriber prefix. The Lite prefix takes a key too, but issues
  one self-serve on a form.
- **Issuance and rotation.** Self-serve for Lite; issued with the license for subscribers; both
  rotatable by the holder. Revocation exists for abuse (a key republished on a torrent), and
  revoking one never touches artifacts already downloaded.
- **Telemetry scope.** Key id, artifact, version, timestamp, coarse request origin. No IP
  retention beyond the edge log's own window, and no attempt to fingerprint an end user. The
  privacy page needs a section for this before the endpoint exists, not after.

> **PENDING COUNSEL — L1.** The registration form collects a name, an email, and a company, so
> it is a personal-data collection under GDPR/CCPA, however small. What notice text must appear
> at the point of collection, what retention period applies to the download log, and does the
> existing privacy page's "we architecturally do not collect" framing need a carve-out written
> rather than an edit? File in the counsel dossier before the form goes up.

> **PENDING COUNSEL — L2.** The instrument the Lite key is issued under. It is not the AGPL
> (that governs code we wrote, not data we compiled), and it is not the commercial license. It
> needs to be some short data-use notice that carries the attribution condition of §4 and the
> no-redistribution-of-the-subscriber-artifact expectation, and it needs to sit correctly on top
> of the upstream licenses in §5. Drafting that text is the counsel task; this document only
> specifies what it must accomplish.

## 4. Attribution

The Lite channel requires visible attribution to Mailwoman; the subscriber channel does not.
This is the GeoLite trade in its clearest form, and it is the part most likely to be
misunderstood internally, so state the two layers separately:

**Layer 1 — the upstream data's own attribution.** Non-negotiable, channel-independent, and not
ours to sell. WOF, Overture (CDLA-Permissive-2.0), GeoNames (CC-BY 4.0), and BAN (Licence
Ouverte 2.0) each require attribution from anyone who redistributes their data, and paying us
does not release anyone from that. The catalog page lists these per artifact. Any marketing that
implies the subscriber tier removes attribution entirely is false and must be corrected.

**Layer 2 — our own attribution condition on the Lite channel.** A visible credit wherever the
artifact's output is user-facing, in the "geocoding by Mailwoman" shape. The subscriber tier
waives this one, because this one is genuinely ours to waive.

> **PENDING COUNSEL — L3.** Whether we can attach an attribution condition to a compiled
> artifact whose upstream inputs are public domain or CC0, and if so on what basis (database
> compilation right in the EU vs. contract in the US — likely a different answer per
> jurisdiction). The working assumption is that the condition rides the **download agreement**,
> not a claim of copyright over the facts. That assumption is exactly what needs checking, and
> it is the load-bearing one for the entire Lite line.

> **PENDING COUNSEL — L4.** The exact WOF license, because the repo contradicts itself. The
> licensing pages say **CC0**; `resolver-wof-sqlite/README.md` and the Hugging Face dataset card
> say **CC-BY 4.0**; `THIRD_PARTY_NOTICES.md` says WOF draws on several sources with their own
> licenses. If WOF is CC-BY, the gazetteer carries a standing attribution obligation in _both_
> channels and the data-provenance table is wrong. Resolve this before publishing an attribution
> policy that depends on it. (This is a fact-finding task first and a counsel task second — the
> upstream's own license page may settle it without a lawyer.)

## 5. What is gateable, and what is not

The rule is one sentence: **an artifact can enter the two-channel line only if every upstream
source folded into it is permissive.** A share-alike source makes the artifact's redistribution
terms not ours to set, so gating it would be both unenforceable and misleading.

### 5.1 Gateable — permissive upstreams only

| Artifact                                   | Upstreams                                      | Their terms                                                          |
| ------------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------- |
| Admin/candidate gazetteer (`candidate.db`) | WOF, Overture divisions, GeoNames, Census ZCTA | CC0-or-CC-BY (see L4), CDLA-Permissive-2.0, CC-BY 4.0, public domain |
| `poi.db`                                   | Overture Places                                | CDLA-Permissive-2.0 (attribution)                                    |
| US situs shards                            | Overture addresses, OpenAddresses              | CDLA-Permissive-2.0; OA is per-source — see the caveat below         |
| US interpolation shards                    | Census TIGER/Line                              | public domain                                                        |
| FR situs shard                             | BAN                                            | Licence Ouverte 2.0 (we elect this over BAN's dual ODbL)             |
| `un-locode.db`                             | UNECE UN/LOCODE code list                      | public domain                                                        |
| Neural weights bundles                     | corpus filtered with `--exclude-share-alike`   | permissive by construction                                           |
| `bdc.db` (planned)                         | FCC BDC availability filings                   | US government public record                                          |

Two caveats that are not optional:

- **OpenAddresses is not a license, it is an aggregator.** Its collection mixes CC0, CC-BY, OGL,
  and ODbL/CC-BY-SA rows, per-source. The US situs line currently rests on a **measurement**: a
  2026-06-14 audit found the US Overture address set to be NAD (68%, US public domain) plus
  OpenAddresses (32%, government open data) with **zero** ODbL rows, which is why the build
  applies no license filter. A measurement is the right basis for a decision and the wrong basis
  for a standing product. Before the US situs shards enter the line, that audit becomes a
  build-time filter over the per-row `source` column, with a test, so a future Overture release
  that quietly adds an ODbL contributor fails the build rather than the gate.
- **The corpus filter is the precedent to copy.** `SHARE_ALIKE_PATTERN` /
  `--exclude-share-alike` already does exactly this job on the training side, and it is why the
  weights are clean. The artifact side needs the same discipline, wired to the per-row `source`
  column the address-point schema already carries.

### 5.2 Not gateable — share-alike, stays ungated and opt-in

| Artifact                              | Why                                                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| OSM rooftop shards (`osm/`)           | ODbL. Already publish-blocked pending counsel; a paid channel would be the wrong direction of travel.                                 |
| OSM-derived POI/infrastructure layers | ODbL. The layer contract already puts these at `build-local`: we ship the builder, the user builds on their own disk.                 |
| Overture `base`-theme derivatives     | ODbL. Overture does not launder OSM's license.                                                                                        |
| `timezone.db`                         | timezone-boundary-builder is ODbL; attribution and share-alike apply to the built database. The builder ships; the database does not. |

The reasoning, stated once so it does not get re-litigated per artifact: ODbL share-alike on a
Derivative Database means every recipient may redistribute it under the same terms. A paid gate
on such an artifact is unenforceable by construction, and worse, charging for it signals to the
buyer that they have bought something exclusive when they have bought a copy of something they
are obliged to pass on. The `build-local` tier already exists precisely to avoid that, and it
stays the answer.

**`nuts.db` is unresolved.** The repo records an attribution string (© EuroGeographics) for
Eurostat GISCO NUTS boundaries and no license identifier at all. Until the actual terms are
determined it is neither gateable nor confidently ungateable — it is unknown, and unknown means
it does not enter the line.

> **PENDING COUNSEL — L5.** Eurostat GISCO NUTS boundary terms (the EuroGeographics component in
> particular), and whether a compiled `nuts.db` may be redistributed at all. Fact-finding first.

> **PENDING COUNSEL — L6.** Whether a _permissively-sourced_ artifact built in the same build
> system as ODbL artifacts stays clean — i.e. confirm there is no argument that co-location in
> one pipeline, one data root, or one publish path creates a derivative-database relationship.
> The architecture already assumes not (data-provenance's four quarantine mechanisms); this asks
> counsel to confirm the assumption rather than discover it later.

## 6. What the Lite line explicitly does not do

Standing constraints. Each exists because its opposite is a commitment we would have to break
later, and the pricing page already publishes durable commitments we intend to keep.

1. **No retroactive withdrawal.** An artifact published on the Lite channel stays published at
   that URL. Immutable dated paths make this the default; do not add a cleanup job that violates
   it.
2. **No silent quality difference.** If the two channels ever diverge in anything but date, that
   difference is documented on the catalog page before it ships.
3. **No runtime metering.** Restated from §3.2 because it is the single claim most likely to be
   eroded by a well-meaning feature request.
4. **No gating of anything AGPL.** The weights bundles ship on npm under the same dual license
   as the code and stay there. If a weights bundle ever enters the Lite line it does so as an
   _additional_ distribution channel, never as a replacement for the npm package.
5. **No third channel.** Two channels, one rule. An "academic tier" or a "startup tier" is a
   discount on the subscriber channel, not a new artifact line.

## 7. Prerequisites, in order

Nothing here ships as one change. The order matters because the early items are the ones that
make the later claims true.

1. **Resolve the WOF license question (L4).** Fact-finding. Blocks any published attribution
   policy touching the gazetteer.
2. **Publish the catalog page (D2).** Already drafted alongside this doc. The Lite line is
   meaningless without a public inventory naming each artifact and its tier.
3. **Build the share-alike filter for situs shards.** Per-row `source`-column filter with a
   test, mirroring the corpus-side `--exclude-share-alike`. Until it lands, the US situs line
   stays out of §5.1.
4. **Put the artifact builds on a schedule.** A cadence claim needs a scheduled build behind it.
   This is the largest item and the one most likely to be underestimated.
5. **Stand up the key issuance + edge check.** Worker, form, download log. Gated on L1.
6. **Write the instruments.** L2 and L3, with counsel, once there is counsel.
7. **Publish the channel terms** on the pricing page's OEM section and the catalog page.

Steps 1–4 are ours and need no lawyer. Steps 5–7 are the ones that stall, which is the argument
for doing 1–4 first regardless of when counsel appears.

## 8. Open questions for the operator

1. **Is 90 days the right delay?** It is a proposal, not a finding. Shorter makes Lite a real
   product and weakens the subscription; longer makes Lite a demo. MaxMind's GeoLite equivalent
   differentiates on accuracy rather than delay, so there is no directly comparable number to
   copy.
2. **Does the OEM band get its own channel behavior?** The pricing page bands OEM by customer
   reach. Whether an OEM's _end customers_ need their own keys, or whether the OEM redistributes
   under one key, is a mechanic that changes the Worker design. Cheapest answer: the OEM's key
   covers their redistribution, and their customers never see ours.
3. **Which artifact goes first?** `poi.db` is the cleanest candidate — one permissive upstream,
   a manifest that already records tier and license, a version already on a dated path, and no
   OpenAddresses caveat. The gazetteer is the most valuable but carries L4.
4. **Does the free channel need a coverage floor?** If Lite is 90 days behind, an artifact
   rebuilt less often than every 90 days makes Lite and subscriber identical, and the tier
   collapses for that artifact. That is fine and honest, but it should be stated rather than
   discovered.

## See also

- [Database products catalog](../../articles/licensing/data-products.md) — the artifact
  inventory this policy applies to (D2).
- [Pricing](../../articles/licensing/pricing.mdx) — the published tiers and the OEM band.
- [Data licensing & provenance](../../articles/licensing/data-provenance.md) — the per-source
  license table and the ODbL boundary this document's §5 rule is derived from.
- [Spatial-layer contract](../../articles/plan/reference/layer-contract.mdx) — the
  shipped/build-local/private tiers.
- `docs/superpowers/plans/counsel-dossier.md` — where every PENDING COUNSEL marker above is
  filed.
