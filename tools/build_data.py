"""Build the card database used by the web app.

Sources (downloaded fresh unless --cache is given):
  - YGOPRODeck card info (EN + FR names, set codes, rarities)
  - Cardmarket public product list + price guide for Yu-Gi-Oh! (idGame 3)

Output: one compact JSON file (default app/data/cards.json):
  {
    "v": build date,
    "cards": [[nameEN, nameFR], ...],
    "sets":  [setName, ...],
    "prints": {"MP20-167": [[cardIdx, setIdx, rarity, cmId, cmVersions], ...]},
    "prices": {"cmId": [trend, low, avg7], ...}
  }
cmId is the Cardmarket product id, 0 when no product matched, or a list of
candidate ids when Cardmarket lists several versions and none could be told apart
(tools/rarity_overrides.json, if present, resolves those: {"idProduct": "rarity"}).
"""
import argparse, collections, datetime, json, os, re, sys, urllib.request

YGO_EN = "https://db.ygoprodeck.com/api/v7/cardinfo.php"
YGO_FR = "https://db.ygoprodeck.com/api/v7/cardinfo.php?language=fr"
CM_PRODUCTS = "https://downloads.s3.cardmarket.com/productCatalog/productList/products_singles_3.json"
CM_PRICES = "https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_3.json"
HERE = os.path.dirname(os.path.abspath(__file__))


def fetch(url, cache, name):
    if cache:
        p = os.path.join(cache, name)
        if os.path.exists(p):
            return json.load(open(p, encoding="utf-8"))
    req = urllib.request.Request(url, headers={"User-Agent": "card-scanner-data-build/1.0"})
    with urllib.request.urlopen(req, timeout=300) as r:
        raw = r.read()
    if cache:
        os.makedirs(cache, exist_ok=True)
        open(os.path.join(cache, name), "wb").write(raw)
    return json.loads(raw.decode("utf-8"))


def split_code(code):
    m = re.match(r"^([A-Z0-9]+)-([A-Z]{0,2})(\d+[A-Z]?)$", code.strip().upper())
    return (m.group(1), m.group(3)) if m else (None, None)


def norm(name):
    return re.sub(r"[^a-z0-9]", "", name.lower())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(HERE, "..", "app", "data", "cards.json"))
    ap.add_argument("--cache", help="folder to reuse downloaded sources (local dev)")
    a = ap.parse_args()

    en = fetch(YGO_EN, a.cache, "ygo_en.json")["data"]
    fr = {c["id"]: c["name"] for c in fetch(YGO_FR, a.cache, "ygo_fr.json")["data"]}
    products = fetch(CM_PRODUCTS, a.cache, "cm_products.json")["products"]
    prices_raw = fetch(CM_PRICES, a.cache, "cm_prices.json")["priceGuides"]
    overrides_path = os.path.join(HERE, "rarity_overrides.json")
    overrides = {int(k): v for k, v in json.load(open(overrides_path, encoding="utf-8")).items()} if os.path.exists(overrides_path) else {}

    # ---- YGOPRODeck prints ----
    cards, setnames, sets = [], [], {}
    prints = {}
    set_cards = collections.defaultdict(set)     # setName -> normalized card names
    for c in en:
        ci = len(cards)
        cards.append([c["name"], fr.get(c["id"], "")])
        for s in c.get("card_sets") or []:
            p, n = split_code(s["set_code"])
            if not p:
                continue
            sn = s["set_name"]
            if sn not in sets:
                sets[sn] = len(setnames); setnames.append(sn)
            prints.setdefault(f"{p}-{n}", []).append([ci, sets[sn], s["set_rarity"], 0, 0])
            set_cards[sn].add(norm(c["name"]))

    # ---- Cardmarket products grouped by expansion ----
    exp_products = collections.defaultdict(lambda: collections.defaultdict(list))  # idExp -> norm name -> [idProduct]
    exp_names = collections.defaultdict(set)
    for p in products:
        nn = norm(re.sub(r"\s*\(V\.\d+.*?\)\s*$", "", p["name"]))
        exp_products[p["idExpansion"]][nn].append(p["idProduct"])
        exp_names[p["idExpansion"]].add(nn)
    name_to_exps = collections.defaultdict(set)
    for e, names in exp_names.items():
        for nn in names:
            name_to_exps[nn].add(e)

    # ---- match each YGOPRODeck set to Cardmarket expansion(s) by shared card names ----
    set_exp = {}
    for sn, names in set_cards.items():
        votes = collections.Counter()
        for nn in names:
            for e in name_to_exps.get(nn, ()):
                votes[e] += 1
        if not votes:
            continue
        # score = overlap relative to both sizes (avoids huge expansions winning everywhere)
        sim = lambda e: votes[e] / (len(names) ** .5 * len(exp_names[e]) ** .5)
        best = max(votes, key=sim)
        score = votes[best] / len(names)
        if score >= 0.6 or (votes[best] >= 3 and score >= 0.4):
            # Cardmarket sometimes splits one set into several expansions (print runs/regions):
            # keep every expansion that matches almost as well as the best one.
            set_exp[sn] = [e for e in votes if sim(e) >= 0.85 * sim(best) and votes[e] / len(names) >= 0.5 * score]

    # ---- assign product ids ----
    linked = ambiguous = 0
    for key, lst in prints.items():
        for e in lst:
            sn = setnames[e[1]]
            exps = set_exp.get(sn)
            if not exps:
                continue
            nn = norm(cards[e[0]][0])
            ids = sorted(i for x in exps for i in exp_products[x].get(nn, []))
            if not ids:
                continue
            e[4] = len(ids)
            hit = [i for i in ids if overrides.get(i) == e[2]]
            if len(ids) == 1:
                e[3] = ids[0]; linked += 1
            elif len(hit) == 1:
                e[3] = hit[0]; linked += 1
            else:
                e[3] = ids[:8]; ambiguous += 1   # candidates: the app shows a price range

    # ---- prices for the products we use ----
    used = set()
    for lst in prints.values():
        for e in lst:
            used.update(e[3] if isinstance(e[3], list) else ([e[3]] if e[3] else []))
    prices = {}
    for g in prices_raw:
        if g["idProduct"] in used:
            prices[str(g["idProduct"])] = [g.get("trend"), g.get("low"), g.get("avg7")]

    out = {"v": datetime.date.today().isoformat(), "cards": cards, "sets": setnames, "prints": prints, "prices": prices}
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    json.dump(out, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    total = sum(len(l) for l in prints.values())
    print(f"cards {len(cards)} | prints {total} | sets matched {len(set_exp)}/{len(set_cards)} | "
          f"linked {linked} | multi-version {ambiguous} | prices {len(prices)} | {os.path.getsize(a.out)//1024} KB")


if __name__ == "__main__":
    sys.exit(main())
