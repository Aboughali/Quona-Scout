"""
Applies analyst judgment on top of the auto-flagged Stage 2 (fintech-adjacent)
and Stage 4 (multi-market geography) candidates from etl.py.

This is a deliberate, documented judgment pass -- see notes per company.
Re-run after etl.py, before the app consumes src/data/companies.json.
"""
import json

FINTECH_ADJACENT_INCLUDE = {
    "Apollo Agriculture": "Embedded credit is the core product (crop-health-based lending to farmers), not a feature bolted onto something else.",
    "Container Deposit Fund": "Explicitly trade finance for logistics providers -- named category in the case brief.",
    "Ed Partners Africa": "Licensed as an NBFI; core business is lending to private schools -- financial infrastructure, not edtech with a payment feature.",
    "Furaha": "Core product is credit scoring + channeling bank credit for school fees -- embedded finance, not an edtech feature.",
    "Lucky ONE": "Cashback + BNPL/credit products are the product itself, not a feature of something else.",
    "Proxalys": "Installment/deferred-payment sales is the core mechanic -- embedded consumer finance.",
    "RentScore": "Home loans / housing finance is the core product.",
    "Shamba Records": "Farmer credit access + wallet is the core product, data collection is the enabler not the business.",
    "Shekel Mobility": "Financial services to dealers + cross-border transaction facilitation -- financial infrastructure for the auto trade.",
    "SunFi": "Consumer solar financing (payment plans) is the core product -- embedded asset finance.",
    "Powerfull": "Solar financing explicitly named as the product.",
    "Wami Agro": "Farmer credit access is the core product.",
    "Zebra Cropbank": "Farmer credit access is a named core pillar alongside storage infrastructure.",
    "Omnibiz": "Embedded finance explicitly named in own description (will still be cut at Stage 3 -- already raised Series A).",
    "Triply (Tripitaca)": "Self-describes with 'embedded finance' as a core module of the travel OS, not a side feature.",
    "Valify": "eKYC/eKYB/biometric auth is financial infrastructure (identity/KYC rails), same category as Monnai-style companies.",
    "Vove ID": "Digital identity verification for KYC/authentication -- financial infrastructure.",
    "Bunce": "Payment automation platform for businesses -- the product is payments infrastructure, not adjacent to one.",
    "24Seven": "Inventory-on-credit for small retailers is embedded trade credit, not a marketplace feature.",
    "Africa Due Diligence": "AI-powered KYC/due-diligence on financial institutions and investors -- financial infrastructure (RegTech).",
    "Ecowaka": "Flexible payment options for EV acquisition is embedded asset financing, same pattern as SunFi/Powerfull.",
    "VerZ": "Deferred-payment model for medicine access is embedded consumer finance (healthcare BNPL).",
}

FINTECH_ADJACENT_EXCLUDE_NOTE = "Reviewed -- payments/credit is a secondary feature of a non-fintech core product (logistics, marketplace, comms, or software), not the business itself. Left out to keep the fintech filter meaningful rather than keyword-driven."

MULTI_MARKET_INCLUDE = {
    "Accrue": "Description explicitly states cross-border money movement 'across Africa and the US' -- multi-market by product design.",
    "Power Financial Wellness": "Description explicitly states 'across Africa' -- multi-market by product design.",
    "Regulon": "Serves fintech clients 'across Africa and the UK' -- multi-market by client base, though HQ is single-country (Ghana).",
    "Salad": "Description explicitly states employer base 'across Africa'.",
    "Tembo": "APIs/SDKs positioned explicitly 'across Africa' -- infrastructure play by design, not single-market.",
    "The Blu Penguin": "Description explicitly states 'across Africa' for payment solutions.",
}
MULTI_MARKET_EXCLUDE_NOTE = "Reviewed -- this is diaspora/UK-based banking for African migrants, not a company operating across 3+ African markets. Does not meet the geography test's spirit (team/operations, not customer nationality)."

CONFIDENCE_CAVEAT = " Country count not independently verified beyond the sourced description -- confirm before final commitment."


def main():
    with open("src/data/companies.json") as f:
        companies = json.load(f)

    n_promoted_fintech = 0
    n_promoted_geo = 0

    for c in companies:
        name = c["name"]
        if c["stage2"]["adjacentCandidate"]:
            if name in FINTECH_ADJACENT_INCLUDE:
                c["stage2"]["pass"] = True
                c["overrides"]["fintechPivot"]["active"] = True
                c["overrides"]["fintechPivot"]["note"] = FINTECH_ADJACENT_INCLUDE[name]
                n_promoted_fintech += 1
            else:
                c["overrides"]["fintechPivot"]["note"] = FINTECH_ADJACENT_EXCLUDE_NOTE

        if c["stage4"]["multiMarketSignal"] and not c["stage4"]["pass"]:
            if name in MULTI_MARKET_INCLUDE:
                c["stage4"]["pass"] = True
                c["overrides"]["geography3Markets"]["active"] = True
                c["overrides"]["geography3Markets"]["note"] = MULTI_MARKET_INCLUDE[name] + CONFIDENCE_CAVEAT
                n_promoted_geo += 1
            else:
                c["overrides"]["geography3Markets"]["note"] = MULTI_MARKET_EXCLUDE_NOTE

        # Recompute the cut stage after any promotions. Stage 5 (Syndicate) is computed live
        # in the app, so nothing is written to it here.
        stage2p, stage3p, stage4p = c["stage2"]["pass"], c["stage3"]["pass"], c["stage4"]["pass"]
        if not stage2p:
            c["cutStage"], c["cutReason"] = 2, c["stage2"]["reason"]
        elif not stage3p:
            c["cutStage"], c["cutReason"] = 3, c["stage3"]["reason"]
        elif not stage4p:
            c["cutStage"], c["cutReason"] = 4, c["stage4"]["reason"]
        else:
            c["cutStage"], c["cutReason"] = None, None

    with open("src/data/companies.json", "w") as f:
        json.dump(companies, f, indent=2)

    n5 = sum(1 for c in companies if c["stage2"]["pass"] and c["stage3"]["pass"] and c["stage4"]["pass"])
    print(f"Promoted {n_promoted_fintech} fintech-adjacent companies to Stage 2 pass")
    print(f"Promoted {n_promoted_geo} companies via 3+ markets geography override")
    print(f"New Stage 4 total (pre-syndicate): {n5}")


if __name__ == "__main__":
    main()
