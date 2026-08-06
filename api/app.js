// velthi.app/app — the single link every Velthi QR and email CTA points at.
//
// It used to be a static redirect in vercel.json, which meant nobody could tell
// how many people scanned the insert card: the UTMs rode along to the App Store,
// where Apple ignores utm_* entirely. This function does three things the static
// rule could not:
//   1. counts the hit (funnel_events in Sales HQ, same table as the darts/cue
//      funnel, no PII, fire-and-forget so a slow log never delays the redirect),
//   2. adds real store attribution (Apple ct, Play install referrer),
//   3. keeps the Android destination in one constant, so the day Velthi goes
//      live on Google Play it is a one-line change and every card already
//      printed starts pointing at the store.

const APPLE_ID = "6769715940";
// Provider token from App Store Connect (Analytics > Acquisition > Campaigns).
// Apple only reports a campaign fully when ct is paired with pt; ct on its own
// is passed through but leaves the attribution partial. Not a secret: it rides
// in every campaign link Apple generates for public marketing use.
const APPLE_PROVIDER_TOKEN = "120099410";
const ANDROID_PACKAGE = "com.ignaris.velthi";

// Play production release went live on 2026-08-03, so Android now goes to the
// store instead of falling back to the site. Every card already printed starts
// pointing at Play from this deploy on, with no reprint.
const PLAY_LIVE = true;

const TRACK_URL = "https://hq.ignaris.com/api/funnel/track";
const SITE = "https://velthi.app/";

function platformOf(ua) {
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "desktop";
}

function appleUrl(campaign) {
  // Apple reads pt + ct + mt, not utm_*. The trio surfaces in App Store Connect
  // > Analytics > Acquisition > Campaigns. The /app/apple-store/id form is the
  // one Apple's own campaign-link generator emits, so we match it exactly.
  const u = new URL(`https://apps.apple.com/app/apple-store/id${APPLE_ID}`);
  u.searchParams.set("pt", APPLE_PROVIDER_TOKEN);
  if (campaign) u.searchParams.set("ct", campaign);
  u.searchParams.set("mt", "8");
  return u.toString();
}

function playUrl(params) {
  // Play reads a single `referrer` string (URL-encoded key=value pairs), which
  // shows up in Play Console acquisition reports and reaches the app itself via
  // the Install Referrer API.
  const ref = new URLSearchParams({
    utm_source: params.get("utm_source") || "insert",
    utm_medium: params.get("utm_medium") || "qr",
    utm_campaign: params.get("utm_campaign") || "velthi-insert",
  }).toString();
  return `https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE}&referrer=${encodeURIComponent(ref)}`;
}

function siteUrl(params) {
  const q = params.toString();
  return q ? `${SITE}?${q}` : SITE;
}

// Three very different audiences walk through /app: someone scanning the QR on
// the insert card, someone clicking the CTA in a Velthi Welcome email, and —
// since the video advertorial (2026-08) — someone tapping a paid or social ad.
// They need separate buckets, or ad clicks would be counted as card scans on
// the Sales HQ dashboard and inflate the one number that is genuinely the
// card's. The card keeps the default bucket on purpose: it is the only channel
// whose links we cannot edit after printing.
const ADS_SOURCES = new Set(["meta", "facebook", "instagram", "tiktok", "social", "ads"]);
function productOf(params) {
  const src = (params.get("utm_source") || "").toLowerCase();
  if (src === "email") return "velthi-email";
  if (ADS_SOURCES.has(src)) return "velthi-ads";
  return "velthi-insert";
}

async function logHit(params, platform, req) {
  const body = JSON.stringify({
    page: "/app",
    product: productOf(params),
    insert_variant: (params.get("utm_source") || "").slice(0, 60),
    hook: platform,
    visitor: "",
    referrer: (params.toString() || req.headers.referer || "").slice(0, 300),
  });
  // 1.5s ceiling: analytics must never hold a customer on a blank page.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 1500);
  try {
    await fetch(TRACK_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body,
      signal: ctrl.signal,
    });
  } catch {
    // swallow: a failed count is not a failed redirect
  } finally {
    clearTimeout(t);
  }
}

module.exports = async (req, res) => {
  const url = new URL(req.url, "https://velthi.app");
  const params = url.searchParams;
  const ua = req.headers["user-agent"] || "";
  const platform = platformOf(ua);

  let destination;
  if (platform === "ios") destination = appleUrl(params.get("utm_campaign"));
  else if (platform === "android" && PLAY_LIVE) destination = playUrl(params);
  else destination = siteUrl(params);

  await logHit(params, platform, req);

  res.statusCode = 302;
  res.setHeader("Location", destination);
  res.setHeader("Cache-Control", "no-store");
  res.end();
};
