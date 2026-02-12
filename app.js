import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";
import { feature } from "https://cdn.jsdelivr.net/npm/topojson-client@3/+esm";
import { geoAirocean } from "https://cdn.skypack.dev/d3-geo-polygon@2";

const DATA_CSV    = "./hostmap_references.csv";
const FOLDERS_CSV = "./domains_by_folder.csv";

const CITOGRAPHY_ROOT = "citography";

const GENT = [3.7174, 51.0543];
const GLOBE_SHRINK = 0.70;
const ROTATE_STEP  = 0.05;

const DOT_RADIUS = 1.6;
const COLOR = (label) => label === "HOST" ? "#111111" : label === "EDGE" ? "#777777" : "#BBBBBB";

const UNFOLD_ZOOM_K = 4;
const UNFOLD_BASE_PX = 10;
const UNFOLD_MAX_PX  = 36;

const EDGE_KW = [
  "CLOUDFLARE","AKAMAI","FASTLY","EDGECAST","CLOUDFRONT",
  "INCAPSULA","IMPERVA","CDN","STACKPATH"
];

function normalizeDomain(raw) {
  const d = (raw || "").trim().toLowerCase();
  return d.startsWith("www.") ? d.slice(4) : d;
}

function isCitographyFolder(fp) {
  const raw = (fp || "").trim().toLowerCase();
  if (!raw) return false;

  // normalize various separators into "/"
  const norm = raw
    .replace(/\\/g, "/")
    .replace(/>/g, "/")
    .replace(/\|/g, "/")
    .replace(/–/g, "-")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, " ")
    .trim();

  const parts = norm.split("/").map(s => s.trim()).filter(Boolean);

  // Accept if ANY segment is exactly "citography"
  return parts.includes(CITOGRAPHY_ROOT);
}

function cleanFolderPath(fp) {
  let s = (fp || "").toString();

  // normalize whitespace + separators
  s = s.replace(/\r?\n+/g, " / ");     // turn line breaks into path separators
  s = s.replace(/\s*>\s*/g, " / ");
  s = s.replace(/\\/g, " / ");
  s = s.replace(/\s*\/\s*/g, " / ");
  s = s.replace(/\s+/g, " ").trim();

  // split into segments
  let parts = s.split(" / ").map(x => x.trim()).filter(Boolean);

  // drop segments that are just numbers like "1"
  parts = parts.filter(seg => !/^\d+$/.test(seg));

  // drop root containers (common names in exports)
  const DROP = new Set([
    "bookmark bar",
    "bookmarks bar",
    "bookmarks toolbar",
    "favorites bar",
    "other bookmarks",
    "mobile bookmarks"
  ]);

  // remove them anywhere they appear
  parts = parts.filter(seg => !DROP.has(seg.toLowerCase()));

  return parts.join(" / ");
}

function classifyHostEdge(domain, org) {
  const hay = ((org || "") + " " + (domain || "")).toUpperCase();
  if (!org) return "UNKNOWN";
  for (const kw of EDGE_KW) if (hay.includes(kw)) return "EDGE";
  return "HOST";
}

// --- DOM ---
let w = window.innerWidth, h = window.innerHeight;

const svg = d3.select("#vis").append("svg")
  .attr("width", w)
  .attr("height", h);

const gAll = svg.append("g");
const gLand = gAll.append("g");
const gPts  = gAll.append("g");

const tip = document.getElementById("tip");
const btnAuto = document.getElementById("autorotate");

const popup = document.getElementById("mapPopup");
const popHeader = document.getElementById("mapPopupHeader");
const popBody   = document.getElementById("mapPopupBody");
const popDomain = document.getElementById("popDomain");
const popTag = document.getElementById("popTag");
const popLink = document.getElementById("popLink");
const popFrame = document.getElementById("mapPopupFrame");
const popFoldersWrap = document.getElementById("popFoldersWrap");
const popClose = document.getElementById("mapPopupClose");

const siteScroll = document.getElementById("siteScroll");
const siteCount = document.getElementById("siteCount");

const graticule = d3.geoGraticule10();


// --- projection ---
let projection = d3.geoOrthographic().rotate([-GENT[0], -GENT[1]]).clipAngle(90);
let path = d3.geoPath(projection);

function forceCenter() {
  if (projection.translate) projection.translate([w/2, h/2]);
}

function setProjection(kind, countries) {
  if (kind === "airocean") projection = geoAirocean();
  else if (kind === "equalEarth") projection = d3.geoEqualEarth();
  else projection = d3.geoOrthographic().rotate([-GENT[0], -GENT[1]]).clipAngle(90);

  try { projection.fitSize([w, h], countries); }
  catch { projection.scale(Math.min(w, h) / 2.2).translate([w/2, h/2]); }

  if (projection.scale) projection.scale(projection.scale() * GLOBE_SHRINK);
  forceCenter();
  path = d3.geoPath(projection);
}

// --- state ---
let currentPoints = [];
let domainFolders = new Map();    // domain -> [{folder_path, bookmark_count}, ...]
let folderToDomains = new Map();  // folder_path -> [domain...]
let domainsOnGlobe = new Set();

// --- world ---
const world = await d3.json("https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json");
const countries = feature(world, world.objects.countries);

// --- zoom ---
const zoom = d3.zoom()
  .scaleExtent([1, 14])
  .filter((event) => event.type === "wheel" || event.type.startsWith("touch"))
  .on("zoom", (event) => {
    gAll.attr("transform", event.transform);
    updateUnfoldingAndSizes();
    if (popup.style.display === "block" && popup.__anchor) positionPopupAtAnchor(popup.__anchor);
  })
  .on("end", (event) => {
    const t = event.transform;
    const nearBaseZoom = t.k <= 1.001;
    const panned = Math.abs(t.x) > 2 || Math.abs(t.y) > 2;
    if (nearBaseZoom && panned) svg.transition().duration(180).call(zoom.transform, d3.zoomIdentity);
  });

svg.call(zoom);

// --- draw world ---
function drawWorld() {
  gLand.selectAll("*").remove();

  gLand.append("path")
    .datum({type:"Sphere"})
    .attr("d", path)
    .attr("fill", "#f6f6f6")
    .attr("stroke", "#999")
    .attr("stroke-width", 0.8);

  gLand.append("path")
    .datum(graticule)
    .attr("d", path)
    .attr("fill", "none")
    .attr("stroke", "#dddddd")
    .attr("stroke-width", 0.6);

  gLand.selectAll("path.country")
    .data(countries.features)
    .join("path")
    .attr("d", path)
    .attr("fill", "#ffffff")
    .attr("stroke", "#c8c8c8")
    .attr("stroke-width", 0.6);
}

// --- tooltip ---
function showTip(evt, d) {
  tip.style.display = "block";
  tip.innerHTML = `<b>${d.domain}</b><br>${d.host_edge}`;
  tip.style.left = (evt.clientX + 12) + "px";
  tip.style.top  = (evt.clientY + 12) + "px";
}

function moveTip(evt) {
  tip.style.left = (evt.clientX + 12) + "px";
  tip.style.top  = (evt.clientY + 12) + "px";
}
function hideTip() { tip.style.display = "none"; }

// --- projection helpers ---
function projectPoint(d) {
  const p = projection([d.lon, d.lat]);
  if (!p) return null;

  if (projection.clipAngle && projection.clipAngle() === 90) {
    const center = projection.invert([w/2, h/2]);
    if (center) {
      const a = d3.geoDistance([d.lon, d.lat], center);
      if (a > Math.PI / 2 + 1e-6) return null;
    }
  }
  return p;
}

function drawGentMarker() {
  const p = projectPoint({ lon: GENT[0], lat: GENT[1] });
  if (!p) return;

  gPts.append("circle")
    .attr("class", "gent")
    .attr("cx", p[0]).attr("cy", p[1])
    .attr("r", DOT_RADIUS)
    .attr("fill", "#d100d1");

  gPts.append("text")
    .attr("class", "gentlabel")
    .attr("x", p[0] + 7).attr("y", p[1] + 4)
    .text("Gent")
    .attr("font-size", 11)
    .attr("fill", "#d100d1")
    .attr("font-weight", 700);
}

// --- popup sizing fix ---
function syncPopupBodyHeight() {
  // compute body height based on actual rendered header height
  const totalH = popup.getBoundingClientRect().height;
  const headerH = popHeader.getBoundingClientRect().height;
  const bodyH = Math.max(120, totalH - headerH); // keep sane minimum
  popBody.style.height = bodyH + "px";
  popFrame.style.height = bodyH + "px";
}

function closePopup() {
  popup.style.display = "none";
  popup.__domain = null;
  popup.__anchor = null;
  popFrame.src = "about:blank";
}
popClose.addEventListener("click", closePopup);
window.addEventListener("keydown", (e) => { if (e.key === "Escape") closePopup(); });
window.addEventListener("mousedown", (e) => {
  if (popup.style.display === "block" && !popup.contains(e.target)) closePopup();
});

function positionPopupAtAnchor(anchor) {
  const t = d3.zoomTransform(svg.node());
  const x = anchor[0] * t.k + t.x;
  const y = anchor[1] * t.k + t.y;

  const pad = 12;
  let left = x + pad;
  let top  = y - pad;

  const pw = popup.offsetWidth || 560;
  const ph = popup.offsetHeight || 360;

  const maxLeft = w - pw - 10;
  const maxTop  = h - ph - 10;

  if (left > maxLeft) left = x - pw - pad;
  if (top < 10) top = 10;
  if (top > maxTop) top = maxTop;

  popup.style.left = `${left}px`;
  popup.style.top  = `${top}px`;
}

function renderAllFoldersInHeader(domain) {
  const folders = domainFolders.get(domain);
  if (!folders || !folders.length) {
    popFoldersWrap.innerHTML = `<div style="opacity:.7">No folder data</div>`;
    popFoldersWrap.title = "";
    return;
  }

  // Convert to relative folder names (under Citography), remove empties, de-duplicate
  const rel = folders
    .map(f => folderPathRelativeToCitography(f.folder_path))
    .filter(Boolean);

  const unique = Array.from(new Set(rel)).sort((a,b) => a.localeCompare(b));

  popFoldersWrap.innerHTML = unique.map(path => `
    <div class="folderLine">
      <span class="folderPath">${path}</span>
    </div>
  `).join("");

  popFoldersWrap.title = unique.join("\n");
}

function folderPathRelativeToCitography(fp) {
  const raw = (fp || "").toString().trim();
  if (!raw) return "";

  // normalize separators to " / "
  const norm = raw
    .replace(/\r?\n+/g, " / ")
    .replace(/\s*>\s*/g, " / ")
    .replace(/\\/g, " / ")
    .replace(/\s*\/\s*/g, " / ")
    .replace(/\s+/g, " ")
    .trim();

  const parts = norm.split(" / ").map(s => s.trim()).filter(Boolean);
  const idx = parts.findIndex(p => p.toLowerCase() === "citography");

  // keep only what's under Citography
  const rel = idx >= 0 ? parts.slice(idx + 1) : parts;

  return rel.join(" / ");
}

function openPopupForPoint(d) {
  const p = projectPoint(d);
  if (!p) return;

  popDomain.textContent = d.domain;
  popTag.textContent = `${d.host_edge}`;
  popTag.style.color = COLOR(d.host_edge);

  // renderAllFoldersInHeader(d.domain);
  popFoldersWrap.innerHTML = "";

  popLink.href = "https://" + d.domain;
  popFrame.src = "https://" + d.domain;

  popup.style.display = "block";
  popup.__domain = d.domain;
  popup.__anchor = p;

  // IMPORTANT: size body after display is set (so header height is real)
  syncPopupBodyHeight();
  positionPopupAtAnchor(p);
}

// --- highlighting ---
function clearHighlight() {
  gPts.selectAll("circle.site")
    .attr("data-hl", "0")
    .attr("stroke", "none")
    .attr("data-sw", 0)
    .attr("fill-opacity", 0.85);
  applyConstantDotSize();
}
function highlightDomain(domain) {
  clearHighlight();
  const sel = gPts.selectAll("circle.site").filter(d => d.domain === domain);
  sel.raise()
    .attr("data-hl", "1")
    .attr("stroke", "#d100d1")
    .attr("data-sw", 1.4)
    .attr("fill-opacity", 1.0);
  sel.attr("data-rboost", 2.2);
  applyConstantDotSize();
}

// --- sites list grouped by folder ---
function buildSitesGroupedByFolder() {
  siteScroll.innerHTML = "";

  const folders = Array.from(folderToDomains.keys()).sort((a,b) => a.localeCompare(b));
  let totalSites = 0;

  for (const folder of folders) {
    const doms = folderToDomains.get(folder) || [];
    if (!doms.length) continue;
    totalSites += doms.length;

    const grp = document.createElement("div");
    grp.className = "folderGroup";

    const title = document.createElement("div");
    title.className = "folderTitle";
    title.textContent = folder;
    title.title = folder;
    grp.appendChild(title);

    for (const dom of doms) {
      const div = document.createElement("div");
      div.className = "siteItem";
      div.textContent = dom;

      div.addEventListener("mouseenter", () => { highlightDomain(dom); stopAutoRotate(); });
      div.addEventListener("mouseleave", () => {
        clearHighlight();
        if (userWantsAuto && popup.style.display !== "block") startAutoRotate();
      });
      div.addEventListener("click", () => {
        const p = currentPoints.find(x => x.domain === dom);
        if (p) openPopupForPoint(p);
      });

      grp.appendChild(div);
    }

    siteScroll.appendChild(grp);
  }

  siteCount.textContent = `${totalSites}`;
}

// --- constant dot size ---
function applyConstantDotSize() {
  const t = d3.zoomTransform(svg.node());
  const k = t.k || 1;

  gPts.selectAll("circle.site").each(function() {
    const el = d3.select(this);
    const boost = +el.attr("data-rboost") || 0;
    el.attr("r", (DOT_RADIUS + boost) / k);

    const sw = +el.attr("data-sw") || 0;
    el.attr("stroke-width", sw / k);
  });

  gPts.selectAll("circle.gent").attr("r", DOT_RADIUS / k);
  gPts.selectAll("text.gentlabel").attr("font-size", 11 / k);
}

// --- unfolding ---
function hash01(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

function computeUnfoldedPositions(points) {
  const t = d3.zoomTransform(svg.node());
  const k = t.k || 1;
  const unfold = k >= UNFOLD_ZOOM_K;

  const groups = new Map();
  for (const d of points) {
    const key = `${(+d.lat).toFixed(6)},${(+d.lon).toFixed(6)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }

  for (const [, arr] of groups.entries()) {
    if (!unfold || arr.length <= 1) {
      for (const d of arr) { d.__dx = 0; d.__dy = 0; }
      continue;
    }

    const cloudR = Math.min(UNFOLD_MAX_PX, UNFOLD_BASE_PX + Math.sqrt(arr.length) * 10);
    const golden = 2.399963229728653;

    arr.forEach((d, i) => {
      const r1 = hash01(d.domain || String(i));
      const r2 = hash01((d.domain || String(i)) + "#");

      const r = cloudR * Math.sqrt((i + 0.35) / arr.length);
      const a = i * golden + (r1 - 0.5) * 0.8;
      const j = (r2 - 0.5) * (cloudR * 0.18);

      d.__dx = Math.cos(a) * r + j;
      d.__dy = Math.sin(a) * r - j;
    });
  }
}

function pointTransformWithUnfold(d) {
  const p = projectPoint(d);
  if (!p) return "translate(-999,-999)";

  const t = d3.zoomTransform(svg.node());
  const k = t.k || 1;

  const dx = (d.__dx || 0) / k;
  const dy = (d.__dy || 0) / k;

  return `translate(${p[0] + dx},${p[1] + dy})`;
}

function updateUnfoldingAndSizes() {
  if (!currentPoints || currentPoints.length === 0) return;
  computeUnfoldedPositions(currentPoints);
  gPts.selectAll("circle.site").attr("transform", d => pointTransformWithUnfold(d));
  applyConstantDotSize();
}

// --- points ---
function drawPoints(points) {
  currentPoints = points;

  computeUnfoldedPositions(points);
  gPts.selectAll("*").remove();

  gPts.selectAll("circle.site")
    .data(points)
    .join("circle")
    .attr("class", "site")
    .attr("data-sw", 0)
    .attr("data-rboost", 0)
    .attr("transform", d => pointTransformWithUnfold(d))
    .attr("r", DOT_RADIUS)
    .attr("fill", d => COLOR(d.host_edge))
    .attr("fill-opacity", 0.85)
    .style("cursor", "pointer")
    .on("mouseenter", (evt,d) => { showTip(evt,d); stopAutoRotate(); })
    .on("mousemove", moveTip)
    .on("mouseleave", () => { hideTip(); if (popup.style.display !== "block") startAutoRotate(); })
    .on("click", (evt,d) => { evt.preventDefault?.(); evt.stopPropagation?.(); openPopupForPoint(d); });

  drawGentMarker();
  applyConstantDotSize();
}

function redraw() {
  drawWorld();
  drawPoints(currentPoints);

  if (popup.style.display === "block" && popup.__domain) {
    const found = currentPoints.find(x => x.domain === popup.__domain);
    if (found) {
      const np = projectPoint(found);
      if (np) {
        popup.__anchor = np;
        syncPopupBodyHeight();
        positionPopupAtAnchor(np);
      } else {
        closePopup();
      }
    }
  }
}

// --- auto rotate ---
let userWantsAuto = true;
let rotating = false;
let timer = null;

function startAutoRotate() {
  if (!userWantsAuto) return;
  if (timer) return;
  rotating = true;
  btnAuto.classList.add("on");

  timer = d3.timer(() => {
    if (!rotating || !projection.rotate) return;
    const r = projection.rotate();
    projection.rotate([r[0] + ROTATE_STEP, r[1], r[2] || 0]);
    path = d3.geoPath(projection);
    redraw();
  });
}

function stopAutoRotate() {
  rotating = false;
  btnAuto.classList.remove("on");
  if (timer) { timer.stop(); timer = null; }
}

btnAuto.addEventListener("click", () => {
  userWantsAuto = !userWantsAuto;
  if (userWantsAuto) startAutoRotate();
  else stopAutoRotate();
});

// drag rotate
let last = null;
let wasRotatingBeforeDrag = false;
svg.call(
  d3.drag()
    .on("start", (event) => { last = [event.x, event.y]; wasRotatingBeforeDrag = rotating; stopAutoRotate(); })
    .on("drag", (event) => {
      event.sourceEvent?.preventDefault?.();
      if (!last || !projection.rotate) return;

      const dx = event.x - last[0];
      const dy = event.y - last[1];
      last = [event.x, event.y];

      const k = 0.25;
      const r = projection.rotate();
      projection.rotate([r[0] + dx * k, r[1] - dy * k, r[2] || 0]);
      path = d3.geoPath(projection);
      redraw();
    })
    .on("end", () => { last = null; if (wasRotatingBeforeDrag) startAutoRotate(); })
);

// --- data load ---
async function loadData() {
  // 1) Load hostmap CSV (defines what can appear on the globe)
  const hostRows = await d3.csv(DATA_CSV);

  // Domains on globe (normalized, no www.)
  domainsOnGlobe = new Set(
    hostRows.map(r => normalizeDomain(r.domain ?? r.Domain ?? r.host ?? r.hostname ?? ""))
            .filter(Boolean)
  );

  // Build points (only rows with lat/lon)
  const pts = hostRows.map(r => {
    const domain = normalizeDomain(r.domain ?? r.Domain ?? r.host ?? r.hostname ?? "");
    const org = (r.org ?? r.Org ?? r.owner ?? r.holder ?? "").toString().trim();

    const lat = +(r.lat ?? r.latitude ?? r.Lat ?? r.Latitude ?? NaN);
    const lon = +(r.lon ?? r.lng ?? r.longitude ?? r.Lon ?? r.Longitude ?? NaN);

    // tolerate different count fields (bookmark_count preferred)
    const bm = +(r.bookmark_count ?? r.bookmarks ?? r.count ?? r.visits_last7days ?? 0);

    return {
      domain,
      org,
      geo_country: (r.geo_country ?? r.country ?? r.Country ?? "").toString().trim(),
      bookmark_count: bm,
      host_edge: classifyHostEdge(domain, org),
      lat,
      lon
    };
  }).filter(d =>
    d.domain &&
    Number.isFinite(d.lat) &&
    Number.isFinite(d.lon)
  );

  // Reset folder maps
  domainFolders = new Map();
  folderToDomains = new Map();

  // 2) Load folders CSV (optional but needed for grouping + popup folder list)
  try {
    const frows = await d3.csv(FOLDERS_CSV, d => {
      // tolerate different header names
      const domain = normalizeDomain(
        d.domain ?? d.Domain ?? d.host ?? d.hostname ?? d.site ?? ""
      );

      const folder_path = cleanFolderPath(
        (d.folder_path ?? d.folder ?? d.path ?? d.Folder ?? d.FOLDER ?? "").toString()
        );

      const bookmark_count = +(
        d.bookmark_count ?? d.count ?? d.Count ?? d.n ?? d.N ?? 1
      );

      return { domain, folder_path, bookmark_count };
    });

    // Filter: only domains that exist on the globe + only Citography folders (anywhere in the path)
    const cit = frows.filter(r =>
      r.domain &&
      domainsOnGlobe.has(r.domain) &&
      isCitographyFolder(r.folder_path)
    );

    // --- domain -> folders (ALL folders, sorted by count desc) ---
    const tmpDom = new Map();
    for (const r of cit) {
      if (!tmpDom.has(r.domain)) tmpDom.set(r.domain, []);
      tmpDom.get(r.domain).push({
        folder_path: r.folder_path,
        bookmark_count: r.bookmark_count
      });
    }
    for (const [dom, arr] of tmpDom.entries()) {
      arr.sort((a, b) =>
        (b.bookmark_count || 0) - (a.bookmark_count || 0) ||
        (a.folder_path || "").localeCompare(b.folder_path || "")
      );
      domainFolders.set(dom, arr); // <-- ALL folders for popup
    }

    // --- folder -> unique domains (sorted) ---
    const tmpFolder = new Map();
    for (const r of cit) {
      const fp = r.folder_path || "Citography";
      if (!tmpFolder.has(fp)) tmpFolder.set(fp, new Set());
      tmpFolder.get(fp).add(r.domain);
    }
    for (const [fp, set] of tmpFolder.entries()) {
      folderToDomains.set(fp, Array.from(set).sort((a, b) => a.localeCompare(b)));
    }
  } catch (e) {
    console.warn("Folders CSV not loaded or not parseable:", e);
  }

  // 3) Fallback so the left list is never empty
  if (!folderToDomains || folderToDomains.size === 0) {
    // If folders missing or Citography filter didn't match, show all globe domains in one group
    const all = Array.from(domainsOnGlobe).sort((a, b) => a.localeCompare(b));
    folderToDomains = new Map([["Citography (no folder match)", all]]);
  }

  // 4) Update UI
  buildSitesGroupedByFolder();

  closePopup();
  drawPoints(pts);
}

// --- init ---
setProjection("ortho_gent", countries);
drawWorld();

loadData().then(() => startAutoRotate())
  .catch(err => console.error("Could not load CSV. Use Live Server / python -m http.server.", err));

document.getElementById("proj").addEventListener("change", (e) => {
  stopAutoRotate();
  setProjection(e.target.value, countries);
  closePopup();
  redraw();
  startAutoRotate();
});

window.addEventListener("resize", () => {
  w = window.innerWidth; h = window.innerHeight;
  svg.attr("width", w).attr("height", h);
  setProjection(document.getElementById("proj").value, countries);
  redraw();
});

// If the popup is open and folders scroll changes header height slightly, keep body correct.
new ResizeObserver(() => {
  if (popup.style.display === "block") syncPopupBodyHeight();
}).observe(popHeader);
