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
   ============================================================ */

const ALLOWED_ORIGINS = [
  "https://jackpolark.github.io",
];

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

export default {
  async fetch(request, env) {
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

    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/v3/lego/")) {
      return new Response("Not found", { status: 404, headers });
    }

    const upstreamUrl = `https://rebrickable.com${url.pathname}${url.search}`;
    const upstream = await fetch(upstreamUrl, {
      headers: { Authorization: `key ${env.REBRICKABLE_API_KEY}` },
    });

    const contentType = upstream.headers.get("Content-Type") ?? "";
    const responseHeaders = {
      ...headers,
      "Content-Type": contentType || "application/json",
      "Cache-Control": "public, max-age=60",
    };

    // Rebrickable's list endpoints return absolute rebrickable.com URLs in
    // "next"/"previous". The browser has no key and can't cross-origin fetch
    // rebrickable.com directly, so rewrite those to point back through this
    // Worker or every page past the first would fail.
    if (contentType.includes("application/json")) {
      const data = await upstream.json();
      for (const field of ["next", "previous"]) {
        if (typeof data[field] === "string") {
          data[field] = data[field].replace("https://rebrickable.com", url.origin);
        }
      }
      return new Response(JSON.stringify(data), { status: upstream.status, headers: responseHeaders });
    }

    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  },
};
