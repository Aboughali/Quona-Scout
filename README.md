# Quona Scout — Africa Fintech Sourcing System

Interactive sourcing tool for Quona Capital's Case A (EMEA Summer Associate case study, Aug 2026).
Implements the 6-stage funnel in `specs/Quona_CaseA_Funnel_Filtration_Logic.docx` and the syndicate
scoring engine in `specs/Quona_CaseA_Syndicate_Scoring_Mechanism.docx`, running live against
`data/Deals in africa Gold sheet - AMENDED JA V2.xlsx`.

## Run it

```bash
npm install
npm run dev
```

## Project layout

- `data/` — source spreadsheets (gold sheet, deep-research seed/pre-seed tracker), untouched.
- `specs/` — the two authoritative build specs.
- `scripts/etl.py` — reads the gold sheet, groups rounds by company, computes Stages 1-4
  (fintech filter, no-Series-A check incl. M&A hard-exclusion, geography). Outputs
  `src/data/companies.json`.
- `scripts/apply_manual_overrides.py` — the documented analyst judgment pass on top of the ETL's
  auto-flagged "fintech-adjacent" and "3+ markets" candidates (each promotion/exclusion has a
  written reason — see the script for the full list).
- `scripts/research_batch_{a,b,c,d}.json` — raw fund research output (9-dimension ratings +
  evidence + source URLs) from four parallel research passes, merged into `src/data/funds.json`
  alongside the 4 funds already profiled in the spec (Flourish, Algebra, TLcom, 54 Collective).
- `src/lib/scoring.ts` — the 0-100 syndicate scoring formula (weighted, normalized, divided by
  scored-dimension weight only) plus the deal-relative Local Presence and vintage-based Follow-on
  Capacity computations.
- `src/lib/funnel.ts` — stage membership logic, including the Stage 6 binary syndicate gate
  (deliberately separate from the 0-100 engine, per spec).
- `src/lib/editStore.ts` / `src/context/EditorContext.tsx` — the generic field-level edit/audit
  engine every editable surface (company fields, classifications, rounds, fund dimensions) is
  built on, persisted to `localStorage`.
- `src/lib/rounds.ts` / `src/components/RoundsSection.tsx` — fully editable Rounds on Record
  (edit/add/remove/mark-unverified/revert), each round addressed as its own field-edit entity.
- `src/lib/funds.ts` / `src/components/InvestorSyndicateSection.tsx` — fully editable Investor
  Syndicate (add/remove investors, per-dimension score overrides, new-investor creation, tier
  override distinct from the calculated score).
- `scripts/scan/` / `src/components/CompanyNewsSection.tsx` — the weekly web scan and the
  per-company news feed built on its output (see "News & Traction" below).
- `scripts/traction/` / `src/components/TractionSection.tsx` — uploaded pitch decks and
  financials, read by the model and reduced to 2-3 traction bullets (see below).

## Refreshing the data (quarterly, per the case brief)

1. Replace `data/Deals in africa Gold sheet - AMENDED JA V2.xlsx` with the updated export.
2. `python3 scripts/etl.py`
3. `python3 scripts/apply_manual_overrides.py` (review the promotion lists — new fintech-adjacent
   or multi-market companies may need a fresh judgment call, not just a re-run).
4. Re-research any new investors surfaced in the Stage 5 checkpoint and add them to
   `src/data/funds.json` following the schema in `src/types.ts`.
5. `npm run dev` / `npm run build`.

## Current funnel result (as of this build)

Stage 1: 828 → Stage 2 (fintech): 249 → Stage 3 (no Series A): 191 → Stage 4/5 (geography
checkpoint): 45 → Stage 6 (syndicate database): **22 companies**.

## News & Traction (per company)

Two sections at the bottom of every company drawer, answering two different questions: what the
outside world is saying, and what the company itself can evidence.

**News** renders whatever the scan has attached to that company over the last three years. The
three most recent are shown; "Show all N articles" reveals the full history. Each card carries
the category, headline, source and age, with the article's own lead image where the feed offers
one and a source monogram where it does not — never a stock image, which would imply a source
that does not exist. An article is only attached at ≥0.8 company-match confidence; weaker
matches stay in Needs Review.

### Two collectors, because RSS cannot see the past

`npm run scan` reads RSS feeds, and **a feed only publishes the newest handful of posts** —
techcabal.com/feed returns 10 items covering about a day. So `lookbackDays: 1095` filters
articles that were already fetched; it does not reach back three years. Run the feed scan alone
and every profile stays empty, because a company's funding story from last January was never
retrievable.

`npm run scan:backfill` closes that gap. Most configured outlets run WordPress, which exposes
its whole archive as a public JSON API (`/wp-json/wp/v2/posts`) with a `search` parameter and no
window limit. The backfill asks each archive for each tracked company by name:

```
npm run scan:backfill                    # statically-uncut companies (fast first run)
npm run scan:backfill -- --scope=stage4  # everything through the geography gate
npm run scan:backfill -- --scope=all     # all 828 companies (~45 min)
npm run scan:backfill -- --ids=enza,numida     # exactly these companies
npm run scan:backfill -- --limit=5 --dry-run   # cheap trial, writes nothing
```

⚠️ **`--scope=watchlist` is not the watchlist you see in the app.** It selects on the ETL's
static `cutStage`, while the app computes the funnel *with your overrides applied*. HoneyCoin is
the worked example: the ETL cuts it at Stage 4 ("HQ/base = Kenya; no multi-market evidence"), a
manual override puts it on the final watchlist, and that override lives in the browser's
localStorage where no Node script can see it. Use `--ids=` (from the app's Export Watchlist) to
target the real thing, or `--scope=all`, which is guaranteed to include it.

Requests are two-phase, and the reason is bandwidth: 100 search results *with* article bodies is
~1.4MB against ~60KB without, so a full sweep in one phase would pull several gigabytes off
publishers serving this for free. Phase 1 ranks titles and excerpts by relevance, and only the
handful that name the company (or a founder, or its domain) get their bodies fetched — typically
5 of 650 titles ranked. Sources are separate hosts, so the sweep runs them concurrently: each
host sees the same polite request rate, and wall-clock drops by a factor of eight.

Search alone is far too loose — "Numida" returns round-ups that name it once, and a company
called *Root* returns the English word. So `backfill.mjs` scores every candidate against
evidence already in the database and keeps only corroborated articles:

| Tier | Evidence |
|---|---|
| `domain` | the article cites the company's own website domain |
| `founder` | it names a founder on record (full name, or surname when the company is also named) |
| `headline` | the company is named in the headline |
| `sustained` | named 3+ times in the body inside company grammar ("X raises", "fintech X") |

Mention *density* is what separates coverage from a newsletter digest: "TechCabal Daily" names
twenty companies once each, and country plus funding vocabulary cannot tell it apart from real
coverage — every African tech article has both. Names that are ordinary words additionally
require correct capitalisation ("Root raises $8m" ≠ "the root of the problem"), which is also
what stops a round-up about firms planning to *float* reading as coverage of the fintech Float.

Names collide across continents too — this database's Float is South African, but there is a
Canadian Float raising CAD $85m and a European one closing a Series A. So a
`global-fintech-news` source must place the story in Africa before a name match counts, the same
`requireAfrica` rule the feed scan already applies. Identity-specific evidence (own domain,
named founder) is exempt, since those cannot belong to a namesake.

Search results are ranked by **relevance, not date**. Forcing `orderby=date` buried the one
article actually about a common-word company under every recent article that merely used the
word: "South-African startup Scale raises $700,000" sat below dozens of headlines about other
startups raising money "to scale".

Backfill only widens the net. It never decides which company an article belongs to — that stays
with `npm run scan:enrich` and its 0.8 attach gate. Sources that restrict their API
(TechAfrica News answers `itsec_rest_api_access_restricted`) carry an `archiveNote` in the config
and are left alone rather than worked around.

**Wamda has no archive API** — no `wp-json`, no `jsonapi`, and its `sitemap.xml` returns 500, so
only its RSS window is reachable and its back catalogue cannot be retrieved. In practice this
costs little: the events it covers are reported by sources that *are* reachable (Connect Money's
$8m seed, published by Wamda in June 2024, comes back from Disrupt Africa, Techpoint Africa and
TechCrunch). Getting Wamda's own URLs would mean crawling its HTML search pages through Apify,
which spends credits — not done here.

Normal refresh cycle: `npm run scan` weekly, `npm run scan:backfill` when the tracked set
changes, then `npm run scan:enrich`.

**Traction** is investor-supplied evidence, added three ways from the `+` button:

| Route | What happens |
|---|---|
| Upload pitch deck | PDF goes to the model as a native document block (slides read visually) |
| Upload financials | .xlsx/.docx/.pptx/.csv are converted to text locally first, so only the extracted characters are billed |
| Add data manually | You type the metrics; **no model is involved** |

Uploads are analysed by `scripts/traction/` — `extract.mjs` (deterministic, offline) →
`summarise.mjs` (the single model call, Claude Opus 5 with structured outputs) → `analyse.mjs`
(the shared entry point the dev-server endpoint wraps, mirroring `executeScan()`). The prompt
forbids outside knowledge and requires a figure from the document in every bullet, with an
explicit "no traction data here" exit, so a summary can never quietly invent a metric. Every
card states its provenance — AI summary vs. entered manually, by whom, when — and a document
that cannot be summarised is still filed, with the reason shown on the card.

Set `ANTHROPIC_API_KEY` in `.env` to enable summaries; without it uploads still store the file
and say so plainly. Entries live in `localStorage` with the other investor-judgment layers and
ride the same backup/restore flow (schema v3); the uploaded files themselves live under
`data/traction/` and are gitignored, being company-confidential.

## Investor Judgment / Edit Mode

Every field on a company (profile, funding, investors, classifications) is editable from the
profile drawer or directly from a table cell — see `src/lib/editStore.ts`, `src/context/EditorContext.tsx`,
`src/lib/resolve.ts`, `src/lib/fields.ts`, and `src/components/{EditableField,ClassificationField,
CommentaryPanel,ChangeHistoryPanel,ReviewQueue,EditableCell}.tsx`.

- **Nothing in `companies.json`/`funds.json` is ever mutated.** Edits live in a separate
  `localStorage`-backed layer (`quona-scout-field-edits-v1`), keyed by company id + field path,
  each holding the original value/source, the current value, and a full timestamped/authored
  history (reason, source, evidence URL, confidence) for every change and every revert.
- `resolveCompany()` merges original data + active edits fresh on every render, so the funnel
  counts, tables, and drawer always reflect the current active judgment — an edit to Fintech?/
  Series A?/3+ markets?/Strong syndicate? ripples through the stage counts immediately.
- "Revert to original" removes the override layer and restores the automated value; it does not
  delete the edit history, which still shows both the override and the revert.
- Commentary (`quona-scout-commentary-v1`) is a separate, independent append-only note log per
  company — meeting notes, founder comments, follow-ups — distinct from field-level edits.
- The **Needs Review** tab scans resolved companies for low-confidence data, unresolved
  fintech-adjacent/geography-ambiguous cases, missing founder data, unnamed investors, and
  borderline syndicate scores, each resolvable inline.
- Caveat: this state lives in the browser's `localStorage`, not in a shared backend — it does not
  sync across browsers/devices. Exports (Stage 5/6 JSON) always reflect current resolved values.

**Known source-data quirk found while building this**: the gold sheet has ~11 case-variant
duplicate rows (e.g. "CloudFret" vs "Cloudfret", "ValU" vs "valU") that read as distinct
companies with different investors/rounds. `scripts/etl.py`'s `slugify()` now guarantees globally
unique ids (numeric suffix on collision) so these don't corrupt edit history, but they likely
warrant a manual look to confirm whether they're true duplicates or genuinely different entities.

## Rounds on Record & Investor Syndicate editing

Both are extensions of the same field-edit engine, not separate systems:

- **Rounds**: each round (from the gold sheet or investor-added) is addressed as its own virtual
  field (`round:<id>`), whose value is a structured record (type, amount, currency, date,
  investors, lead, sources, confidence, notes, verified flag, active/removed status). "Remove" sets
  `status: 'removed'` via the normal override mechanism — fully reversible, never a hard delete.
  Stage 3 (Series A) and Company Status now read the **live resolved round list**, so adding,
  editing, or removing a round automatically re-flows into funnel eligibility. A documented
  fallback keeps trusting the ETL's frozen full-history Series A/M&A check (which also covers
  rounds outside the displayed Aug 2023–2026 window) until the investor actually touches a
  company's rounds, so out-of-window Series A history can't silently go invisible.
- **Investor Syndicate**: fund dimension edits are entity-scoped to `fund:<normalized-name>`
  (not a company id) — per the scoring spec, 8 of the 9 dimensions are fund-level and reused
  across every company that fund backs, so an edit made from one company's profile is meant to
  travel. `resolveFundIndex()` merges static `funds.json` + overrides + brand-new investor-created
  funds into the index every scoring computation reads. A separate per-company "tier override"
  (`syndicateTierOverride.<fund>`) lets an investor override the qualitative label (Strong/
  Moderate/Weak) without touching the calculated 0-100 score, exactly as the case brief's example
  shows.
- The drawer's Quona Funnel section shows a persistent **original-vs-current eligibility banner**,
  computed by resolving the company with zero edits vs. the live edit state — so it's always
  visible when (and only when) an edit has actually moved a company in or out of the funnel.

## Historical funding data (Deals 2019-2025 -> intake dataset)

The 2023-2026 intake sheet alone determines the sourcing universe (Stage 1); the Deals 2019-2025
sheet only ever *enriches* a company already in that universe with its earlier funding history —
it never adds a new company. `scripts/etl.py`'s `merge_historical_rounds()` / `merge_type_conflicts()`
match companies by normalized name, then reconcile rounds via two passes:

1. **Exact fingerprint** (date + type) — a round found in both sheets is merged, not duplicated;
   a genuine amount disagreement is preserved as a `conflict` on the round rather than picked
   silently. Fingerprinting is deliberately exact-date (not year-only): two real, distinct raises
   of the same type in the same year (e.g. two separate debt tranches) must not collapse into one.
2. **Same date + same amount, different type** — the 2019-2025 sheet systematically logs many
   rows as a generic "Venture Round" where the intake sheet has since researched a specific stage;
   that's resolved silently in favor of the specific label (not a real conflict). A conflict is
   only raised when both sides name a *specific*, differing type.

Every round carries a `sourceDataset` tag (Intake / History / Both) and an optional `conflict`
object, both surfaced in the RoundsSection UI. The Investor Syndicate section splits into
**Current Round Syndicate** (backed the latest round) vs **Historical Investors** (earlier rounds
only) — an investor in both counts as current. Re-run `python3 scripts/etl.py` to regenerate;
it also writes `src/data/reconciliation_report.json` and prints the reconciliation summary.

**Reconciliation (current data):** 828 intake companies, all 828 matched to the historical
sheet, 0 unmatched, 949 historical rounds imported, 1022 duplicate rounds merged, 45 companies
needed name normalization to match, 13 genuine data conflicts flagged (9 amount, 4 type).

**Bug found and fixed while building this:** some gold-sheet amount cells contain the literal
text `"n.a"` instead of being blank (e.g. MoneyHash's first round). The ETL now runs every
numeric round field through a safe float coercion instead of passing raw cell values through,
and the frontend's round summary math has a matching defensive guard.
