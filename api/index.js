export default async function handler(req, res) {
  // Handle CORS for Nuvio
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const { path } = req.query;

  // --- 1. MANIFEST ENDPOINT (Stripped Catalogs for Nuvio) ---
  if (!path || path === "manifest.json") {
    return res.status(200).json({
      id: "org.custom.uptorrent.engine",
      version: "1.0.0",
      name: "Uptorrent",
      description: "Ultra-fast serverless stream filter and multi-sort engine",
      resources: ["stream"],
      types: ["movie", "series"],
      catalogs: [], // Keeps Nuvio search catalog clean
      behaviorHints: { configurable: false }
    });
  }

  // --- 2. STREAM FETCHING & FILTERING ---
  if (path.startsWith("stream/")) {
    // Upstream Torrentio base endpoint (EZTV + YTS)
    const upstreamUrl = `https://torrentio.strem.fun/providers=yts,eztv/${path}`;

    try {
      const response = await fetch(upstreamUrl, {
        headers: { "User-Agent": "Mozilla/5.0" }
      });

      if (!response.ok) {
        return res.status(200).json({ streams: [] });
      }

      const data = await response.json();

      if (data && data.streams && data.streams.length > 0) {
        let streams = data.streams;

        // A. HARD FILTERS (Must-Match Rules)
        streams = streams.filter(stream => {
          const title = (stream.title || "") + " " + (stream.name || "");

          // Drop 4K, 3D, CAM, and TS releases
          const is4K = /2160p|4k|uhd/i.test(title);
          const is3D = /3d|3-d/i.test(title);
          const isCam = /cam|hdcam|dvdscr|r5/i.test(title);

          if (is4K || is3D || isCam) return false;

          // Parse seeders (drop dead torrents with 0 seeders)
          const seederMatch = title.match(/👤\s*(\d+)/) || title.match(/seeders:\s*(\d+)/i);
          if (seederMatch) {
            const seeders = parseInt(seederMatch[1], 10);
            if (seeders < 1) return false;
          }

          return true;
        });

        // B. MULTI-SORTING (Pipeline: Quality -> Size -> Seeders)
        streams.sort((a, b) => {
          const titleA = a.title || "";
          const titleB = b.title || "";

          // 1. Quality Rank (1080p > 720p > others)
          const getQualityScore = (t) => {
            if (/1080p|fhd/i.test(t)) return 2;
            if (/720p|hd/i.test(t)) return 1;
            return 0;
          };
          const qualA = getQualityScore(titleA);
          const qualB = getQualityScore(titleB);
          if (qualA !== qualB) return qualB - qualA; // Descending quality

          // 2. Size Rank (Ascending: lighter files first for instant playback)
          const getSizeInMB = (t) => {
            const match = t.match(/💾\s*([\d.]+)\s*(GB|MB)/i) || t.match(/([\d.]+)\s*(GB|MB)/i);
            if (!match) return 99999;
            const val = parseFloat(match[1]);
            const unit = match[2].toUpperCase();
            return unit === "GB" ? val * 1024 : val;
          };
          const sizeA = getSizeInMB(titleA);
          const sizeB = getSizeInMB(titleB);
          if (Math.abs(sizeA - sizeB) > 50) return sizeA - sizeB; // Ascending size

          // 3. Seeders Rank (Descending)
          const getSeeders = (t) => {
            const match = t.match(/👤\s*(\d+)/) || t.match(/seeders:\s*(\d+)/i);
            return match ? parseInt(match[1], 10) : 0;
          };
          return getSeeders(titleB) - getSeeders(titleA);
        });

        // C. CARD FORMATTING (Uptorrent Badges)
        streams = streams.map(stream => {
          let nameStr = "Uptorrent";
          if (/yts|yify/i.test(stream.title || "")) nameStr = "Uptorrent (YTS)";
          if (/eztv|megusta/i.test(stream.title || "")) nameStr = "Uptorrent (EZTV)";

          return {
            ...stream,
            name: nameStr
          };
        });

        return res.status(200).json({ streams });
      }
    } catch (err) {
      console.error("Uptorrent Engine Error:", err);
    }

    return res.status(200).json({ streams: [] });
  }

  return res.status(404).send("Not Found");
}
