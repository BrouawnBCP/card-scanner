"""Download the testers' feedback from the Discord server (read-only bot).

Reads every post of the forum channels (#bugs, #suggestions: title, tags, messages, 👍 count,
screenshots) and the latest messages of the text channels, then writes:
  feedback/discord.md        readable summary, one section per post
  feedback/discord.json      same data, complete
  feedback/attachments/...   screenshots and videos attached to the posts

The bot key is read from discord-token.txt at the project root (or the DISCORD_TOKEN variable).
Both feedback/ and discord-token.txt stay off GitHub (.gitignore): they hold private messages and a secret.

Usage:  python tools/discord_feedback.py            (all channels)
        python tools/discord_feedback.py --since 2026-11-01
"""
import argparse, datetime, json, os, re, sys, time, urllib.error, urllib.request

API = "https://discord.com/api/v10"
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
OUT = os.path.join(ROOT, "feedback")
UA = "DiscordBot (https://github.com/BrouawnBCP/card-scanner, 1.0)"
TEXT_HISTORY = 200  # messages kept per ordinary text channel


def token():
    t = os.environ.get("DISCORD_TOKEN", "").strip()
    p = os.path.join(ROOT, "discord-token.txt")
    if not t and os.path.exists(p):
        for line in open(p, encoding="utf-8-sig"):
            line = line.strip()
            if line and not line.startswith("#"):
                t = line
                break
    if not t:
        sys.exit("Clé du bot absente : colle-la dans discord-token.txt (à la racine du projet).")
    return t


def call(path, tok, params=None):
    url = API + path + ("?" + "&".join(f"{k}={v}" for k, v in params.items() if v is not None) if params else "")
    for _ in range(6):
        req = urllib.request.Request(url, headers={"Authorization": "Bot " + tok, "User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            if e.code == 429:  # rate limited: wait as asked
                time.sleep(float(json.loads(body).get("retry_after", 1)) + 0.2)
                continue
            if e.code == 401:
                sys.exit("Clé du bot refusée (401) : vérifie le contenu de discord-token.txt.")
            if e.code == 403:
                return None  # channel the bot cannot see
            raise SystemExit(f"Erreur Discord {e.code} sur {path} : {body[:200]}")
    raise SystemExit("Discord limite trop les requêtes, réessaie dans une minute.")


def messages(cid, tok, limit=None):
    out, before = [], None
    while True:
        batch = call(f"/channels/{cid}/messages", tok, {"limit": 100, "before": before})
        if not batch:
            break
        out += batch
        before = batch[-1]["id"]
        if len(batch) < 100 or (limit and len(out) >= limit):
            break
    out.reverse()  # oldest first
    return out[-limit:] if limit else out


def slug(s):
    return re.sub(r"[^A-Za-z0-9._-]+", "-", s).strip("-")[:60] or "x"


def save_attachments(msgs, folder):
    files = []
    for m in msgs:
        for a in m.get("attachments", []):
            os.makedirs(folder, exist_ok=True)
            p = os.path.join(folder, f"{m['id']}-{slug(a['filename'])}")
            if not os.path.exists(p):
                try:
                    req = urllib.request.Request(a["url"], headers={"User-Agent": UA})
                    with urllib.request.urlopen(req, timeout=120) as r:
                        open(p, "wb").write(r.read())
                except Exception as e:  # an attachment that cannot be fetched does not stop the export
                    print("  pièce jointe non récupérée :", a["filename"], e)
                    continue
            files.append(os.path.relpath(p, ROOT).replace("\\", "/"))
    return files


def who(m):
    a = m.get("author", {})
    return a.get("global_name") or a.get("username") or "?"


def simple(m):
    return {"id": m["id"], "author": who(m), "date": m["timestamp"][:16].replace("T", " "), "text": m.get("content", ""),
            "attachments": [a["filename"] for a in m.get("attachments", [])]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", help="only posts with activity since this date (YYYY-MM-DD)")
    a = ap.parse_args()
    since = a.since
    tok = token()

    guilds = call("/users/@me/guilds", tok) or []
    if not guilds:
        sys.exit("Le bot n'est sur aucun serveur : invite-le avec le lien du guide.")
    report = {"generated": datetime.datetime.now().isoformat(timespec="minutes"), "servers": []}
    for g in guilds:
        gid = g["id"]
        chans = call(f"/guilds/{gid}/channels", tok) or []
        active = (call(f"/guilds/{gid}/threads/active", tok) or {}).get("threads", [])
        srv = {"name": g["name"], "forums": [], "channels": []}
        for ch in sorted(chans, key=lambda c: c.get("position", 0)):
            if ch["type"] == 15:  # forum: one thread per post
                tags = {t["id"]: t["name"] for t in ch.get("available_tags", [])}
                threads = [t for t in active if t.get("parent_id") == ch["id"]]
                before = None
                while True:  # archived posts too (closed or inactive)
                    r = call(f"/channels/{ch['id']}/threads/archived/public", tok, {"limit": 100, "before": before}) or {}
                    threads += r.get("threads", [])
                    if not r.get("has_more") or not r.get("threads"):
                        break
                    before = r["threads"][-1]["thread_metadata"]["archive_timestamp"]
                posts = []
                for t in threads:
                    msgs = messages(t["id"], tok)
                    if not msgs:
                        continue
                    last = msgs[-1]["timestamp"]
                    if since and last[:10] < since:
                        continue
                    starter = msgs[0]
                    likes = sum(x.get("count", 0) for x in starter.get("reactions", []) if x.get("emoji", {}).get("name") in ("👍", "❤️", "🔥", "⬆️"))
                    files = save_attachments(msgs, os.path.join(OUT, "attachments", slug(ch["name"]), slug(t["name"])))
                    posts.append({"title": t["name"], "tags": [tags.get(x, x) for x in t.get("applied_tags", [])],
                                  "author": who(starter), "created": starter["timestamp"][:10], "last_activity": last[:16].replace("T", " "),
                                  "closed": bool(t.get("thread_metadata", {}).get("archived")), "likes": likes,
                                  "url": f"https://discord.com/channels/{gid}/{t['id']}",
                                  "messages": [simple(m) for m in msgs], "files": files})
                posts.sort(key=lambda p: p["last_activity"], reverse=True)
                srv["forums"].append({"name": ch["name"], "posts": posts})
                print(f"#{ch['name']} : {len(posts)} post(s)")
            elif ch["type"] in (0, 5):  # text / announcement channel
                msgs = messages(ch["id"], tok, TEXT_HISTORY) if call(f"/channels/{ch['id']}", tok) else []
                if since:
                    msgs = [m for m in msgs if m["timestamp"][:10] >= since]
                if msgs:
                    files = save_attachments(msgs, os.path.join(OUT, "attachments", slug(ch["name"])))
                    srv["channels"].append({"name": ch["name"], "messages": [simple(m) for m in msgs], "files": files})
                    print(f"#{ch['name']} : {len(msgs)} message(s)")
        report["servers"].append(srv)

    os.makedirs(OUT, exist_ok=True)
    json.dump(report, open(os.path.join(OUT, "discord.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    md = [f"# Retours Discord — {report['generated']}\n"]
    for srv in report["servers"]:
        md.append(f"## Serveur {srv['name']}\n")
        for f in srv["forums"]:
            md.append(f"### Forum #{f['name']} ({len(f['posts'])} posts)\n")
            for p in f["posts"]:
                md.append(f"#### {p['title']}\n- Étiquettes : {', '.join(p['tags']) or '—'} · par {p['author']} le {p['created']} · "
                          f"dernière activité {p['last_activity']} · 👍 {p['likes']}{' · fermé' if p['closed'] else ''}\n- Lien : {p['url']}\n")
                for m in p["messages"]:
                    extra = f" [pièces jointes : {', '.join(m['attachments'])}]" if m["attachments"] else ""
                    md.append(f"> **{m['author']}** ({m['date']}) : {m['text']}{extra}\n")
                if p["files"]:
                    md.append("Fichiers : " + ", ".join(p["files"]) + "\n")
        for c in srv["channels"]:
            md.append(f"### Salon #{c['name']} ({len(c['messages'])} messages)\n")
            for m in c["messages"]:
                extra = f" [pièces jointes : {', '.join(m['attachments'])}]" if m["attachments"] else ""
                md.append(f"> **{m['author']}** ({m['date']}) : {m['text']}{extra}\n")
    open(os.path.join(OUT, "discord.md"), "w", encoding="utf-8").write("\n".join(md))
    print("Export terminé : feedback/discord.md")


if __name__ == "__main__":
    main()
