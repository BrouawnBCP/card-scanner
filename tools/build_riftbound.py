"""Build the Riftbound card database used by the web app.

Sources (downloaded fresh unless --cache is given):
  - the official Riftbound card gallery (names, set codes, rarities, images)
  - Cardmarket public product list + price guide for Riftbound (idGame 22)

Output: app/data/riftbound.json, same shape as cards.json plus a few Riftbound fields:
  {
    "v": build date,
    "img": image address prefix (thumbnail = img + cards[i][2] + "?w=112&fm=webp"),
    "cards": [[nameEN, nameFR, imageFile], ...],
    "sets":  [setName, ...],
    "totals": {"VEN": 166, ...}           # number printed after the slash, per set code
    "prints": {"VEN-136A": [[cardIdx, setIdx, rarity, cmId, cmVersions]]},
    "prices": {"cmId": [trend, low, avg7]} # foil prices for Rare and above (always foil in boosters)
  }
"""
import argparse, collections, datetime, html, json, os, re, sys, urllib.request

GALLERY = "https://riftbound.leagueoflegends.com/{}/card-gallery/"
CM_PRODUCTS = "https://downloads.s3.cardmarket.com/productCatalog/productList/products_singles_22.json"
CM_PRICES = "https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_22.json"
IMG = "https://cmsassets.rgpub.io/sanity/images/dsfx7636/game_data_live/"
HERE = os.path.dirname(os.path.abspath(__file__))
RARITY = {"common": "Common", "uncommon": "Uncommon", "rare": "Rare", "epic": "Epic", "showcase": "Showcase"}
FOIL = {"Rare", "Epic", "Showcase"}


def fetch(url, cache, name, raw=False):
    p = os.path.join(cache, name) if cache else None
    if p and os.path.exists(p):
        data = open(p, "rb").read()
    else:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (card-scanner-data-build)"})
        with urllib.request.urlopen(req, timeout=300) as r:
            data = r.read()
        if p:
            os.makedirs(cache, exist_ok=True)
            open(p, "wb").write(data)
    text = data.decode("utf-8")
    return text if raw else json.loads(text)


def gallery_cards(page):
    m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', page, re.S)
    if not m:
        raise SystemExit("card gallery: page data not found (site changed?)")
    found = {}
    def walk(o):
        if isinstance(o, dict):
            if "publicCode" in o and "collectorNumber" in o:
                found[o["id"]] = o
                return
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(json.loads(m.group(1)))
    return list(found.values())


def full_name(c):
    return html.unescape(c["name"] + (", " + c["subtitle"] if c.get("subtitle") else ""))


def norm(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())


def split_code(code):
    """'VEN-136a/166' -> ('VEN', '136A', 166); 'VEN-R01' -> ('VEN', 'R01', None)."""
    m = re.match(r"^([A-Z0-9]+)-([A-Z]{0,2}\d+[A-Z*]?)(?:/(\d+))?$", code.strip().upper())
    if not m:
        return None, None, None
    return m.group(1), m.group(2), int(m.group(3)) if m.group(3) else None


def variant_order(c):
    """Order in which Cardmarket lists the versions of one card: normal, alternate art, overnumbered, signed."""
    _, num, _ = split_code(c["publicCode"])
    d = int(re.sub(r"\D", "", num) or 0)
    return (num.endswith("*"), not num[0].isdigit(), d, num)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(HERE, "..", "app", "data", "riftbound.json"))
    ap.add_argument("--cache", help="folder to reuse downloaded sources (local dev)")
    a = ap.parse_args()

    en = gallery_cards(fetch(GALLERY.format("en-us"), a.cache, "rb_gallery_en.html", raw=True))
    fr = {}  # the French gallery shows the English names: cards keep their English name
    products = fetch(CM_PRODUCTS, a.cache, "rb_cm_products.json")["products"]
    prices_raw = {g["idProduct"]: g for g in fetch(CM_PRICES, a.cache, "rb_cm_prices.json")["priceGuides"]}

    # ---- Cardmarket expansion of each set: the one sharing the most card names ----
    exp_products = collections.defaultdict(lambda: collections.defaultdict(list))
    for p in sorted(products, key=lambda p: p["idProduct"]):
        exp_products[p["idExpansion"]][norm(p["name"])].append(p)
    set_names = collections.defaultdict(set)
    for c in en:
        set_names[c["set"]["value"]["id"]].add(norm(full_name(c)))
    set_exp = {}
    for s, names in set_names.items():
        best = max(exp_products, key=lambda e: len(names & set(exp_products[e])), default=None)
        if best and len(names & set(exp_products[best])) >= 0.5 * len(names):
            set_exp[s] = best

    # ---- cards grouped by set + name, so their versions line up with Cardmarket's ----
    groups = collections.defaultdict(list)
    for c in en:
        groups[(c["set"]["value"]["id"], norm(full_name(c)))].append(c)

    cards, card_idx, setnames, set_idx, prints = [], {}, [], {}, {}
    linked = ambiguous = 0
    for (s, nn), cs in groups.items():
        cs.sort(key=variant_order)
        exp = exp_products.get(set_exp.get(s), {})
        ps = exp.get(nn, [])
        cm_name = None
        if not ps:
            # Legends are sold as "Champion, Title" (e.g. "Lee Sin, Blind Monk")
            hits = [k for k in exp if k.endswith(nn) and k != nn]
            if len(hits) == 1:
                ps = exp[hits[0]]
        if ps:
            cm_name = ps[0]["name"]
        for i, c in enumerate(cs):
            setc, num, total = split_code(c["publicCode"])
            if not setc:
                continue
            name = cm_name or full_name(c)
            img = (c.get("cardImage") or {}).get("url", "")
            img = img[len(IMG):].split("?")[0] if img.startswith(IMG) else ""
            ck = (name, img)
            if ck not in card_idx:
                card_idx[ck] = len(cards)
                cards.append([name, fr.get(c["id"], "") if fr.get(c["id"], "") != full_name(c) else "", img])
            sn = c["set"]["value"]["label"]
            if sn not in set_idx:
                set_idx[sn] = len(setnames); setnames.append(sn)
            rarity = RARITY.get(c["rarity"]["value"]["id"], c["rarity"]["value"]["label"])
            if len(ps) == len(cs):
                cm = ps[i]["idProduct"]; linked += 1
            elif len(ps) == 1:
                cm = ps[0]["idProduct"]; linked += 1
            elif ps:
                cm = [p["idProduct"] for p in ps][:8]; ambiguous += 1
            else:
                cm = 0
            prints.setdefault(f"{setc}-{num}", []).append([card_idx[ck], set_idx[sn], rarity, cm, len(ps)])

    # ---- prices: Rare and above are foil cards ----
    prices = {}
    for lst in prints.values():
        for e in lst:
            for pid in (e[3] if isinstance(e[3], list) else [e[3]] if e[3] else []):
                g = prices_raw.get(pid)
                if not g:
                    continue
                foil = e[2] in FOIL or not g.get("trend")
                t = (g.get("trend-foil") or g.get("trend")) if foil else g.get("trend")
                low = (g.get("low-foil") or g.get("low")) if foil else g.get("low")
                avg7 = (g.get("avg7-foil") or g.get("avg7")) if foil else g.get("avg7")
                avg1 = (g.get("avg1-foil") or g.get("avg1")) if foil else g.get("avg1")
                prices[str(pid)] = [t, low, avg7, avg1]

    # the sets' own totals (the number after the slash), from the regular collector numbers
    counts = collections.defaultdict(collections.Counter)
    for c in en:
        setc, num, total = split_code(c["publicCode"])
        if setc and total and num[0].isdigit() and not num.endswith("*"):
            counts[setc][total] += 1
    totals = {k: v.most_common(1)[0][0] for k, v in counts.items()}

    out = {"v": datetime.date.today().isoformat(), "img": IMG, "cards": cards, "sets": setnames, "totals": totals, "prints": prints, "prices": prices}
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    json.dump(out, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    total = sum(len(l) for l in prints.values())
    print(f"riftbound: cards {len(cards)} | prints {total} | sets {len(setnames)} {totals} | "
          f"linked {linked} | multi-version {ambiguous} | prices {len(prices)} | {os.path.getsize(a.out)//1024} KB")


if __name__ == "__main__":
    sys.exit(main())
