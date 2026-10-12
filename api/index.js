// Uptorrent — Stremio addon (zero dependencies, Node 18+)
// Sources: YTS API + EZTV API (direct), optional Torrentio. Works on Vercel and locally.
const http = require("http");

const DEFAULT_ORDER = ["4k", "1440p", "1080p", "720p", "480p", "360p"];
const RES_LABEL = { "4k": "4K", "1440p": "1440p", "1080p": "1080p", "720p": "720p", "480p": "480p", "360p": "360p", other: "Unknown" };
const DEFAULTS = {
  yts: true,
  eztv: true,
  torrentio: false,
  torrentioUrl: "https://torrentio.strem.fun",
  clean: true, // false = Torrentio-style names (compat mode)
  qualityOrder: DEFAULT_ORDER, // order used by the "quality" sort row (first = top)
  resolutions: [], // empty = allow all
  minSeeders: 0,
  limit: 0, // 0 = no limit
  sort: [
    { by: "quality", dir: "desc" },
    { by: "balanced", dir: "desc" },
  ],
};

// Public mirrors, queried in parallel (first good answer wins)
const YTS_HOSTS = ["https://yts.gg", "https://yts.bz", "https://yts.lt", "https://yts.am", "https://yts.ag"];
const EZTV_HOSTS = ["https://eztvx.to", "https://eztv1.xyz", "https://eztv.wf", "https://eztv.tf", "https://eztv.yt"];
const TRACKERS = [
  "udp://open.demonii.com:1337/announce",
  "udp://tracker.openbittorrent.com:80",
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://p4p.arenabg.com:1337",
  "udp://tracker.leechers-paradise.org:6969",
  "udp://tracker.coppersurfer.tk:6969",
];

function buildManifest(origin) {
  return {
    id: "community.uptorrent",
    version: "1.1.0",
    name: "Uptorrent",
    description: "YTS + EZTV with smart filtering and sorting by quality, size and seeders.",
    logo: `${origin}/logo.png`,
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: [],
    behaviorHints: { configurable: true, configurationRequired: false },
  };
}

// ---------- uploader / release group (MeGusta, GRACE, ELiTE, ETHEL ...) ----------
const SITE_TAG = /^(eztv[\w.]*|rarbg|tgx|1337x|rartv|ettv|torrentgalaxy|thepiratebay|tpb)$/i;
const TECH_WORD = /^(\d{3,4}p|bluray|web[-. ]?dl|webrip|web|x26[45]|hevc|h26[45]|avc|aac|ac3|dts|ddp?|dd\+|\d+bit|hdr|remux|dl|rip|dlrip|hd|mkv|mp4|\d\.\d)$/i;
const TECH_BEFORE = /(\d{3,4}p|bluray|web|hdtv|x26|hevc|h\.?26|avc|dvdrip|remux|aac|ddp|dts|hdr)/i;
const okGroup = (g) => g && /[a-z]/i.test(g) && !TECH_WORD.test(g) && !/^(s\d+e\d+|e\d+|\d+x\d+)$/i.test(g);

function getGroup(line) {
  let t = line.trim().replace(/\.(mkv|mp4|avi|m4v|mov|ts|wmv)$/i, "");
  // drop trailing site tags like [EZTVx.to] / [eztv.re] / [TGx]
  for (;;) {
    const m = /\s*\[([^\]]+)\]$/.exec(t);
    if (m && SITE_TAG.test(m[1].trim())) t = t.slice(0, m.index);
    else break;
  }
  let m = /-\s?\[([^\]]{2,20})\]$/.exec(t); // ...-[YTS.MX]
  if (m && okGroup(m[1])) return m[1];
  m = /-([A-Za-z0-9]{2,15})$/.exec(t); // ...H264-MeGusta
  if (m && okGroup(m[1]) && TECH_BEFORE.test(t.slice(0, m.index))) return m[1];
  m = /\[([^\]]{2,16})\]$/.exec(t); // ... [GRP]
  if (m && okGroup(m[1].trim())) return m[1].trim();
  m = /^\[([^\]]{2,20})\]/.exec(t); // [SubsPlease] ...
  if (m && okGroup(m[1])) return m[1];
  return "";
}

// ---------- parsing a stream's text (Torrentio format) ----------
function parse(s) {
  const name = s.name || "";
  const raw = s.title || s.description || "";
  const lines = raw.split("\n");
  const infoIdx = lines.findIndex((l) => /👤|💾|⚙/.test(l));
  const relText = (infoIdx === -1 ? lines : lines.slice(0, infoIdx)).join(" ");
  const all = `${name} ${relText}`;
  const has = (re) => re.test(all);

  // resolution (Torrentio's own label in `name` is the most reliable)
  const detectRes = (t) =>
    /2160p|\b4k\b/i.test(t) ? "4k"
    : /1440p/i.test(t) ? "1440p"
    : /1080p/i.test(t) ? "1080p"
    : /720p/i.test(t) ? "720p"
    : /480p/i.test(t) ? "480p"
    : /360p/i.test(t) ? "360p"
    : "";
  const res = detectRes(name) || detectRes(relText) || "other";

  // seeders + size
  const sm = /👤\s*(\d+)/.exec(raw);
  const seeders = sm ? parseInt(sm[1], 10) : 0;
  const zm = /💾\s*([\d.]+)\s*(TB|GB|MB|KB)/i.exec(raw);
  const mult = zm ? { KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[zm[2].toUpperCase()] : 0;
  const size = zm ? parseFloat(zm[1]) * mult : 0;
  const sizeText = zm ? `${zm[1]} ${zm[2].toUpperCase()}` : "";

  // provider + languages
  const provIdx = lines.findIndex((l) => /⚙/.test(l));
  let provider = "";
  if (provIdx !== -1) {
    const pm = /⚙\uFE0F?\s*(.+)$/.exec(lines[provIdx]);
    provider = pm ? pm[1].trim() : "";
  }
  const langs = provIdx !== -1 ? lines.slice(provIdx + 1).join(" ").trim() : "";

  // debrid tag like [RD+]
  const dm = /^\[([^\]]+)\]/.exec(name);
  const debrid = dm ? dm[1] : "";

  // tech info
  const source = has(/remux/i) ? "REMUX"
    : has(/blu-?ray|bdrip|brrip/i) ? "BluRay"
    : has(/web-?dl/i) ? "WEB-DL"
    : has(/webrip/i) ? "WEBRip"
    : has(/\bweb\b/i) ? "WEB"
    : has(/hdtv/i) ? "HDTV"
    : has(/dvdrip|\bdvd\b/i) ? "DVD"
    : has(/\b(hdcam|cam|telesync)\b/i) ? "CAM"
    : "";
  const codec = has(/x265|hevc|h\.?265/i) ? "HEVC" : has(/x264|h\.?264|\bavc\b/i) ? "H.264" : has(/\bav1\b/i) ? "AV1" : "";
  const hdr = [];
  if (has(/dolby.?vision|\bdv\b|\bdovi\b/i)) hdr.push("DV");
  if (has(/hdr10\+/i)) hdr.push("HDR10+");
  else if (has(/hdr/i)) hdr.push("HDR");
  const bit = has(/10.?bit/i) ? "10-bit" : "";
  let audio = has(/atmos/i) ? "Atmos"
    : has(/truehd/i) ? "TrueHD"
    : has(/dts-?hd|dts-?x/i) ? "DTS-HD"
    : has(/dts/i) ? "DTS"
    : has(/ddp|dd\+|e-?ac-?3/i) ? "DD+"
    : has(/dd5|ac-?3|\bdd2/i) ? "DD"
    : has(/aac/i) ? "AAC"
    : "";
  const ch = /\b(7\.1|5\.1|2\.0)\b/.exec(all);
  if (audio && ch) audio += ` ${ch[1]}`;

  // release group / uploader: try the last line first (usually the file name), then earlier lines
  let group = "";
  const relLines = (infoIdx === -1 ? lines : lines.slice(0, infoIdx)).map((l) => l.trim()).filter(Boolean);
  for (const l of relLines.slice().reverse()) {
    group = getGroup(l);
    if (group) break;
  }

  // episode / pack
  let ep = "";
  const em = /S(\d{1,2})E(\d{1,3})/i.exec(all);
  if (em) ep = `S${em[1].padStart(2, "0")}E${em[2].padStart(2, "0")}`;
  else if (has(/\bS\d{1,2}\b|season\s*\d+|complete/i)) ep = "Season pack";

  return { res, seeders, size, sizeText, provider, langs, debrid, source, codec, hdr, bit, audio, group, ep };
}

// ---------- clean stream name/description ----------
function decorate(s, p) {
  const tag = p.debrid ? `[${p.debrid}] ` : "";
  const name = `${tag}Uptorrent\n${RES_LABEL[p.res]}`;
  const tech = [p.source, p.codec, ...p.hdr, p.bit, p.audio].filter(Boolean).join(" · ");
  const lines = [
    `🎬 ${tech || "No tech info"}`,
    `💾 ${p.sizeText || "?"}  ·  👤 ${p.seeders} seeders`,
    `🔗 ${[p.provider || "Unknown", p.group && !p.group.toLowerCase().startsWith((p.provider || "").toLowerCase()) ? p.group : "", p.ep].filter(Boolean).join(" · ")}`,
  ];
  if (p.langs) lines.push(`🌐 ${p.langs}`);
  return { ...s, name, title: lines.join("\n") };
}

// Final output. clean=true -> Uptorrent format; clean=false -> Torrentio-style (compat)
function finalize(x, clean) {
  if (clean) return decorate(x.s, x.p);
  if (x.fn === undefined) return x.s; // untouched Torrentio stream
  return {
    ...x.s,
    name: `Uptorrent\n${RES_LABEL[x.p.res]}`,
    title: `${x.fn}\n👤 ${x.p.seeders} 💾 ${x.p.sizeText || "?"} ⚙️ ${x.p.provider}`,
  };
}

// ---------- helpers ----------
const fmtSize = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${Math.round(b / 1e6)} MB`);
const normRes = (q) =>
  /2160/.test(q) ? "4k" : /1440/.test(q) ? "1440p" : /1080/.test(q) ? "1080p" : /720/.test(q) ? "720p" : /480/.test(q) ? "480p" : /360/.test(q) ? "360p" : "other";

async function getJSON(url, ms = 6500) {
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    signal: AbortSignal.timeout(ms),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
// Try several mirrors at once, return the first that answers
async function firstOk(urls) {
  try {
    return await Promise.any(urls.map((u, i) => getJSON(u).then((data) => ({ data, i }))));
  } catch (e) {
    throw new Error((e.errors && e.errors[0] && e.errors[0].message) || e.message);
  }
}

// Build a stream entry for a torrent we found through an API
function direct({ hash, filename, seeders, bytes, provider, over = {} }) {
  const p = parse({ name: "", title: `${filename}\n👤 ${seeders} 💾 ${fmtSize(bytes)} ⚙️ ${provider}` });
  p.provider = provider;
  p.size = Number(bytes) || p.size;
  Object.assign(p, over);
  const infoHash = String(hash).toLowerCase();
  const s = {
    infoHash,
    sources: [...TRACKERS.map((t) => `tracker:${t}`), `dht:${infoHash}`],
    behaviorHints: { bingeGroup: `uptorrent|${p.res}`, filename },
  };
  return { s, p, res: p.res, seeders: p.seeders, size: p.size, fn: filename };
}

// ---------- sources ----------
async function fromYTS(type, id) {
  if (type !== "movie") return [];
  const imdb = id.split(":")[0];
  const { data: d } = await firstOk(YTS_HOSTS.map((h) => `${h}/api/v2/list_movies.json?query_term=${imdb}`));
  const out = [];
  for (const m of (d.data && d.data.movies) || []) {
    if (m.imdb_code && m.imdb_code !== imdb) continue;
    for (const t of m.torrents || []) {
      const over = { res: normRes(String(t.quality)) };
      if (/x265/i.test(t.video_codec || "")) over.codec = "HEVC";
      else if (/x264/i.test(t.video_codec || "")) over.codec = "H.264";
      if (String(t.bit_depth) === "10") over.bit = "10-bit";
      const item = direct({
        hash: t.hash,
        filename: `${m.title_long || m.title} ${t.quality} ${t.type || ""} ${t.video_codec || ""}`.replace(/\s+/g, " ").trim(),
        seeders: t.seeds || 0,
        bytes: t.size_bytes || 0,
        provider: "YTS",
        over,
      });
      if (t.audio_channels && !item.p.audio) item.p.audio = String(t.audio_channels);
      if (t.type === "bluray") item.p.source = "BluRay";
      else if (t.type === "web") item.p.source = "WEB";
      out.push(item);
    }
  }
  return out;
}

async function fromEZTV(type, id) {
  if (type !== "series") return [];
  const [tt, se, ep] = id.split(":");
  const imdb = tt.replace(/^tt/, "");
  const url = (h, page) => `${h}/api/get-torrents?imdb_id=${imdb}&limit=100&page=${page}`;
  const first = await firstOk(EZTV_HOSTS.map((h) => url(h, 1)));
  const host = EZTV_HOSTS[first.i]; // later pages only go to the mirror that answered
  let torrents = first.data.torrents || [];
  const pages = Math.min(Math.ceil((first.data.torrents_count || 0) / 100), 5);
  if (pages > 1) {
    const rest = await Promise.allSettled(Array.from({ length: pages - 1 }, (_, i) => getJSON(url(host, i + 2))));
    for (const r of rest) if (r.status === "fulfilled") torrents = torrents.concat(r.value.torrents || []);
  }
  return torrents
    .filter((t) => Number(t.season) === Number(se) && Number(t.episode) === Number(ep))
    .map((t) =>
      direct({
        hash: t.hash,
        filename: t.filename || t.title,
        seeders: t.seeds || 0,
        bytes: Number(t.size_bytes) || 0,
        provider: "EZTV",
      })
    );
}

async function fromTorrentio(cfg, type, id) {
  if (!/^https:\/\//i.test(cfg.torrentioUrl)) throw new Error("URL must start with https://");
  const base = cfg.torrentioUrl.replace(/\/(manifest\.json|configure)\/?$/i, "").replace(/\/$/, "");
  const d = await getJSON(`${base}/stream/${type}/${encodeURIComponent(id)}.json`);
  return (d.streams || []).map((s) => {
    const p = parse(s);
    return { s, p, res: p.res, seeders: p.seeders, size: p.size };
  });
}

// "2160p"/"uhd" -> "4k", "1080" -> "1080p", "sd"/"unknown" -> "other"; anything else is dropped
function normQ(t) {
  t = String(t).trim().toLowerCase();
  if (/^(2160p?|4k|uhd)$/.test(t)) return "4k";
  if (/^(sd|other|unknown)$/.test(t)) return "other";
  const m = /^(\d{3,4})p?$/.exec(t);
  return m ? `${m[1]}p` : "";
}
function normOrder(list) {
  const out = [];
  for (const t of Array.isArray(list) ? list : []) {
    const q = normQ(t);
    if (q && !out.includes(q)) out.push(q);
  }
  return out.length ? out : DEFAULT_ORDER;
}

function decodeConfig(c) {
  try {
    const raw = JSON.parse(Buffer.from(c, "base64url").toString());
    const cfg = { ...DEFAULTS, ...raw };
    if (raw.torrentio === undefined) cfg.torrentio = !!raw.torrentioUrl; // links made before v1.1
    if (!Array.isArray(cfg.resolutions)) cfg.resolutions = [];
    if (!Array.isArray(cfg.sort)) cfg.sort = DEFAULTS.sort;
    cfg.qualityOrder = normOrder(cfg.qualityOrder);
    return cfg;
  } catch {
    return { ...DEFAULTS };
  }
}

// Shown in Stremio's stream list when something goes wrong, so failures are visible
const notice = (text) => ({
  name: "Uptorrent\n⚠️",
  title: text,
  description: text,
  externalUrl: "https://uptorrent.vercel.app",
});

// ---------- core: gather, merge, filter, sort ----------
async function getStreams(cfg, type, id) {
  const jobs = [];
  if (cfg.yts) jobs.push(["YTS", fromYTS(type, id)]);
  if (cfg.eztv) jobs.push(["EZTV", fromEZTV(type, id)]);
  if (cfg.torrentio) jobs.push(["Torrentio", fromTorrentio(cfg, type, id)]);
  if (!jobs.length) return [notice("No sources enabled. Tick YTS, EZTV or Torrentio on the configure page.")];

  const results = await Promise.allSettled(jobs.map((j) => j[1]));
  let list = [];
  const errors = [];
  const seen = new Set();
  results.forEach((r, i) => {
    if (r.status !== "fulfilled") return errors.push(`${jobs[i][0]}: ${r.reason && r.reason.message}`);
    for (const x of r.value) {
      const h = x.s.infoHash && x.s.infoHash.toLowerCase();
      if (h) {
        if (seen.has(h)) continue; // same torrent from two sources, keep the first
        seen.add(h);
      }
      list.push(x);
    }
  });

  const found = list.length;
  const before = list;
  if (cfg.resolutions.length) list = list.filter((x) => cfg.resolutions.includes(x.res));
  if (cfg.minSeeders > 0) list = list.filter((x) => x.seeders >= cfg.minSeeders);

  if (!list.length) {
    const err = errors.length ? ` Errors: ${errors.join("; ")}.` : "";
    if (!found) return [notice(`No streams found for this title.${err}`)];
    const counts = {};
    for (const x of before) counts[RES_LABEL[x.res]] = (counts[RES_LABEL[x.res]] || 0) + 1;
    const summary = Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(", ");
    return [notice(`Found ${found} streams (${summary}) but none match your filters (resolutions: ${cfg.resolutions.join(", ") || "all"}, min seeders: ${cfg.minSeeders}).${err}`)];
  }

  // Balanced score (50/50): smaller size + more seeders = higher score
  const SEED_CAP = 50;
  const sizes = list.map((x) => x.size).filter((n) => n > 0);
  const minS = sizes.length ? Math.min(...sizes) : 0;
  const maxS = sizes.length ? Math.max(...sizes) : 0;
  for (const x of list) {
    const sizeScore = x.size <= 0 ? 0 : maxS === minS ? 1 : (maxS - x.size) / (maxS - minS);
    const seedScore = Math.min(x.seeders, SEED_CAP) / SEED_CAP;
    x.score = 0.5 * sizeScore + 0.5 * seedScore;
  }

  // quality rank follows the user's order: first in the list = highest rank, unlisted = lowest
  const order = cfg.qualityOrder || DEFAULT_ORDER;
  const key = {
    quality: (x) => {
      const i = order.indexOf(x.res);
      return i === -1 ? 0 : order.length - i;
    },
    balanced: (x) => x.score,
    size: (x) => x.size,
    seeders: (x) => x.seeders,
  };
  // Every sort level can be "asc" (low → high) or "desc" (high → low)
  list.sort((a, b) => {
    for (const { by, dir } of cfg.sort) {
      if (!key[by]) continue;
      const d = key[by](a) - key[by](b);
      if (d) return dir === "asc" ? d : -d;
    }
    return 0;
  });

  if (cfg.limit > 0) list = list.slice(0, cfg.limit);
  return list.map((x) => finalize(x, cfg.clean !== false));
}

// ---------- configure page ----------
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Uptorrent</title>
<link rel="icon" href="/logo.png">
<style>
:root{--bg:#0b0b12;--card:rgba(255,255,255,.04);--line:rgba(255,255,255,.09);--txt:#eceaf6;--mut:#8f8ca8;--p1:#8b5cf6;--p2:#3b82f6}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif;color:var(--txt);
background:radial-gradient(900px 500px at 15% -10%,rgba(139,92,246,.25),transparent 60%),radial-gradient(800px 500px at 100% 0,rgba(59,130,246,.18),transparent 60%),var(--bg)}
.wrap{max-width:560px;margin:0 auto;padding:28px 16px 60px}
header{display:flex;align-items:center;gap:14px;margin-bottom:22px}
header img{width:58px;height:58px;border-radius:15px;box-shadow:0 8px 30px rgba(124,92,255,.45)}
h1{margin:0;font-size:28px;letter-spacing:-.5px;background:linear-gradient(90deg,#fff,#b9a6ff);-webkit-background-clip:text;background-clip:text;color:transparent}
header p{margin:2px 0 0;color:var(--mut);font-size:13.5px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px;margin-bottom:14px;backdrop-filter:blur(8px)}
.card h2{margin:0 0 4px;font-size:13px;text-transform:uppercase;letter-spacing:.9px;color:var(--mut);font-weight:600}
.hint{margin:0 0 10px;color:var(--mut);font-size:12.5px;line-height:1.4}
input[type=text],input[type=number],select{width:100%;padding:11px 12px;border-radius:11px;border:1px solid var(--line);background:rgba(0,0,0,.35);color:var(--txt);font-size:14px;outline:none;transition:.15s}
input:focus,select:focus{border-color:var(--p1);box-shadow:0 0 0 3px rgba(139,92,246,.2)}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip input{display:none}
.chip span{display:inline-block;padding:8px 14px;border-radius:999px;border:1px solid var(--line);background:rgba(0,0,0,.3);font-size:13.5px;cursor:pointer;transition:.15s;user-select:none}
.chip input:checked+span{background:linear-gradient(135deg,var(--p1),var(--p2));border-color:transparent;color:#fff;font-weight:600}
.two{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.two label{display:block;font-size:12.5px;color:var(--mut);margin-bottom:6px}
.srow{display:grid;grid-template-columns:26px 1fr 1fr;gap:8px;align-items:center;margin-bottom:8px}
.num{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:700;background:rgba(139,92,246,.2);color:#c9b8ff}
.bar{position:sticky;bottom:12px;margin-top:18px;padding:14px;border-radius:16px;border:1px solid var(--line);background:rgba(18,18,30,.88);backdrop-filter:blur(14px);box-shadow:0 10px 40px rgba(0,0,0,.5)}
.url{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--mut);word-break:break-all;max-height:44px;overflow:hidden;margin-bottom:10px}
.btns{display:flex;gap:10px}
button,a.btn{flex:1;text-align:center;padding:13px 16px;border-radius:12px;border:0;font-size:15px;font-weight:600;cursor:pointer;text-decoration:none;transition:.15s}
button.main{background:linear-gradient(135deg,var(--p1),var(--p2));color:#fff}
button.main:active{transform:scale(.98)}
a.btn{flex:.6;background:rgba(255,255,255,.07);color:var(--txt);border:1px solid var(--line)}
#toast{position:fixed;left:50%;bottom:110px;transform:translateX(-50%) translateY(20px);background:#22c55e;color:#fff;padding:9px 18px;border-radius:999px;font-size:14px;font-weight:600;opacity:0;pointer-events:none;transition:.25s}
#toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
</style></head><body><div class="wrap">
<header><img src="/logo.png" alt="Uptorrent logo"><div><h1>Uptorrent</h1><p>Filter, sort &amp; clean up your torrent streams</p></div></header>

<div class="card"><h2>Sources</h2>
<p class="hint">YTS and EZTV are queried directly (with real seeders and sizes). Torrentio is optional for extra providers.</p>
<div class="chips">
<label class="chip"><input type="checkbox" id="s_yts" checked><span>YTS (movies)</span></label>
<label class="chip"><input type="checkbox" id="s_eztv" checked><span>EZTV (shows)</span></label>
<label class="chip"><input type="checkbox" id="s_tio"><span>Torrentio</span></label>
</div>
<p class="hint" style="margin-top:12px">Torrentio URL (only used if Torrentio is ticked)</p>
<input type="text" id="turl" value="https://torrentio.strem.fun" spellcheck="false"></div>

<div class="card"><h2>Resolution</h2>
<p class="hint">Pick the ones you want. Nothing selected = show all.</p>
<div class="chips" id="chips"></div></div>

<div class="card"><h2>Limits</h2>
<div class="two">
<div><label for="seed">Minimum seeders</label><input type="number" id="seed" value="0" min="0"></div>
<div><label for="lim">Max results (0 = all)</label><input type="number" id="lim" value="0" min="0"></div>
</div></div>

<div class="card"><h2>Sort order</h2>
<p class="hint">1 is applied first, the next rows break ties. <b>Balanced</b> scores size and seeders together: small files with healthy seeders rank highest.</p>
<label for="qorder" style="display:block;font-size:12.5px;color:var(--mut);margin:0 0 6px">Quality order (first = shown first)</label>
<input type="text" id="qorder" value="4k, 1440p, 1080p, 720p, 480p, 360p" spellcheck="false" style="margin-bottom:6px">
<p class="hint">Separate with commas, like <b>1080p, 720p, 4k, 360p</b>. Used by the Quality row: Descending follows this order, Ascending reverses it. Qualities not listed go last. Use <b>other</b> for unknown resolution.</p>
<div id="sorts"></div></div>

<div class="card"><h2>Display</h2>
<div class="chips"><label class="chip"><input type="checkbox" id="clean" checked><span>Clean stream names</span></label></div>
<p class="hint" style="margin-top:10px">Untick this if streams don't show up in your Stremio app. It switches to Torrentio-style names.</p></div>

<div class="bar">
<div class="url" id="url"></div>
<div class="btns"><button class="main" id="copy">Copy manifest URL</button><a class="btn" id="install" href="#">Install</a></div>
</div>
<div id="toast">Copied!</div>
</div>
<script>
var $=function(id){return document.getElementById(id);};
var RES=["4k","1440p","1080p","720p","480p","360p","other"];
var LABEL={"4k":"4K","1440p":"1440p","1080p":"1080p","720p":"720p","480p":"480p","360p":"360p","other":"Other"};
$("chips").innerHTML=RES.map(function(r){return '<label class="chip"><input type="checkbox" value="'+r+'"><span>'+LABEL[r]+'</span></label>';}).join("");

var OPTS=[["","None"],["quality","Quality"],["balanced","Balanced (size + seeders)"],["size","Size"],["seeders","Seeders"]];
var DEF=[["quality","desc"],["balanced","desc"],["","desc"],["","desc"]];
var rows="";
for(var i=0;i<4;i++){
  rows+='<div class="srow"><span class="num">'+(i+1)+'</span><select class="by">'+
  OPTS.map(function(o){return '<option value="'+o[0]+'"'+(o[0]===DEF[i][0]?' selected':'')+'>'+o[1]+'</option>';}).join("")+
  '</select><select class="dir"><option value="desc"'+(DEF[i][1]==="desc"?' selected':'')+'>Descending</option><option value="asc"'+(DEF[i][1]==="asc"?' selected':'')+'>Ascending</option></select></div>';
}
$("sorts").innerHTML=rows;

function cfg(){
  var c={
    yts:$("s_yts").checked,eztv:$("s_eztv").checked,torrentio:$("s_tio").checked,
    torrentioUrl:$("turl").value.trim()||"https://torrentio.strem.fun",
    clean:$("clean").checked,
    qualityOrder:$("qorder").value.split(",").map(function(x){return x.trim();}).filter(Boolean),
    resolutions:[],minSeeders:+$("seed").value||0,limit:+$("lim").value||0,sort:[]
  };
  [].slice.call(document.querySelectorAll("#chips input:checked")).forEach(function(x){c.resolutions.push(x.value);});
  var by=document.querySelectorAll(".by"),dir=document.querySelectorAll(".dir");
  for(var i=0;i<by.length;i++){if(by[i].value)c.sort.push({by:by[i].value,dir:dir[i].value});}
  return c;
}
function manifestUrl(){
  var b=btoa(unescape(encodeURIComponent(JSON.stringify(cfg()))));
  b=b.split("+").join("-").split("/").join("_").split("=").join("");
  return location.origin+"/"+b+"/manifest.json";
}
function refresh(){
  var u=manifestUrl();
  $("url").textContent=u;
  $("install").href="stremio://"+u.split("://")[1];
}
function toast(){var t=$("toast");t.classList.add("show");setTimeout(function(){t.classList.remove("show");},1600);}
$("copy").onclick=function(){
  var u=manifestUrl();
  function fallback(){
    var t=document.createElement("textarea");t.value=u;document.body.appendChild(t);t.select();
    try{document.execCommand("copy");toast();}catch(e){}
    document.body.removeChild(t);
  }
  if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(u).then(toast,fallback);}else{fallback();}
};
document.addEventListener("input",refresh);
document.addEventListener("change",refresh);
refresh();
</script></body></html>`;

// ---------- logo (256x256 PNG) ----------
const LOGO = Buffer.from("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", "base64");

// ---------- request handler ----------
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "Content-Type": type, ...CORS });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") return send(res, 204, "");

    const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
    const proto = req.headers["x-forwarded-proto"] || (/^(localhost|127\.)/.test(host) ? "http" : "https");
    const origin = `${proto}://${host}`;

    const parts = new URL(req.url, "http://x").pathname
      .split("/")
      .filter(Boolean)
      .filter((p) => p !== "api")
      .map(decodeURIComponent);

    let cfgStr = "";
    if (parts[0] && !["configure", "manifest.json", "stream", "logo.png"].includes(parts[0])) cfgStr = parts.shift();

    if (parts[0] === "logo.png") {
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400", ...CORS });
      return res.end(LOGO);
    }
    if (!parts[0] || parts[0] === "configure") return send(res, 200, PAGE, "text/html; charset=utf-8");
    if (parts[0] === "manifest.json") return send(res, 200, buildManifest(origin));

    if (parts[0] === "stream") {
      const type = parts[1];
      const id = (parts[2] || "").replace(/\.json$/, "");
      const streams = await getStreams(decodeConfig(cfgStr), type, id).catch((e) => [notice(`Error: ${e.message}`)]);
      return send(res, 200, { streams });
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 500, { error: String(e) });
  }
}

module.exports = handler;

// Local dev: node api/index.js
if (require.main === module) {
  const PORT = process.env.PORT || 7000;
  http.createServer(handler).listen(PORT, () =>
    console.log(`Uptorrent running: http://127.0.0.1:${PORT}/configure`)
  );
}
