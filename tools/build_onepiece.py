"""Build the One Piece card database used by the web app.

Sources (downloaded fresh unless --cache is given):
  - optcgapi.com: every card of the booster sets and starter decks, with its versions
    (normal, parallel / alternate art, manga, SP, reprint) and their pictures
  - Cardmarket public product lists + price guide for One Piece (idGame 18). Cardmarket sells the
    Japanese / Asian prints as separate products (their sealed products say "Non-English" or
    "Asia Region Legal"): only the international (English, French…) products are used.

Output: app/data/onepiece.json, same shape as cards.json:
  {"v", "img": picture address prefix, "cards": [[name, "", picture]], "sets": [...],
   "prints": {"OP12-118": [[cardIdx, setIdx, rarity, cmId, cmVersions]]}, "prices": {"cmId": [trend, low, avg7]}}
"""
import argparse, collections, datetime, json, os, re, sys, urllib.request

OPTCG = "https://optcgapi.com/api/{}/"
IMG = "https://optcgapi.com/media/static/Card_Images/"
CM_SINGLES = "https://downloads.s3.cardmarket.com/productCatalog/productList/products_singles_18.json"
CM_SEALED = "https://downloads.s3.cardmarket.com/productCatalog/productList/products_nonsingles_18.json"
CM_PRICES = "https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_18.json"
HERE = os.path.dirname(os.path.abspath(__file__))
CODE = re.compile(r"\(((?:[A-Z]{1,4}\d{0,2})-\d{3})\)")
VARIANT = [("manga", "Manga"), ("sp", "SP"), ("reprint", "Réimpression"), ("parallel", "Parallèle"), ("alternate art", "Illustration alternative"), ("gold", "Gold")]


def fetch(url, cache, name):
    p = os.path.join(cache, name) if cache else None
    if p and os.path.exists(p):
        return json.load(open(p, encoding="utf-8"))
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (card-scanner-data-build)"})
    with urllib.request.urlopen(req, timeout=300) as r:
        raw = r.read()
    if p:
        os.makedirs(cache, exist_ok=True)
        open(p, "wb").write(raw)
    return json.loads(raw.decode("utf-8"))


def clean_name(n):
    n = re.sub(r"\s*-\s*[A-Z]{1,4}\d{0,2}-\d{3}.*$", "", n)          # "Trafalgar Law - OP10-119 (SP)"
    n = re.sub(r"\s*\(\d{3}\)", "", n)                                 # "Nico Robin (062)"
    n = re.sub(r"\s*\((Parallel|Alternate Art|Manga|SP|Reprint|Gold)[^)]*\)", "", n, flags=re.I)
    return n.strip()


def variant(entry):
    """Order of a version among the prints of one code, and its label."""
    name, img = entry["card_name"].lower(), entry["card_image_id"]
    label = next((lab for k, lab in VARIANT if f"({k}" in name), "")
    m = re.search(r"_([pr])(\d+)", img)
    # Cardmarket lists a plain reprint before the special (SP) version of the same number
    order = 0 if not m else int(m.group(2)) - (0.5 if m.group(1) == "r" else 0)
    if not label and m:
        label = "Réimpression" if m.group(1) == "r" else "Parallèle"
    return order, label


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(HERE, "..", "app", "data", "onepiece.json"))
    ap.add_argument("--cache", help="folder to reuse downloaded sources (local dev)")
    a = ap.parse_args()

    entries = fetch(OPTCG.format("allSetCards"), a.cache, "op_sets.json") + fetch(OPTCG.format("allSTCards"), a.cache, "op_st.json")
    singles = fetch(CM_SINGLES, a.cache, "op_cm18.json")["products"]
    sealed = fetch(CM_SEALED, a.cache, "op_ns18.json")["products"]
    prices_raw = {g["idProduct"]: g for g in fetch(CM_PRICES, a.cache, "op_pg18.json")["priceGuides"]}

    # Japanese / Asian editions on Cardmarket: their sealed products are marked as such
    asian = {p["idExpansion"] for p in sealed if re.search(r"Non-English|Asia Region|Japanese", p["name"], re.I)}
    # expansion names (not in the singles list): the shortest sealed product name, without "Booster…"; no sealed product: promos
    exp_names = collections.defaultdict(list)
    for p in sealed:
        exp_names[p["idExpansion"]].append(p["name"])
    def exp_name(x):
        names = [n for n in exp_names.get(x, []) if re.search(r"Booster|Starter Deck|Premium|Extra", n)]
        if not names:  # promo expansions hold all sorts of event packs: call them "Promos"
            return "Promos"
        n = min(names, key=len)
        return re.sub(r"\s*(-\s*)?(Booster( Box)?( Case)?|Display|Sleeved Booster)\b.*$", "", n).strip() or n
    cm = collections.defaultdict(lambda: collections.defaultdict(list))   # code -> expansion -> [product]
    exp_prefix = collections.defaultdict(collections.Counter)
    cm_name = {}
    for p in sorted(singles, key=lambda p: p["idProduct"]):
        m = CODE.search(p["name"])
        if not m or p["idExpansion"] in asian:
            continue
        code = m.group(1)
        cm[code][p["idExpansion"]].append(p)
        exp_prefix[p["idExpansion"]][code.split("-")[0]] += 1
        cm_name.setdefault(code, clean_name(CODE.sub("", p["name"]).strip()))

    by_code = collections.defaultdict(list)
    seen = set()
    for e in entries:
        key = (e.get("card_set_id"), e.get("card_image") or e.get("card_image_id"))
        if key in seen or not e.get("card_set_id"):
            continue
        seen.add(key)
        by_code[e["card_set_id"].strip().upper()].append(e)

    cards, card_idx, setnames, set_idx, prints = [], {}, [], {}, {}
    linked = ambiguous = 0
    def add_set(name):
        if name not in set_idx:
            set_idx[name] = len(setnames); setnames.append(name)
        return set_idx[name]

    for code in sorted(set(by_code) | set(cm)):
        prefix = code.split("-")[0]
        # promo codes (P-xxx) are reprinted in many products the card list does not tell apart:
        # offer the Cardmarket products themselves, named after their expansion
        es = [] if prefix == "P" else by_code.get(code, [])
        # main set first (the one named after the code), then reprints / special sets
        es.sort(key=lambda e: (re.sub(r"[^A-Z0-9]", "", e["set_id"].upper()) != prefix, variant(e)[0]))
        exps = cm.get(code, {})
        main_exp = max(exps, key=lambda x: (exp_prefix[x].most_common(1)[0][0] == prefix, len(exps[x]), -x), default=None)
        main_ps = exps.get(main_exp, [])
        other_ps = [p for x, ps in exps.items() if x != main_exp for p in ps]
        main_es = [e for e in es if re.sub(r"[^A-Z0-9]", "", e["set_id"].upper()) == prefix] or es[:len(main_ps)]
        other_es = [e for e in es if e not in main_es]
        lst = []
        def put(e, cmid, n, setname=None, label=None):
            nonlocal linked, ambiguous
            name = clean_name(e["card_name"]) if e else cm_name.get(code, code)
            img = (e.get("card_image") or "") if e else ""
            img = img[len(IMG):] if img.startswith(IMG) else ""
            ck = (name, img)
            if ck not in card_idx:
                card_idx[ck] = len(cards); cards.append([name, "", img])
            rarity = (e.get("rarity") or "") if e else ""
            lab = variant(e)[1] if e else ""
            rar = label or (f"{rarity} {lab}".strip() if rarity else lab) or "Carte"
            si = add_set(setname or (e["set_name"] if e else prefix))
            if isinstance(cmid, list): ambiguous += 1
            elif cmid: linked += 1
            lst.append([card_idx[ck], si, rar, cmid, n])
        if es:
            for group_es, group_ps in ((main_es, main_ps), (other_es, other_ps)):
                for i, e in enumerate(group_es):
                    if len(group_ps) == len(group_es):
                        put(e, group_ps[i]["idProduct"], len(group_ps))
                    elif len(group_ps) == 1:
                        put(e, group_ps[0]["idProduct"], 1)
                    elif group_ps:
                        put(e, [p["idProduct"] for p in group_ps][:8], len(group_ps))
                    else:
                        put(e, 0, 0)
        else:  # promos and cards missing from optcgapi: Cardmarket alone (name, no picture), named after their expansion
            for i, p in enumerate(main_ps + other_ps):
                put(None, p["idProduct"], 1, exp_name(p["idExpansion"]), f"Version · {exp_name(p['idExpansion'])}")
        # versions sold on Cardmarket that the card list does not know (e.g. the same code in "Promos"): offered too
        used = {i for e in lst for i in (e[3] if isinstance(e[3], list) else [e[3]])}
        for x, ps in exps.items():
            for p in ps:
                if p["idProduct"] not in used:
                    put(None, p["idProduct"], 1, exp_name(x), f"Autre version · {exp_name(x)}")
        # the app tells versions apart by their label: number the ones that share a label
        seen_lab = collections.Counter(e[2] for e in lst)
        nth = collections.Counter()
        for e in lst:
            if seen_lab[e[2]] > 1:
                nth[e[2]] += 1
                e[2] = f"{e[2]} n°{nth[e[2]]}"
        if lst:
            prints[code] = lst

    prices = {}
    for lst in prints.values():
        for e in lst:
            for pid in (e[3] if isinstance(e[3], list) else [e[3]] if e[3] else []):
                g = prices_raw.get(pid)
                if g:
                    prices[str(pid)] = [g.get("trend") or g.get("trend-foil"), g.get("low") or g.get("low-foil"), g.get("avg7") or g.get("avg7-foil")]

    out = {"v": datetime.date.today().isoformat(), "img": IMG, "cards": cards, "sets": setnames, "prints": prints, "prices": prices}
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    json.dump(out, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    total = sum(len(l) for l in prints.values())
    print(f"onepiece: codes {len(prints)} | prints {total} | cards {len(cards)} | linked {linked} | multi-version {ambiguous} | "
          f"prices {len(prices)} | asian expansions skipped {len(asian)} | {os.path.getsize(a.out)//1024} KB")


if __name__ == "__main__":
    sys.exit(main())
