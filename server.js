const express = require("express");
const cors = require("cors");
const cheerio = require("cheerio");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const COMMON_LANG_CODES = [
  "en",
  "bn",
  "hi",
  "hi-latn-in",
  "ar",
  "fr",
  "de",
  "es",
  "it",
  "pt",
  "ru",
  "tr",
  "uk",
  "pl",
  "nl",
  "cs",
  "el",
  "he",
  "ja",
  "ko",
  "ro"
];

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function normalizeUrl(base, value) {
  try {
    return new URL(value, base).toString();
  } catch {
    return null;
  }
}

function extFromUrl(url) {
  try {
    const clean = url.split("?")[0].toLowerCase();
    if (clean.includes(".vtt")) return "vtt";
    if (clean.includes(".srt")) return "srt";
    if (clean.includes(".ttml")) return "ttml";
    if (clean.includes(".dfxp")) return "dfxp";
    if (clean.includes(".m3u8")) return "m3u8";
    if (clean.includes(".mpd")) return "mpd";
    return "unknown";
  } catch {
    return "unknown";
  }
}

function detectLanguageFromUrl(url) {
  const lower = url.toLowerCase();

  const langMap = {
    en: "English",
    bn: "Bangla",
    hi: "Hindi",
    "hi-latn-in": "Hindi Latin",
    ar: "Arabic",
    fr: "French",
    de: "German",
    es: "Spanish",
    it: "Italian",
    pt: "Portuguese",
    ru: "Russian",
    tr: "Turkish",
    uk: "Ukrainian",
    pl: "Polish",
    nl: "Dutch",
    cs: "Czech",
    el: "Greek",
    he: "Hebrew",
    ja: "Japanese",
    ko: "Korean",
    ro: "Romanian"
  };

  const orderedCodes = Object.keys(langMap).sort((a, b) => b.length - a.length);

  for (const code of orderedCodes) {
    const patterns = [
      `_${code}_`,
      `-${code}-`,
      `/${code}/`,
      `.${code}.`,
      `_${code}.`,
      `-${code}.`,
      `/sw_${code}_`,
      `sw_${code}_`
    ];
    if (patterns.some(p => lower.includes(p))) {
      return { code, label: langMap[code] };
    }
  }

  return { code: "unknown", label: "Unknown" };
}

function uniqueByUrl(items) {
  const seen = new Set();
  return items.filter(item => {
    if (!item || !item.url) return false;
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

function subtitleLike(url) {
  const lower = url.toLowerCase();
  return (
    lower.includes(".vtt") ||
    lower.includes(".srt") ||
    lower.includes(".ttml") ||
    lower.includes(".dfxp")
  );
}

function manifestLike(url) {
  const lower = url.toLowerCase();
  return lower.includes(".m3u8") || lower.includes(".mpd");
}

function maybeSubtitleOrManifest(url) {
  return subtitleLike(url) || manifestLike(url);
}

function pushResult(results, url, meta = {}) {
  if (!url) return;
  const lang = meta.lang && meta.label ? { code: meta.lang, label: meta.label } : detectLanguageFromUrl(url);

  results.push({
    url,
    type: meta.type || extFromUrl(url),
    source: meta.source || "scan",
    kind: meta.kind || "subtitles",
    lang: meta.lang || lang.code,
    label: meta.label || lang.label,
    note: meta.note || ""
  });
}

function extractLinksFromText(text, baseUrl, sourceName = "text-scan") {
  const results = [];
  if (!text || typeof text !== "string") return results;

  const absoluteRegex =
    /https?:\/\/[^\s"'<>\\]+?(?:\.vtt(?:\.[^"'<>\\\s]+)?|\.srt(?:\.[^"'<>\\\s]+)?|\.ttml(?:\.[^"'<>\\\s]+)?|\.dfxp(?:\.[^"'<>\\\s]+)?|\.m3u8(?:\?[^"'<>\\\s]+)?|\.mpd(?:\?[^"'<>\\\s]+)?)/gi;

  const relativeRegex =
    /(?:\/|\.\/|\.\.\/)[^\s"'<>\\]+?(?:\.vtt(?:\.[^"'<>\\\s]+)?|\.srt(?:\.[^"'<>\\\s]+)?|\.ttml(?:\.[^"'<>\\\s]+)?|\.dfxp(?:\.[^"'<>\\\s]+)?|\.m3u8(?:\?[^"'<>\\\s]+)?|\.mpd(?:\?[^"'<>\\\s]+)?)/gi;

  let match;

  while ((match = absoluteRegex.exec(text)) !== null) {
    pushResult(results, match[0], { source: sourceName });
  }

  while ((match = relativeRegex.exec(text)) !== null) {
    const resolved = normalizeUrl(baseUrl, match[0]);
    if (resolved) {
      pushResult(results, resolved, { source: `${sourceName}-relative` });
    }
  }

  return results;
}

async function fetchText(url, headers = {}) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      ...headers
    },
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
  }

  return await response.text();
}

async function parseManifestForSubtitles(manifestUrl) {
  const results = [];
  try {
    const text = await fetchText(manifestUrl, {
      "Referer": manifestUrl
    });

    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.includes("TYPE=SUBTITLES")) {
        const uriMatch = line.match(/URI="([^"]+)"/i);
        const langMatch = line.match(/LANGUAGE="([^"]+)"/i);
        const nameMatch = line.match(/NAME="([^"]+)"/i);

        if (uriMatch) {
          const subtitleUrl = normalizeUrl(manifestUrl, uriMatch[1]);
          if (subtitleUrl) {
            pushResult(results, subtitleUrl, {
              source: "manifest-hls",
              lang: langMatch ? langMatch[1] : undefined,
              label: nameMatch ? nameMatch[1] : undefined,
              note: "Found in HLS manifest"
            });
          }
        }
      }

      if (subtitleLike(line)) {
        const subtitleUrl = normalizeUrl(manifestUrl, line.trim());
        if (subtitleUrl) {
          pushResult(results, subtitleUrl, {
            source: "manifest-line",
            note: "Subtitle-like reference inside manifest"
          });
        }
      }
    }

    const dashResults = extractLinksFromText(text, manifestUrl, "manifest-dash-scan");
    results.push(...dashResults);

    return uniqueByUrl(results);
  } catch {
    return [];
  }
}

async function htmlAndScriptScan(pageUrl) {
  try {
    const html = await fetchText(pageUrl, {
      "Referer": pageUrl
    });

    const $ = cheerio.load(html);
    const results = [];

    $("track").each((_, el) => {
      const src = $(el).attr("src");
      if (!src) return;

      const resolved = normalizeUrl(pageUrl, src);
      if (!resolved) return;

      pushResult(results, resolved, {
        source: "track-tag",
        kind: $(el).attr("kind") || "subtitles",
        lang: $(el).attr("srclang") || undefined,
        label: $(el).attr("label") || undefined
      });
    });

    $("source, link, meta").each((_, el) => {
      for (const attr of ["src", "href", "content"]) {
        const val = $(el).attr(attr);
        if (!val) continue;

        const resolved = normalizeUrl(pageUrl, val);
        if (!resolved) continue;

        if (maybeSubtitleOrManifest(resolved)) {
          pushResult(results, resolved, {
            source: `${el.tagName || "tag"}:${attr}`
          });
        }
      }
    });

    results.push(...extractLinksFromText(html, pageUrl, "html-scan"));

    $("script").each((_, el) => {
      const scriptText = $(el).html() || "";
      results.push(...extractLinksFromText(scriptText, pageUrl, "script-scan"));
    });

    const unique = uniqueByUrl(results);
    const expanded = [];

    for (const item of unique) {
      expanded.push(item);
      if (manifestLike(item.url)) {
        const manifestSubs = await parseManifestForSubtitles(item.url);
        expanded.push(...manifestSubs);
      }
    }

    return {
      ok: true,
      reason: "",
      results: uniqueByUrl(expanded)
    };
  } catch (error) {
    return {
      ok: false,
      reason: error.message || "HTML scan failed",
      results: []
    };
  }
}

async function playwrightNetworkScan(pageUrl) {
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch {
    return {
      ok: false,
      reason: "Playwright not installed",
      results: []
    };
  }

  const results = [];
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const context = await browser.newContext({
      userAgent: USER_AGENT,
      locale: "en-US",
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9"
      }
    });

    const page = await context.newPage();

    await page.setExtraHTTPHeaders({
      "accept-language": "en-US,en;q=0.9",
      "referer": pageUrl
    });

    const maybePush = (rawUrl, source, extra = {}) => {
      if (!rawUrl) return;
      if (maybeSubtitleOrManifest(rawUrl)) {
        pushResult(results, rawUrl, { source, ...extra });
      }
    };

    page.on("request", req => {
      maybePush(req.url(), "pw-request");
    });

    page.on("response", async res => {
      try {
        const url = res.url();
        const headers = res.headers();
        const ctype = (headers["content-type"] || "").toLowerCase();

        if (
          maybeSubtitleOrManifest(url) ||
          ctype.includes("text/vtt") ||
          ctype.includes("application/x-subrip") ||
          ctype.includes("application/vnd.apple.mpegurl") ||
          ctype.includes("application/dash+xml") ||
          ctype.includes("application/octet-stream")
        ) {
          maybePush(url, "pw-response", { note: `HTTP ${res.status()}` });

          if (manifestLike(url)) {
            try {
              const text = await res.text();
              const extra = extractLinksFromText(text, url, "pw-manifest-text");
              results.push(...extra);

              const manifestSubs = await parseManifestForSubtitles(url);
              results.push(...manifestSubs);
            } catch {}
          }

          if (!maybeSubtitleOrManifest(url) && ctype.includes("text/vtt")) {
            pushResult(results, url, {
              source: "pw-content-type",
              type: "vtt"
            });
          }
        }
      } catch {}
    });

    await page.goto(pageUrl, {
      waitUntil: "networkidle",
      timeout: 45000
    });

    await page.waitForTimeout(6000);

    try {
      const selectors = [
        "button",
        "[role='button']",
        ".cc",
        ".captions",
        ".subtitle",
        ".subtitles"
      ];

      for (const selector of selectors) {
        const elements = await page.locator(selector).all();
        for (const el of elements.slice(0, 20)) {
          try {
            const txt = ((await el.textContent()) || "").toLowerCase();
            const aria = ((await el.getAttribute("aria-label")) || "").toLowerCase();
            const title = ((await el.getAttribute("title")) || "").toLowerCase();
            const combined = `${txt} ${aria} ${title}`;

            if (
              combined.includes("cc") ||
              combined.includes("sub") ||
              combined.includes("caption") ||
              combined.includes("subtitle")
            ) {
              await el.click({ timeout: 1500 });
              await page.waitForTimeout(1200);
            }
          } catch {}
        }
      }
    } catch {}

    await page.waitForTimeout(3000);

    try {
      const html = await page.content();
      results.push(...extractLinksFromText(html, pageUrl, "pw-page-content"));
    } catch {}

    await context.close();
    await browser.close();

    return {
      ok: true,
      reason: "",
      results: uniqueByUrl(results)
    };
  } catch (error) {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }

    return {
      ok: false,
      reason: error.message || "Playwright scan failed",
      results: uniqueByUrl(results)
    };
  }
}

function buildSubtitleVariant(url, langCode) {
  const patterns = [
    /(\/sw_)([a-z0-9-]+)(_\d+\.vtt(?:\.[^/?#]+)?)/i,
    /(\/sw-)([a-z0-9-]+)(-\d+\.vtt(?:\.[^/?#]+)?)/i,
    /(sw_)([a-z0-9-]+)(_\d+\.vtt(?:\.[^/?#]+)?)/i,
    /(sw-)([a-z0-9-]+)(-\d+\.vtt(?:\.[^/?#]+)?)/i
  ];

  for (const pattern of patterns) {
    if (pattern.test(url)) {
      return url.replace(pattern, `$1${langCode}$3`);
    }
  }

  return null;
}

async function probeUrl(url) {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": url
      },
      redirect: "follow"
    });

    if (response.ok) {
      return {
        ok: true,
        status: response.status,
        finalUrl: response.url,
        contentType: response.headers.get("content-type") || ""
      };
    }

    return { ok: false, status: response.status };
  } catch {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "*/*",
          "Accept-Language": "en-US,en;q=0.9",
          "Range": "bytes=0-32",
          "Referer": url
        },
        redirect: "follow"
      });

      return {
        ok: response.ok,
        status: response.status,
        finalUrl: response.url,
        contentType: response.headers.get("content-type") || ""
      };
    } catch {
      return { ok: false, status: 0 };
    }
  }
}

async function scanSubtitleVariants(baseSubtitleUrl) {
  const results = [];

  pushResult(results, baseSubtitleUrl, {
    source: "input-subtitle-url",
    note: "User provided subtitle URL"
  });

  for (const langCode of COMMON_LANG_CODES) {
    const variant = buildSubtitleVariant(baseSubtitleUrl, langCode);
    if (!variant) continue;

    const probe = await probeUrl(variant);
    if (probe.ok) {
      const detected = detectLanguageFromUrl(variant);
      pushResult(results, probe.finalUrl || variant, {
        source: "language-probe",
        lang: detected.code,
        label: detected.label,
        note: `HTTP ${probe.status}`
      });
    }
  }

  return uniqueByUrl(results);
}

app.post("/api/find-subtitles", async (req, res) => {
  try {
    const { url, mode = "auto" } = req.body || {};

    if (!url) {
      return res.status(400).json({ error: "URL required" });
    }

    let normalizedUrl;
    try {
      normalizedUrl = new URL(url).toString();
    } catch {
      return res.status(400).json({ error: "Invalid URL" });
    }

    const isDirectSubtitle = subtitleLike(normalizedUrl);

    let results = [];
    let debug = {
      htmlScan: false,
      htmlReason: "",
      networkScan: false,
      networkReason: "",
      subtitleProbe: false
    };

    if (mode === "subtitle" || (mode === "auto" && isDirectSubtitle)) {
      results = await scanSubtitleVariants(normalizedUrl);
      debug.subtitleProbe = true;
    } else {
      const htmlScan = await htmlAndScriptScan(normalizedUrl);
      results.push(...htmlScan.results);
      debug.htmlScan = htmlScan.ok;
      debug.htmlReason = htmlScan.reason || "";

      const net = await playwrightNetworkScan(normalizedUrl);
      results.push(...net.results);
      debug.networkScan = net.ok;
      debug.networkReason = net.reason || "";

      const firstDirectSubtitle = results.find(r => subtitleLike(r.url));
      if (firstDirectSubtitle) {
        const siblingLangs = await scanSubtitleVariants(firstDirectSubtitle.url);
        results.push(...siblingLangs);
        debug.subtitleProbe = true;
      }
    }

    results = uniqueByUrl(results);

    return res.json({
      success: true,
      inputUrl: normalizedUrl,
      count: results.length,
      debug,
      subtitles: results
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Server error"
    });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});