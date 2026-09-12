"""Counting what the corpus on the volume actually teaches, to settle an open question.

    modal run -m launch.train_remote::diagnose_corpus --corpus-dir=…
    modal run -m launch.train_remote::country_census_raw --corpus-dir=…
    modal run -m launch.train_remote::digit_prior --config-name=<recipe>.yaml
    modal run -m launch.train_remote::piece_prior --config-name=<recipe>.yaml

These differ from `launch/audits.py` in what they are for: an audit produces a receipt a launch
requires, and a census answers a question nobody has a receipt for yet. Two disciplines hold across
all four. Each counts by pulling rows through the LOADER the trainer uses rather than reading
parquet and reimplementing the sampler — reimplementing it is how the first digit count went wrong
— except `country_census_raw`, which reads raw parquet precisely because the loader is the thing
under suspicion. And each prints the census BEFORE the conditional table, so a country with no rows
reads as "no data" rather than "a probability of zero".
"""

from __future__ import annotations

from .app import VOL_MOUNT, app, training_image, vol

#: The recipes live beside the training package on the volume; a census reads the one that trained
#: the model it is asking about, not a local copy.
CONFIGS = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/configs"


@app.function(
    volumes={VOL_MOUNT: vol},
    image=training_image,
    timeout=600,
)
def diagnose_corpus(
    corpus_dir: str = "/data/corpus/versioned/v0.4.0/corpus-v0.4.0",
    verify_country: str = "",
    verify_source: str = "",
) -> None:
    """Check which corpus slices the data loader actually sees on the Modal volume.

    Pass ``--corpus-dir`` to point at an overlay. Pass ``--verify-country DE --verify-source
    synth-german`` to additionally PULL a few rows through the real filter and confirm they survive
    — a slice whose rows are all filtered out is a run that trains on nothing and reports success.
    This is the pre-launch "verify the loader sees the slice, THEN launch" check.
    """
    import json
    import random
    import sys
    from collections import Counter
    from pathlib import Path

    vol.reload()  # see slices committed after this container started
    sys.path.insert(0, f"{VOL_MOUNT}/corpus-python/src")

    corpus_root = Path(corpus_dir)
    manifest = corpus_root / "MANIFEST.json"

    print(f"Corpus dir: {corpus_root}")
    print(f"Manifest exists: {manifest.exists()}")

    if manifest.exists():
        data = json.loads(manifest.read_text())
        train_slices = [s for s in data.get("slices", []) if s.get("split") == "train"]
        print(f"MANIFEST: {len(train_slices)} train slices, {sum(s['rows'] for s in train_slices):,} rows")

        existing = sum(1 for s in train_slices if Path(s["path"]).exists())
        missing = len(train_slices) - existing
        print(f"Train slice files: {existing} exist, {missing} missing")
        if missing > 0:
            for s in train_slices:
                if not Path(s["path"]).exists():
                    print(f"  MISSING: {s['path']}")
                    break

    from mailwoman_train.data.loader import _slice_first_source, _slice_paths

    paths = _slice_paths(corpus_root, "train")
    print(f"\n_slice_paths returned {len(paths)} train slices")

    by_source: Counter[str] = Counter()
    errors = 0
    for p in paths:
        if not p.exists():
            errors += 1
            continue
        try:
            src = _slice_first_source(p)
            by_source[src] += 1
        except Exception as exc:  # noqa: BLE001
            errors += 1
            if errors <= 3:
                print(f"  ERROR reading {p}: {exc}")

    print(f"\nSource index ({errors} errors, {sum(by_source.values())} readable):")
    for src, count in by_source.most_common():
        print(f"  {src:35s} {count:4d} slices")

    # Pre-launch verification: do rows of the target country/source actually survive the filter?
    if verify_country or verify_source:
        from mailwoman_train.data.loader import iter_rows
        from mailwoman_train.labels import locale_id

        cw = {c: 1.0 for c in (verify_country.split(",") if verify_country else ["US", "FR", "DE"])}
        sw = {verify_source: 1.0} if verify_source else None
        rows = list(
            iter_rows(
                corpus_root,
                "train",
                rng=random.Random(0),
                country_weights=cw,
                source_weights=sw,
                coarse_filter=True,
                row_limit=5,
            )
        )
        print(f"\n[verify] rows passing filter (country={cw}, source={sw}): {len(rows)}")
        for r in rows[:3]:
            print(f"  country={r['country']} locale_id={locale_id(r['country'])} raw={r['raw'][:60]}")
        if not rows:
            print("  !! ZERO rows — the run would train on nothing. Do NOT launch.")


@app.function(
    volumes={VOL_MOUNT: vol},
    image=training_image,
    timeout=1800,
)
def country_census_raw(
    corpus_dir: str = "/data/corpus/versioned/v0.10.9-fr-fragment/corpus-v0.10.9-fr-fragment",
    rows: int = 300000,
) -> None:
    """Which countries the corpus CONTAINS, before any filter touches it.

    Reads the country column out of the raw parquet rather than going through `iter_rows`, because
    the loader is the thing under suspicion whenever this is asked. The question it settles has a
    shape worth recognising: a country whose rows the filter drops and a country the corpus never
    had are indistinguishable downstream, and only one of them is a bug.

    The shape that produced it: `country_weights` in 44 configs carried an unquoted `NO: 1.0`. YAML
    1.1 parses the bare token `NO` as the BOOLEAN false, so the dict key is `False`, and the loader's
    `country_weights.get("NO")` answers None — every Norwegian row silently dropped.
    """
    import sys
    from collections import Counter
    from pathlib import Path

    import pyarrow.parquet as pq

    vol.reload()
    sys.path.insert(0, f"{VOL_MOUNT}/corpus-python/src")

    from mailwoman_train.data.loader import _slice_paths

    slices = _slice_paths(Path(corpus_dir), "train")
    print(f"train slices: {len(slices)}")

    counts: Counter[str] = Counter()
    by_source: dict[str, Counter[str]] = {}
    seen = 0
    for sh in slices:
        pf = pq.ParquetFile(sh)
        for batch in pf.iter_batches(batch_size=8192, columns=["country", "source"]):
            cc = batch.column("country").to_pylist()
            ss = batch.column("source").to_pylist()
            for c, s_ in zip(cc, ss, strict=True):
                counts[c] += 1
                if c in ("NO", "NZ", "PL"):
                    by_source.setdefault(c, Counter())[s_] += 1
            seen += len(cc)
        if seen >= rows:
            break

    total = sum(counts.values())
    print(f"\nRAW rows scanned (pre-filter): {total:,}\n")
    print("  country   rows        share")
    for c, n in counts.most_common(22):
        print(f"    {str(c):<6s} {n:>9,}   {n / total:.4f}")

    print("\n  THE PROBE — countries the filter is suspected of dropping:")
    for c in ("NO", "NZ", "PL"):
        n = counts.get(c, 0)
        verdict = "PRESENT -> the filter is eating real data" if n else "ABSENT  -> genuine acquisition gap"
        print(f"    {c}: {n:,} raw rows   {verdict}")
        for src, k in (by_source.get(c) or Counter()).most_common(5):
            print(f"        via {src}: {k:,}")

    # COMPLETENESS AUDIT — corpus countries vs the config's admitted set. The Norway bug was ONE
    # silent drop; this asks what else. Two failure modes:
    #   (a) present-but-dropped: rows in the corpus, absent from country_weights -> silently trained on nothing.
    #   (b) admitted-but-absent: in country_weights, ~zero corpus rows -> the config promises a locale it can't deliver.
    import yaml as _yaml

    cfg_path = f"{CONFIGS}/v3.1.0-fr-fragment.yaml"
    try:
        cw = _yaml.safe_load(open(cfg_path))["data"]["country_weights"]
        admitted = {k for k in cw if isinstance(k, str) and (cw[k] or 0) > 0}
        present = {c for c, n in counts.items() if n > 0 and c not in ("ZZ", None)}
        print(
            "\n  === COMPLETENESS AUDIT (this scan is a SAMPLE — absence here is 'not seen', not 'not in corpus') ==="
        )
        print("  (a) present-but-dropped (corpus rows, NOT admitted by config):")
        for c in sorted(present - admitted, key=lambda c: -counts[c]):
            print(f"        {c}: {counts[c]:,} rows  -> SILENTLY DROPPED")
        if not (present - admitted):
            print("        (none in this sample)")
        print("  (b) admitted-but-not-seen (in config, 0 rows in THIS sample — verify against full corpus):")
        for c in sorted(admitted - present):
            print(f"        {c}: 0 rows seen")
        print(f"  ZZ (unknown-country placeholder): {counts.get('ZZ', 0):,} rows — correctly dropped, not a bug")
    except Exception as e:  # noqa: BLE001
        print(f"  [audit skipped: {e}]")


@app.function(
    volumes={VOL_MOUNT: vol},
    image=training_image,
    timeout=3600,
)
def digit_prior(
    corpus_dir: str = "/data/corpus/versioned/v0.10.9-fr-fragment/corpus-v0.10.9-fr-fragment",
    config_name: str = "v3.1.0-fr-fragment.yaml",
    rows: int = 400000,
    seed: int = 42,
) -> None:
    """Which tag owns a bare digit-bearing token, as the SAMPLER draws it?

    The question is whether the model's `39A -> postcode` habit contradicts its training prior or
    reflects it. A previous count said P(house_number | bare digit)=0.810 vs P(postcode|·)=0.101 —
    but that was ONE synthetic slice, read off disk, unweighted. The prior the model actually sees
    is the WEIGHTED multinomial over ~700 slice refs, after the country filter, the coarse filter,
    and the augmentations. Those are not decorations: `augment_glue_prob` alone rewrites token
    boundaries, which is the thing under investigation.

    So this pulls rows through `iter_rows` — the same entry point the trainer uses, with the config's
    own weights — rather than reimplementing the sampler.

    Reports P(tag | token) for two families:
      - BARE digit-ish tokens matching `\\d+[A-Za-z]?` (39A, 121, 44B).
      - By token SHAPE, so `5` / `39A` / `1234` / `75008` are not averaged into one number. A
        4-digit token in NL and a 5-digit token in FR are different questions.

    Also reports the CONTEXT split: same token, with vs without a street designator in the row.
    """
    import random
    import re
    import sys
    from collections import Counter, defaultdict
    from pathlib import Path

    vol.reload()
    sys.path.insert(0, f"{VOL_MOUNT}/corpus-python/src")

    import yaml

    from mailwoman_train.data.loader import iter_rows

    cfg_path = Path(CONFIGS) / config_name
    cfg = yaml.safe_load(cfg_path.read_text())
    data_cfg = cfg["data"]

    # The sampler's own knobs, verbatim from the config that trained the shipped model. If these
    # drift from the config, the count describes a corpus nobody trained on.
    source_weights = data_cfg.get("source_weights")
    country_weights = data_cfg.get("country_weights") or {}
    coarse_filter = data_cfg.get("coarse_filter", True)
    print(f"config          : {cfg_path.name}")
    print(f"corpus_dir      : {corpus_dir}")
    print(f"sources weighted: {len(source_weights or {})}")
    print(f"coarse_filter   : {coarse_filter}")
    print(
        f"augment         : dir={data_cfg.get('augment_directional_prob', 0.0)} "
        f"region={data_cfg.get('augment_region_prob', 0.0)} glue={data_cfg.get('augment_glue_prob', 0.0)} "
        f"case={data_cfg.get('augment_case_prob', 0.0)} punct={data_cfg.get('augment_punct_drop_prob', 0.0)}"
    )
    print(f"drawing         : {rows:,} rows through iter_rows (the real path)\n")

    BARE = re.compile(r"^\d+[A-Za-z]?$")
    DESIGNATOR = re.compile(
        r"^(rue|avenue|av|boulevard|bd|place|impasse|allee|allée|chemin|route|quai|cours|"
        r"street|st|road|rd|drive|dr|lane|ln|way|court|ct|circle|cir|highway|hwy|"
        r"strasse|straße|str|weg|platz|gasse|"
        r"calle|via|viale|corso|piazza|straat|laan|plein|gata|gatan|vei|vej)$",
        re.IGNORECASE,
    )

    by_tag: Counter[str] = Counter()
    by_shape: defaultdict[str, Counter[str]] = defaultdict(Counter)
    by_context: dict[str, Counter[str]] = {"with_designator": Counter(), "no_designator": Counter()}
    by_source: defaultdict[str, Counter[str]] = defaultdict(Counter)
    by_country_shape: defaultdict[tuple[str, str], Counter[str]] = defaultdict(Counter)
    n_rows = 0
    n_bare_tokens = 0

    def shape(tok: str) -> str:
        """Digits collapsed to their COUNT, letter suffix kept as a flag. `39A` -> `2d+alpha`."""
        m = re.match(r"^(\d+)([A-Za-z]?)$", tok)
        if not m:
            return "?"
        return f"{len(m.group(1))}d" + ("+alpha" if m.group(2) else "")

    stream = iter_rows(
        Path(corpus_dir),
        "train",
        rng=random.Random(seed),
        country_weights=country_weights,
        source_weights=source_weights,
        coarse_filter=coarse_filter,
        row_limit=rows,
        augment_directional_prob=data_cfg.get("augment_directional_prob", 0.0),
        augment_region_prob=data_cfg.get("augment_region_prob", 0.0),
        augment_glue_prob=data_cfg.get("augment_glue_prob", 0.0),
        augment_case_prob=data_cfg.get("augment_case_prob", 0.0),
        augment_punct_drop_prob=data_cfg.get("augment_punct_drop_prob", 0.0),
    )

    for row in stream:
        n_rows += 1
        toks = row.get("tokens") or []
        labels = row.get("labels") or []
        if len(toks) != len(labels):
            continue
        src = row.get("source", "?")
        has_desig = any(DESIGNATOR.match(t) for t in toks)

        for tok, lab in zip(toks, labels, strict=True):
            if not BARE.match(tok):
                continue
            n_bare_tokens += 1
            # B-/I- stripped: the question is which COMPONENT owns the token, not its BIO position.
            tag = lab.split("-", 1)[1] if "-" in lab else lab
            by_tag[tag] += 1
            by_shape[shape(tok)][tag] += 1
            by_context["with_designator" if has_desig else "no_designator"][tag] += 1
            by_source[src][tag] += 1
            by_country_shape[(row.get("country", "?"), shape(tok))][tag] += 1

        if n_rows % 50000 == 0:
            print(f"  ... {n_rows:,} rows, {n_bare_tokens:,} bare digit tokens")

    def table(counter: Counter[str], title: str, indent: str = "  ") -> None:
        total = sum(counter.values())
        if not total:
            print(f"{indent}{title}: (none)")
            return
        print(f"{indent}{title}  (n={total:,})")
        for tag, c in counter.most_common(8):
            print(f"{indent}  P({tag:16s} | bare digit) = {c / total:.4f}   {c:,}")

    print(f"\n{'=' * 78}\nROWS DRAWN: {n_rows:,}   BARE DIGIT TOKENS: {n_bare_tokens:,}\n{'=' * 78}\n")
    table(by_tag, "OVERALL — the prior the model is trained on")

    print("\n--- BY TOKEN SHAPE (a 3-digit and a 5-digit token are different questions) ---")
    for sh in sorted(by_shape, key=lambda s: -sum(by_shape[s].values()))[:8]:
        table(by_shape[sh], f"shape {sh}")

    print("\n--- BY CONTEXT (does a street designator in the row move the prior?) ---")
    for ctx in ("with_designator", "no_designator"):
        table(by_context[ctx], ctx)

    print("\n--- TOP SOURCES contributing bare digit tokens ---")
    for src in sorted(by_source, key=lambda s: -sum(by_source[s].values()))[:6]:
        table(by_source[src], f"source {src}")

    # The control: the countries whose rows actually fail in production, at the shapes that fail.
    # Absence is not a low probability — a country with no rows has no prior at all, and its
    # failures are OOD, not mis-taught. The census prints BEFORE the conditional table so a missing
    # row reads as "no data" rather than "zero probability".
    print("\n--- COUNTRY CENSUS: rows drawn per country (absence != a prior of zero) ---")
    cc_rows: Counter[str] = Counter()
    for (cc, _sh), c in by_country_shape.items():
        cc_rows[cc] += sum(c.values())
    tot_cc = sum(cc_rows.values())
    for cc, drawn in cc_rows.most_common(14):
        print(f"    {cc:>8s}  {drawn:>9,}  {drawn / tot_cc:.4f}")
    for probe in ("no", "nz", "pl", "NO", "NZ", "PL"):
        print(f"    [probe] {probe:>3s}: {cc_rows.get(probe, 0):,} bare digit tokens")

    print("\n--- CONTROL: the failing countries at the failing shapes ---")
    print(f"    {'country':>8s} {'shape':>10s} {'n':>8s}   {'P(house_number)':>16s} {'P(postcode)':>12s}")
    for cc in ("no", "pl", "nz", "nl", "de", "us", "fr"):
        for sh in ("2d", "3d", "2d+alpha", "4d", "5d"):
            tags = by_country_shape.get((cc, sh)) or by_country_shape.get((cc.upper(), sh))
            if not tags:
                continue
            tot = sum(tags.values())
            if tot < 30:
                continue
            print(
                f"    {cc:>8s} {sh:>10s} {tot:>8,}   "
                f"{tags['house_number'] / tot:>16.4f} {tags['postcode'] / tot:>12.4f}"
            )


@app.function(
    volumes={VOL_MOUNT: vol},
    image=training_image,
    timeout=3600,
)
def piece_prior(
    config_name: str = "v3.1.0-fr-fragment.yaml",
    rows: int = 200000,
    seed: int = 42,
) -> None:
    """The digit prior at the unit the MODEL actually sees — the SentencePiece piece.

    `digit_prior` counted P(tag | token) and found P(postcode | a 2- or 3-digit token) = 0.0000 in
    every country with data. That looked like the model contradicting its corpus. It is not. The
    model never sees a token; it sees pieces, and emits one label per piece. Digits tokenize roughly
    one piece per character, so a 5-digit postcode `[9|0|2|1|0]` mints FOUR `I-postcode` labels while
    a 2-digit house number `[1|4]` mints ONE `I-house_number`. Longer runs are postcodes AND longer
    runs mint proportionally more continuation labels, so the continuation label distribution can
    invert the token distribution — mechanically, by length. Counting at the wrong unit is how the
    first reading came out backwards.

    That is the hypothesis. This measures it, at the unit, through `iter_encoded` — the same call
    the trainer makes, so the tokenizer and the BIO expansion are the real ones rather than
    arithmetic about them. (A hand-derivation predicted P(postcode | continuation) = 0.688 assuming
    fertility == digit count; multi-digit pieces like `16` exist, so the real number can differ.)

    Reports, for digit-bearing pieces only:
      - P(tag | START piece of a digit run)        vs the model's measured B-house_number 0.604
      - P(tag | CONTINUATION piece of a digit run) vs the model's measured I-postcode 0.587-0.765
      - the same split by run length, since length is the variable doing the work
      - observed fertility per digit-run length, to check the `fertility == digit count` assumption
    """
    import random
    import re
    import sys
    from collections import Counter, defaultdict
    from pathlib import Path

    vol.reload()
    sys.path.insert(0, f"{VOL_MOUNT}/corpus-python/src")

    import yaml

    from mailwoman_train.config import DataConfig
    from mailwoman_train.data.loader import iter_encoded
    from mailwoman_train.labels import ID_TO_LABEL
    from mailwoman_train.tokenizer import Tokenizer

    cfg_path = Path(CONFIGS) / config_name
    cfg = yaml.safe_load(cfg_path.read_text())
    data_cfg = DataConfig(**cfg["data"])
    # `tokenizer_dir` names the directory; the SentencePiece model is the file inside it.
    tok = Tokenizer(Path(data_cfg.tokenizer_dir) / "tokenizer.model")

    print(f"config     : {cfg_path.name}")
    print(f"tokenizer  : {data_cfg.tokenizer_dir}")
    print(f"drawing    : {rows:,} rows through iter_encoded (the real encode path)\n")

    IGNORE = -100
    DIGIT = re.compile(r"\d")

    start_tags: Counter[str] = Counter()
    cont_tags: Counter[str] = Counter()
    by_runlen_start: defaultdict[int, Counter[str]] = defaultdict(Counter)
    by_runlen_cont: defaultdict[int, Counter[str]] = defaultdict(Counter)
    fertility: defaultdict[int, Counter[int]] = defaultdict(Counter)
    n_rows = 0

    stream = iter_encoded(data_cfg, tok, split="train", rng=random.Random(seed), row_limit=rows)

    for ex in stream:
        n_rows += 1
        pieces = [tok.sp.id_to_piece(i) for i in ex.input_ids]
        labels = ex.labels

        # Walk maximal runs of digit-bearing pieces. The run is the unit under investigation:
        # its FIRST piece is where the model emits B-*, the rest are where it emits I-*.
        i = 0
        while i < len(pieces):
            if not DIGIT.search(pieces[i]) or labels[i] == IGNORE:
                i += 1
                continue
            j = i
            while j < len(pieces) and DIGIT.search(pieces[j]) and labels[j] != IGNORE:
                j += 1
            run = pieces[i:j]
            runlabels = [ID_TO_LABEL[lab] for lab in labels[i:j]]
            # digit count in the run, for the fertility check
            ndigits = sum(len(DIGIT.findall(p)) for p in run)
            fertility[ndigits][len(run)] += 1

            def bare(lab: str) -> str:
                return lab.split("-", 1)[1] if "-" in lab else lab

            start_tags[bare(runlabels[0])] += 1
            by_runlen_start[ndigits][bare(runlabels[0])] += 1
            for lab in runlabels[1:]:
                cont_tags[bare(lab)] += 1
                by_runlen_cont[ndigits][bare(lab)] += 1
            i = j

        if n_rows % 25000 == 0:
            print(f"  ... {n_rows:,} rows")

    def table(c: Counter[str], title: str, indent: str = "  ") -> None:
        t = sum(c.values())
        if not t:
            print(f"{indent}{title}: (none)")
            return
        print(f"{indent}{title}  (n={t:,})")
        for tag, n in c.most_common(6):
            print(f"{indent}  P({tag:14s}) = {n / t:.4f}   {n:,}")

    print(f"\n{'=' * 76}\nROWS: {n_rows:,}\n{'=' * 76}\n")
    table(start_tags, "P(tag | digit run START piece)   [model emits B-house_number 0.604]")
    print()
    table(cont_tags, "P(tag | digit run CONTINUATION)  [model emits I-postcode 0.587-0.765]")

    print("\n--- BY DIGIT-RUN LENGTH: start vs continuation ---")
    print(
        f"    {'digits':>6s} {'n_start':>9s} {'start:hn':>9s} {'start:pc':>9s} | {'n_cont':>9s} {'cont:hn':>8s} {'cont:pc':>8s}"
    )
    for dl in sorted(set(by_runlen_start) | set(by_runlen_cont)):
        s, c = by_runlen_start.get(dl, Counter()), by_runlen_cont.get(dl, Counter())
        ts, tc = sum(s.values()), sum(c.values())
        if ts < 50:
            continue
        sh = f"{s['house_number'] / ts:.4f}" if ts else "-"
        sp = f"{s['postcode'] / ts:.4f}" if ts else "-"
        ch = f"{c['house_number'] / tc:.4f}" if tc else "-"
        cp = f"{c['postcode'] / tc:.4f}" if tc else "-"
        print(f"    {dl:>6d} {ts:>9,} {sh:>9s} {sp:>9s} | {tc:>9,} {ch:>8s} {cp:>8s}")

    print("\n--- FERTILITY CHECK: does a digit run of N digits really make N pieces? ---")
    print(f"    {'digits':>6s}  {'n':>9s}   observed piece-count distribution (top 3)")
    for dl in sorted(fertility):
        f = fertility[dl]
        t = sum(f.values())
        if t < 50:
            continue
        top = "  ".join(f"{k}pc:{v / t:.2f}" for k, v in f.most_common(3))
        print(f"    {dl:>6d}  {t:>9,}   {top}")
