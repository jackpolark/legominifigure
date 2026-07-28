/* ============================================================
   Rebrickable API proxy
   ============================================================
   Holds the real Rebrickable API key as a Worker secret
   (REBRICKABLE_API_KEY) and injects it server-side, so the key
   never appears in the static site's source (app.js/catalog.js)
   or in any browser network request.

   Only forwards GET requests under /api/v3/lego/ — the public,
   read-only catalog namespace (parts, colors, sets, themes, etc).
   The /api/v3/users/ namespace is intentionally never proxied:
   it can read/write a real account's personal data and requires
   a separate user_token obtained via username+password, which
   this app has no business handling.

   Explicit Cache API usage (not `cf.cacheEverything` on fetch()):
   Rebrickable's own Cloudflare front injects a Set-Cookie load-
   balancer affinity cookie on every response, and Cloudflare's
   cache silently refuses to store any response carrying one —
   cacheEverything does not override that specific protection.
   Managing the cache ourselves sidesteps it entirely, which
   matters a lot here: many visitors share this one API key, so a
   popular request (a default part, page 1 of a category, a common
   minifig search) should be served from cache instead of hitting
   Rebrickable's origin again for every single visitor.
   ============================================================ */

const ALLOWED_ORIGINS = [
  "https://jackpolark.github.io",
];

const API_CACHE_TTL_S = 21600; // 6h — this catalog data barely changes hour to hour
const CSV_CACHE_TTL_S = 43200; // 12h — matches catalog.js's own refresh cadence

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  return /^http:\/\/localhost(:\d+)?$/.test(origin); // local dev server
}

function corsHeaders(origin) {
  const headers = {
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
  if (isAllowedOrigin(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

// A synthetic same-origin cache key, since the Cache API only stores by
// exact Request — path+query is enough (nothing here varies by requester).
function cacheKeyFor(pathAndSearch) {
  return new Request(new URL(pathAndSearch, "https://cache.internal/").toString());
}

export default {
  async fetch(request, env, ctx) {
    const origin  = request.headers.get("Origin");
    const headers = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers });
    }

    if (!isAllowedOrigin(origin)) {
      return new Response("Forbidden origin", { status: 403, headers });
    }

    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405, headers });
    }

    const url   = new URL(request.url);
    const cache = caches.default;

    // Bulk parts CSV (catalog.js): proxied so the browser gets a same-site
    // CORS response instead of hitting cdn.rebrickable.com directly, and so
    // the cache absorbs repeat downloads across visitors — this file only
    // changes once a day, so there's no reason every visitor should re-pull
    // it from origin.
    if (url.pathname === "/catalog/parts.csv.gz") {
      const cacheKey = cacheKeyFor(url.pathname);
      const cached = await cache.match(cacheKey);
      if (cached) {
        const resp = new Response(cached.body, cached);
        Object.entries(headers).forEach(([k, v]) => resp.headers.set(k, v));
        return resp;
      }

      const upstream = await fetch("https://cdn.rebrickable.com/media/downloads/parts.csv.gz");
      const body = await upstream.arrayBuffer();
      const bodyHeaders = {
        "Content-Type": upstream.headers.get("Content-Type") ?? "application/gzip",
        "Cache-Control": `public, max-age=${CSV_CACHE_TTL_S}`,
      };

      ctx.waitUntil(cache.put(cacheKey, new Response(body, { status: upstream.status, headers: bodyHeaders })));
      return new Response(body, { status: upstream.status, headers: { ...headers, ...bodyHeaders } });
    }

    if (!url.pathname.startsWith("/api/v3/lego/")) {
      return new Response("Not found", { status: 404, headers });
    }

    const cacheKey = cacheKeyFor(`${url.pathname}${url.search}`);
    const cached = await cache.match(cacheKey);
    if (cached) {
      const resp = new Response(cached.body, cached);
      Object.entries(headers).forEach(([k, v]) => resp.headers.set(k, v));
      return resp;
    }

    const upstreamUrl = `https://rebrickable.com${url.pathname}${url.search}`;
    const upstream = await fetch(upstreamUrl, {
      headers: { Authorization: `key ${env.REBRICKABLE_API_KEY}` },
    });

    const contentType = upstream.headers.get("Content-Type") ?? "";
    const bodyHeaders = {
      "Content-Type": contentType || "application/json",
      "Cache-Control": `public, max-age=${API_CACHE_TTL_S}`,
    };

    // Rebrickable's list endpoints return absolute rebrickable.com URLs in
    // "next"/"previous". The browser has no key and can't cross-origin fetch
    // rebrickable.com directly, so rewrite those to point back through this
    // Worker or every page past the first would fail.
    let body;
    if (contentType.includes("application/json")) {
      const data = await upstream.json();
      for (const field of ["next", "previous"]) {
        if (typeof data[field] === "string") {
          data[field] = data[field].replace("https://rebrickable.com", url.origin);
        }
      }
      body = JSON.stringify(data);
    } else {
      body = await upstream.text();
    }

    if (upstream.status === 200) {
      ctx.waitUntil(cache.put(cacheKey, new Response(body, { status: upstream.status, headers: bodyHeaders })));
    }
    return new Response(body, { status: upstream.status, headers: { ...headers, ...bodyHeaders } });
  },
};
