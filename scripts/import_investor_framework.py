"""
Imports the investor scoring framework workbook (Quona_CaseA_Investor_Scoring_jav1.xlsx)
into src/data/investor_framework.json.

What this DOES import:
  - the raw evidence metrics per investor (fintech deal counts, African countries covered,
    ref-set co-investors, follow-on / graduation numerators+denominators, presence flags)
  - the four RESEARCH dimension ratings, which cannot be computed from deal data
  - HQ / region / website / tier / research status

  - the workbook's "FUND-LEVEL SCORE (0-100)", "Tier band" and "Dimensions scored (of 9)".
    These are the AUTHORITATIVE fund-level score for every investor in the workbook: the app
    displays them as-is and does not recompute them from the dimensions. `recomputedScore` is
    also stored alongside, purely so the UI can surface where the workbook's cached cell and
    its own SUMPRODUCT formula disagree (267 of 392 rows -- Excel appears not to have
    recalculated after the ratings were last edited). The cached value is what is used; the
    recomputed one is shown for transparency and never silently substituted.

Where a COMPUTED dimension's rating in the workbook does not match what the anchors produce
from that same row's metric, the difference is treated as a deliberate manual adjustment by
the analyst and recorded as `overrides` -- preserved with provenance rather than flattened,
and surfaced in the app as a user override on top of the automated score.

Run:  python3 scripts/import_investor_framework.py
"""
import json
import os

import openpyxl

WORKBOOK = os.path.expanduser("~/Downloads/Quona_CaseA_Investor_Scoring_jav1.xlsx")
OUT = "src/data/investor_framework.json"

# Column indices in the 'Investor Scores' sheet.
C = {
    "investor": 0, "tier": 1, "research_status": 2, "hard_flag": 3,
    "hq": 4, "hq_region": 5, "website": 6,
    "presence_egypt": 7, "presence_south_africa": 8, "presence_kenya": 9, "presence_nigeria": 10,
    "presence_evidence": 11,
    "fintech_deals_all": 12, "fintech_deals_window": 13, "fintech_early_window": 14,
    "fintech_deals_eg_sa_window": 15, "fintech_share": 16, "total_deals": 17,
    "african_countries": 18, "refset_coinvestors": 19,
    "followon_denom": 20, "followon_numer": 21, "followon_rate": 22,
    "grad_denom": 23, "grad_numer": 24, "grad_rate": 25,
    "exits": 26,
    "r_local_presence": 27, "c_followon": 28, "c_fintech_depth": 29, "c_coinvestment": 30,
    "c_african_expertise": 31, "r_global_network": 32, "r_ops_bench": 33, "r_regulatory": 34,
    "c_historical_outcomes": 35,
    "fund_level_score": 36, "dimensions_scored": 37, "tier_band": 38, "confidence": 39,
}

DIMENSION_ORDER = [
    "localCountryPresence", "seriesAFollowOnCapacity", "fintechPortfolioDepth",
    "coInvestmentReputation", "africanMarketExpertise", "globalCrossBorderNetwork",
    "operationalSupportBench", "regulatoryGovRelationships", "historicalInvestmentOutcomes",
]
DIMENSION_WEIGHTS = [16, 16, 16, 16, 7.2, 7.2, 7.2, 7.2, 7.2]

# Rating anchors, transcribed from the workbook's 'Rating Anchors' sheet.
# Each is a list of upper-exclusive cut points for ratings 1..4; >= last cut -> 5.
ANCHORS = {
    "fintechPortfolioDepth": [2, 4, 8, 16],          # 1 / 2-3 / 4-7 / 8-15 / 16+
    "africanMarketExpertise": [2, 4, 7, 10],         # 1 / 2-3 / 4-6 / 7-9 / 10+
    "coInvestmentReputation": [1, 2, 4, 7],          # 0 / 1 / 2-3 / 4-6 / 7+
    "seriesAFollowOnCapacity": [0.20, 0.28, 0.40, 0.54],
    "historicalInvestmentOutcomes": [0.05, 0.13, 0.20, 0.30],
}
MIN_RATE_SAMPLE = 4  # workbook: "24m-matured, min n=4"


def band(value, cuts):
    for i, c in enumerate(cuts):
        if value < c:
            return i + 1
    return 5


def num(v):
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def num_or_none(v):
    """Rounds to 2dp so the stored score reads exactly as the workbook displays it
    (Excel carries values like 89.06249999999987 from binary float accumulation)."""
    f = num(v)
    return round(f, 2) if f is not None else None


def as_int(v):
    f = num(v)
    return int(f) if f is not None else None


def main():
    wb = openpyxl.load_workbook(WORKBOOK, data_only=True)
    rows = list(wb["Investor Scores"].iter_rows(values_only=True))

    investors = []
    override_count = 0
    for r in rows[1:]:
        name = r[C["investor"]]
        if not name or not str(name).strip():
            continue
        name = str(name).strip()

        metrics = {
            "fintechDealsAll": as_int(r[C["fintech_deals_all"]]),
            "fintechDealsWindow": as_int(r[C["fintech_deals_window"]]),
            "fintechEarlyStageWindow": as_int(r[C["fintech_early_window"]]),
            "totalDeals": as_int(r[C["total_deals"]]),
            "africanCountries": as_int(r[C["african_countries"]]),
            "refSetCoInvestors": as_int(r[C["refset_coinvestors"]]),
            "followOnDenom": as_int(r[C["followon_denom"]]),
            "followOnNumer": as_int(r[C["followon_numer"]]),
            "followOnRate": num(r[C["followon_rate"]]),
            "gradDenom": as_int(r[C["grad_denom"]]),
            "gradNumer": as_int(r[C["grad_numer"]]),
            "gradRate": num(r[C["grad_rate"]]),
            "exits": as_int(r[C["exits"]]),
        }

        presence = {
            "Egypt": as_int(r[C["presence_egypt"]]),
            "South Africa": as_int(r[C["presence_south_africa"]]),
            "Kenya": as_int(r[C["presence_kenya"]]),
            "Nigeria": as_int(r[C["presence_nigeria"]]),
        }

        research = {
            "localCountryPresence": num(r[C["r_local_presence"]]),
            "globalCrossBorderNetwork": num(r[C["r_global_network"]]),
            "operationalSupportBench": num(r[C["r_ops_bench"]]),
            "regulatoryGovRelationships": num(r[C["r_regulatory"]]),
        }

        # Compare the workbook's COMPUTED ratings against what the anchors produce for the
        # same row. A mismatch is the analyst deliberately departing from the formula.
        workbook_computed = {
            "fintechPortfolioDepth": num(r[C["c_fintech_depth"]]),
            "africanMarketExpertise": num(r[C["c_african_expertise"]]),
            "coInvestmentReputation": num(r[C["c_coinvestment"]]),
            "seriesAFollowOnCapacity": num(r[C["c_followon"]]),
            "historicalInvestmentOutcomes": num(r[C["c_historical_outcomes"]]),
        }
        derived = {
            "fintechPortfolioDepth": band(metrics["fintechDealsAll"], ANCHORS["fintechPortfolioDepth"]) if metrics["fintechDealsAll"] is not None else None,
            "africanMarketExpertise": band(metrics["africanCountries"], ANCHORS["africanMarketExpertise"]) if metrics["africanCountries"] is not None else None,
            "coInvestmentReputation": band(metrics["refSetCoInvestors"], ANCHORS["coInvestmentReputation"]) if metrics["refSetCoInvestors"] is not None else None,
            "seriesAFollowOnCapacity": (
                band(metrics["followOnRate"], ANCHORS["seriesAFollowOnCapacity"])
                if metrics["followOnRate"] is not None and (metrics["followOnDenom"] or 0) >= MIN_RATE_SAMPLE else None
            ),
            "historicalInvestmentOutcomes": (
                band(metrics["gradRate"], ANCHORS["historicalInvestmentOutcomes"])
                if metrics["gradRate"] is not None and (metrics["gradDenom"] or 0) >= MIN_RATE_SAMPLE else None
            ),
        }
        overrides = {}
        for k, wv in workbook_computed.items():
            if wv is None:
                continue
            dv = derived[k]
            if dv is None or abs(wv - dv) > 1e-9:
                overrides[k] = wv
                override_count += 1

        # Recompute the workbook's own SUMPRODUCT purely for transparency -- see module
        # docstring. Never substituted for the cached value.
        all_ratings = [research.get(k) if k in research else workbook_computed.get(k) for k in DIMENSION_ORDER]
        for k, v in overrides.items():
            all_ratings[DIMENSION_ORDER.index(k)] = v
        weighted_sum = weight_total = 0.0
        for rating, w in zip(all_ratings, DIMENSION_WEIGHTS):
            if rating is None:
                continue
            weighted_sum += (float(rating) - 1) / 4 * w
            weight_total += w
        recomputed = round(weighted_sum / weight_total * 100, 2) if weight_total else None

        investors.append({
            "name": name,
            "tier": r[C["tier"]],
            # THE authoritative fund-level / VC score for this investor. The app displays this
            # as-is for every investor present in the workbook and never recalculates it from
            # the dimensions -- per explicit instruction, this workbook is the scoring system.
            "fundLevelScore": num_or_none(r[C["fund_level_score"]]),
            "dimensionsScored": as_int(r[C["dimensions_scored"]]),
            "tierBand": r[C["tier_band"]],
            "recomputedScore": recomputed,
            "researchStatus": r[C["research_status"]],
            "hardFlag": r[C["hard_flag"]],
            "hq": r[C["hq"]],
            "hqRegion": r[C["hq_region"]],
            "website": r[C["website"]],
            "presenceFlags": presence,
            "presenceEvidence": r[C["presence_evidence"]],
            "metrics": metrics,
            "researchRatings": {k: v for k, v in research.items() if v is not None},
            "analystOverrides": overrides,
        })

    investors.sort(key=lambda i: i["name"].lower())
    os.makedirs("src/data", exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(investors, f, indent=2)

    with_metrics = sum(1 for i in investors if i["metrics"]["fintechDealsAll"] is not None)
    with_research = sum(1 for i in investors if i["researchRatings"])
    with_presence = sum(1 for i in investors if any(v is not None for v in i["presenceFlags"].values()))
    with_score = sum(1 for i in investors if i["fundLevelScore"] is not None)
    drift = [i for i in investors
             if i["fundLevelScore"] is not None and i["recomputedScore"] is not None
             and abs(i["fundLevelScore"] - i["recomputedScore"]) > 0.01]
    print(f"Investors imported:                    {len(investors)}")
    print(f"  with an Excel FUND-LEVEL SCORE:      {with_score}   <- authoritative")
    print(f"  with computed deal metrics:          {with_metrics}")
    print(f"  with >=1 manual research rating:     {with_research}")
    print(f"  with >=1 country presence flag:      {with_presence}")
    print(f"  analyst overrides preserved:         {override_count}")
    print(f"  cached score != recomputed formula:  {len(drift)}  (cached value is used; both stored)")
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
