"""Post a "new version" message in the Discord #nouveautés channel (run by the GitHub workflow).

Only when the app version (APP_VERSION in app/app.js) changed in this push. The message:
  title  = "Version 34"
  text   = the Summary (and description) of each commit of the push, as written in GitHub Desktop

Environment (set by the workflow):
  DISCORD_WEBHOOK  webhook address of the channel (GitHub secret; nothing is posted without it)
  OLD_VERSION      version before the push ("" if unknown)
  COMMITS          JSON list of the push's commits (github.event.commits)
  --dry-run        print the message instead of sending it
"""
import json, os, re, sys, urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
SITE = "https://brouawnbcp.github.io/card-scanner/"


def current_version():
    m = re.search(r'APP_VERSION = "(\d+)"', open(os.path.join(ROOT, "app", "app.js"), encoding="utf-8-sig").read())
    return m.group(1) if m else ""


def notes(commits):
    out = []
    for c in commits:
        msg = (c.get("message") or "").strip()
        if not msg or msg.lower().startswith("merge "):
            continue
        title, _, body = msg.partition("\n")
        line = f"• **{title.strip()}**"
        body = "\n".join(f"  {l.strip()}" for l in body.strip().splitlines() if l.strip())
        out.append(line + ("\n" + body if body else ""))
    return "\n".join(out) or "• Améliorations et corrections"


def main():
    dry = "--dry-run" in sys.argv
    new, old = current_version(), os.environ.get("OLD_VERSION", "").strip()
    if not new or new == old:
        print(f"Version inchangée ({new}) : pas d'annonce.")
        return
    hook = os.environ.get("DISCORD_WEBHOOK", "").strip()
    if not hook and not dry:
        print("Secret DISCORD_WEBHOOK absent : pas d'annonce.")
        return
    commits = json.loads(os.environ.get("COMMITS") or "[]")
    payload = {
        "username": "Card Scanner",
        "avatar_url": SITE + "icons/icon-192.png",
        "embeds": [{
            "title": f"🚀 Version {new}",
            "url": SITE,
            "description": notes(commits)[:3900] + f"\n\n📱 Ferme puis rouvre l'appli pour avoir la mise à jour (Réglages → « Version {new} »).",
            "color": 0xE2B04A,
            "thumbnail": {"url": SITE + "icons/icon-192.png"},
        }],
        "allowed_mentions": {"parse": []},
    }
    if dry:
        print(json.dumps(payload, ensure_ascii=False, indent=1))
        return
    req = urllib.request.Request(hook, data=json.dumps(payload).encode("utf-8"), method="POST",
                                 headers={"Content-Type": "application/json", "User-Agent": "card-scanner-release"})
    with urllib.request.urlopen(req, timeout=30) as r:
        print("Annonce publiée sur Discord", r.status)


if __name__ == "__main__":
    main()
