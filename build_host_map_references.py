import json
import csv
import time
import socket
from urllib.parse import urlparse
from collections import Counter, defaultdict
from html.parser import HTMLParser
import urllib.request

# ---------- inputs / outputs ----------
INPUT_HTML = "Bookmarks.html"  # or "/mnt/data/Bookmarks.html"

OUT_BOOKMARKS_CSV = "bookmarks_flat.csv"
OUT_DOMAINS_CSV = "domains_references.csv"
OUT_DOMAIN_FOLDER_CSV = "domains_by_folder.csv"
OUT_HOSTMAP_CSV = "hostmap_references.csv"

# ---------- helpers ----------
def get_domain(url: str) -> str | None:
    try:
        u = urlparse(url)
        host = (u.netloc or "").lower()
        if not host:
            return None
        return host.split(":")[0]  # remove port if present
    except Exception:
        return None

def resolve_ipv4(domain: str) -> str | None:
    """Return one IPv4 A record (first)."""
    try:
        infos = socket.getaddrinfo(domain, None, family=socket.AF_INET)
        if not infos:
            return None
        return infos[0][4][0]
    except Exception:
        return None

def http_json(url: str, headers: dict | None = None) -> dict:
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode("utf-8", errors="replace"))

def ripe_asn(ip: str) -> tuple[str | None, str | None]:
    url = f"https://stat.ripe.net/data/prefix-overview/data.json?resource={ip}"
    try:
        data = http_json(url).get("data", {})
        asns = data.get("asns", [])
        if not asns:
            return None, None
        first = asns[0]
        return str(first.get("asn")), first.get("holder")
    except Exception:
        return None, None

def geo_ip(ip: str) -> tuple[str | None, str | None, float | None, float | None]:
    url = f"http://ip-api.com/json/{ip}?fields=status,country,city,lat,lon"
    try:
        data = http_json(url)
        if data.get("status") != "success":
            return None, None, None, None
        return data.get("country"), data.get("city"), data.get("lat"), data.get("lon")
    except Exception:
        return None, None, None, None

# ---------- Netscape bookmark parser ----------
class BookmarksHTMLParser(HTMLParser):
    """
    Parses the classic Netscape bookmark export format:
    - Folders: <DT><H3>Folder</H3> then <DL>...</DL>
    - Bookmarks: <DT><A HREF="...">Title</A>
    Keeps a folder stack representing the current path.
    """
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.folder_stack: list[str] = []
        self.pending_folder_name: str | None = None
        self.expecting_dl_for_folder = False

        self.in_h3 = False
        self.h3_text_parts: list[str] = []

        self.in_a = False
        self.a_text_parts: list[str] = []
        self.current_a_href: str | None = None
        self.current_a_add_date: str | None = None
        self.current_a_last_modified: str | None = None

        self.items: list[dict] = []

    def handle_starttag(self, tag, attrs):
        attrs_d = dict(attrs)

        if tag.lower() == "h3":
            self.in_h3 = True
            self.h3_text_parts = []
        elif tag.lower() == "dl":
            # A <DL> immediately after a folder header starts that folder's contents
            if self.expecting_dl_for_folder and self.pending_folder_name:
                self.folder_stack.append(self.pending_folder_name)
                self.pending_folder_name = None
                self.expecting_dl_for_folder = False
        elif tag.lower() == "a":
            self.in_a = True
            self.a_text_parts = []
            self.current_a_href = attrs_d.get("href")
            self.current_a_add_date = attrs_d.get("add_date")
            self.current_a_last_modified = attrs_d.get("last_modified")

    def handle_endtag(self, tag):
        t = tag.lower()

        if t == "h3":
            self.in_h3 = False
            name = "".join(self.h3_text_parts).strip()
            if name:
                self.pending_folder_name = name
                self.expecting_dl_for_folder = True
        elif t == "a":
            self.in_a = False
            title = "".join(self.a_text_parts).strip()
            href = (self.current_a_href or "").strip()
            if href:
                folder_path = " / ".join(self.folder_stack) if self.folder_stack else ""
                self.items.append(
                    {
                        "folder_path": folder_path,
                        "title": title,
                        "url": href,
                        "domain": get_domain(href),
                        "add_date": self.current_a_add_date,
                        "last_modified": self.current_a_last_modified,
                    }
                )
            self.current_a_href = None
            self.current_a_add_date = None
            self.current_a_last_modified = None
            self.a_text_parts = []
        elif t == "dl":
            # End of a folder contents block: pop one folder if any
            if self.folder_stack:
                self.folder_stack.pop()

    def handle_data(self, data):
        if self.in_h3:
            self.h3_text_parts.append(data)
        elif self.in_a:
            self.a_text_parts.append(data)

# ---------- main ----------
with open(INPUT_HTML, "r", encoding="utf-8", errors="replace") as f:
    html_text = f.read()

p = BookmarksHTMLParser()
p.feed(html_text)
bookmarks = p.items

# 1) Flat bookmarks export (includes folder path)
with open(OUT_BOOKMARKS_CSV, "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["folder_path", "title", "url", "domain", "add_date", "last_modified"])
    for b in bookmarks:
        w.writerow([
            b.get("folder_path", ""),
            b.get("title", ""),
            b.get("url", ""),
            b.get("domain", ""),
            b.get("add_date", ""),
            b.get("last_modified", ""),
        ])

# 2) Domain counts (bookmark_count)
domains = [b["domain"] for b in bookmarks if b.get("domain")]
counts = Counter(domains)

with open(OUT_DOMAINS_CSV, "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["domain", "bookmark_count"])
    for d, c in counts.most_common():
        w.writerow([d, c])

# 3) Domain x Folder counts (keeps where bookmarks live)
domain_folder_counts = defaultdict(int)
for b in bookmarks:
    d = b.get("domain")
    if not d:
        continue
    fp = b.get("folder_path", "")
    domain_folder_counts[(d, fp)] += 1

with open(OUT_DOMAIN_FOLDER_CSV, "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["domain", "folder_path", "bookmark_count"])
    # sort by count desc
    for (d, fp), c in sorted(domain_folder_counts.items(), key=lambda x: x[1], reverse=True):
        w.writerow([d, fp, c])

# 4) Hostmap for top N domains (same enrichment as your original script)
TOP_N = 1000
rows = []
for d, c in counts.most_common(TOP_N):
    ip = resolve_ipv4(d)
    asn, org = (None, None)
    country, city, lat, lon = (None, None, None, None)
    if ip:
        asn, org = ripe_asn(ip)
        country, city, lat, lon = geo_ip(ip)
        time.sleep(1.0)  # be polite to the geo API (rate limiting)
    rows.append([d, c, ip, asn, org, country, city, lat, lon])

with open(OUT_HOSTMAP_CSV, "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["domain", "bookmark_count", "ipv4", "asn", "org", "geo_country", "geo_city", "lat", "lon"])
    w.writerows(rows)

print(f"Saved: {OUT_BOOKMARKS_CSV}")
print(f"Saved: {OUT_DOMAINS_CSV}")
print(f"Saved: {OUT_DOMAIN_FOLDER_CSV}")
print(f"Saved: {OUT_HOSTMAP_CSV}")
