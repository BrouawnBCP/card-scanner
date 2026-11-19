import sys
src, data, out = sys.argv[1:4]
html = open(src, encoding="utf-8").read()
js = open(data, encoding="utf-8").read().replace("</", "<\\/")
tag = '<script type="application/json" id="cards-data">' + js + "</script>\n"
i = html.index("<script>\n(() => {")
open(out, "w", encoding="utf-8").write(html[:i] + tag + html[i:])
print(len(html[:i] + tag + html[i:]))
