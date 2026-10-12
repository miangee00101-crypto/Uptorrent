// Uptorrent — Stremio addon (zero dependencies, Node 18+)
// Works on Vercel (serverless) and locally: `node api/index.js`
const http = require("http");

const RES_RANK = { "4k": 5, "1440p": 4, "1080p": 3, "720p": 2, "480p": 1, other: 0 };
const DEFAULTS = {
  torrentioUrl: "https://torrentio.strem.fun",
  resolutions: [], // empty = allow all
  minSeeders: 0,
  limit: 0, // 0 = no limit
  sort: [{ by: "quality", dir: "desc" }],
};

const manifest = {
  id: "community.uptorrent",
  version: "1.0.0",
  name: "Uptorrent",
  description: "Filter and sort Torrentio streams by quality, size and seeders.",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [],
  behaviorHints: { configurable: true, configurationRequired: false },
};

// ---------- parsing helpers ----------
function getRes(s) {
  const t = `${s.name || ""} ${s.title || ""}`;
  if (/2160p|4k/i.test(t)) return "4k";
  if (/1440p/i.test(t)) return "1440p";
  if (/1080p/i.test(t)) return "1080p";
  if (/720p/i.test(t)) return "720p";
  if (/480p/i.test(t)) return "480p";
  return "other";
}
function getSeeders(s) {
  const m = /👤\s*(\d+)/.exec(s.title || "");
  return m ? parseInt(m[1], 10) : 0;
}
function getSizeBytes(s) {
  const m = /💾\s*([\d.]+)\s*(TB|GB|MB|KB)/i.exec(s.title || "");
  if (!m) return 0;
  const mult = { KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[m[2].toUpperCase()];
  return parseFloat(m[1]) * mult;
}

function decodeConfig(c) {
  try {
    const cfg = { ...DEFAULTS, ...JSON.parse(Buffer.from(c, "base64url").toString()) };
    if (!Array.isArray(cfg.resolutions)) cfg.resolutions = [];
    if (!Array.isArray(cfg.sort)) cfg.sort = DEFAULTS.sort;
    return cfg;
  } catch {
    return { ...DEFAULTS };
  }
}

// ---------- core: fetch from Torrentio, filter, sort ----------
async function getStreams(cfg, type, id) {
  // Only https upstreams — this server fetches whatever URL is in the config.
  if (!/^https:\/\//i.test(cfg.torrentioUrl)) return [];
  const base = cfg.torrentioUrl.replace(/\/$/, "");
  const r = await fetch(`${base}/stream/${type}/${encodeURIComponent(id)}.json`);
  if (!r.ok) return [];
  const { streams = [] } = await r.json();

  let list = streams.map((s) => ({
    s,
    res: getRes(s),
    seeders: getSeeders(s),
    size: getSizeBytes(s),
  }));

  if (cfg.resolutions.length) list = list.filter((x) => cfg.resolutions.includes(x.res));
  if (cfg.minSeeders > 0) list = list.filter((x) => x.seeders >= cfg.minSeeders);

  const key = {
    quality: (x) => RES_RANK[x.res],
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
  return list.map((x) => x.s);
}

// ---------- configure page ----------
const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Uptorrent</title>
<style>
body{font-family:system-ui,sans-serif;max-width:520px;margin:24px auto;padding:0 16px;background:#111;color:#eee}
h1{font-size:22px} label{display:block;margin:14px 0 4px;font-weight:600}
input[type=text],input[type=number],select{width:100%;padding:8px;border-radius:8px;border:1px solid #444;background:#222;color:#eee;box-sizing:border-box}
.row{display:flex;gap:8px;margin-bottom:6px}.chk label{display:inline-block;margin:4px 12px 4px 0;font-weight:400}
button,a.btn{display:inline-block;margin-top:18px;padding:10px 16px;border:0;border-radius:8px;background:#7b5bf5;color:#fff;font-size:15px;text-decoration:none;cursor:pointer}
code{display:block;word-break:break-all;background:#222;padding:8px;border-radius:8px;margin-top:8px}
small{color:#999}
</style></head><body>
<h1>Uptorrent</h1>
<label>Torrentio URL (include your own providers/debrid options)</label>
<input type="text" id="turl" value="https://torrentio.strem.fun">
<label>Allowed resolutions (none ticked = all)</label>
<div class="chk" id="res"></div>
<label>Minimum seeders</label><input type="number" id="seed" value="0" min="0">
<label>Max results (0 = no limit)</label><input type="number" id="lim" value="0" min="0">
<label>Sort priority</label>
<small>1st is applied first, ties are broken by the next one.</small>
<div id="sorts"></div>
<button onclick="gen()">Generate</button>
<div id="out"></div>
<script>
var RES=["4k","1440p","1080p","720p","480p","other"];
document.getElementById("res").innerHTML=RES.map(function(r){
  return '<label><input type="checkbox" value="'+r+'"> '+r+'</label>';}).join("");
var defaults=[["quality","desc"],["seeders","desc"],["size","asc"]];
var sh="";
for(var i=0;i<3;i++){
  sh+='<div class="row"><select class="by"><option value="">(none)</option>'+
  ["quality","size","seeders"].map(function(o){return '<option'+(defaults[i][0]===o?' selected':'')+'>'+o+'</option>';}).join("")+
  '</select><select class="dir"><option value="desc"'+(defaults[i][1]==="desc"?" selected":"")+'>Descending (high → low)</option><option value="asc"'+(defaults[i][1]==="asc"?" selected":"")+'>Ascending (low → high)</option></select></div>';
}
document.getElementById("sorts").innerHTML=sh;
function gen(){
  var cfg={
    torrentioUrl:document.getElementById("turl").value.trim(),
    resolutions:[].slice.call(document.querySelectorAll("#res input:checked")).map(function(c){return c.value;}),
    minSeeders:+document.getElementById("seed").value||0,
    limit:+document.getElementById("lim").value||0,
    sort:[]
  };
  var bys=document.querySelectorAll(".by"),dirs=document.querySelectorAll(".dir");
  for(var i=0;i<bys.length;i++){ if(bys[i].value) cfg.sort.push({by:bys[i].value,dir:dirs[i].value}); }
  var b=btoa(JSON.stringify(cfg)).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");
  var url=location.origin+"/"+b+"/manifest.json";
  document.getElementById("out").innerHTML=
    '<a class="btn" href="stremio://'+location.host+"/"+b+'/manifest.json">Install in Stremio</a>'+
    '<p>Or paste this in Stremio → Addons → Install from URL:</p><code>'+url+'</code>';
}
</script></body></html>`;

// ---------- request handler ----------
const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, {
    "Content-Type": type,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") return send(res, 204, "");
    const parts = new URL(req.url, "http://x").pathname
      .split("/")
      .filter(Boolean)
      .filter((p) => p !== "api")
      .map(decodeURIComponent);

    let cfgStr = "";
    if (parts[0] && !["configure", "manifest.json", "stream"].includes(parts[0])) cfgStr = parts.shift();

    if (!parts[0] || parts[0] === "configure") return send(res, 200, PAGE, "text/html");
    if (parts[0] === "manifest.json") return send(res, 200, manifest);

    if (parts[0] === "stream") {
      const type = parts[1];
      const id = (parts[2] || "").replace(/\.json$/, "");
      const streams = await getStreams(decodeConfig(cfgStr), type, id).catch(() => []);
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
