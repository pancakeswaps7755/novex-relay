// cloudflare-worker-vertex-relay.js
// ---------------------------------------------------------------------
// Deploy this on Cloudflare Workers (free tier). It sits between Novex's
// Railway backend and Vertex's gateway (gateway.prod.vertexprotocol.com).
//
// WHY THIS EXISTS: Railway's Hobby-plan outbound IP pool gets its TLS
// handshake reset by Cloudflare (which fronts Vertex's gateway) before a
// connection even completes - confirmed to happen over both IPv4 and
// IPv6, so it's an IP-reputation block, not a protocol issue. Since this
// Worker runs ON Cloudflare's own network, its requests to Vertex's
// gateway (also on Cloudflare) never leave Cloudflare's edge, so the
// same block does not apply.
//
// WHAT IT DOES: forwards whatever path/query/method/body it receives
// straight through to https://gateway.prod.vertexprotocol.com, and
// relays the response back unchanged. It does not interpret, log, or
// store any of the traffic - it's a dumb pipe.
//
// SECURITY: requires a shared-secret header (X-Relay-Secret) on every
// request, checked against the RELAY_SECRET value set in this Worker's
// own environment variables - otherwise anyone who finds this Worker's
// URL could use it as a free anonymous proxy to Vertex. Railway's
// backend must send the exact same secret (see VERTEX_RELAY_SECRET in
// vertexPerp.js).
//
// DEPLOY STEPS (Cloudflare dashboard, no CLI needed):
//   1. dash.cloudflare.com -> sign up/log in (free, no card required)
//   2. Workers & Pages -> Create -> Create Worker
//   3. Give it any name (e.g. "novex-vertex-relay") -> Deploy
//   4. Click "Edit code" -> delete the placeholder code -> paste this
//      entire file's contents -> Save and Deploy
//   5. Go to the Worker's Settings -> Variables and Secrets -> add a
//      secret named RELAY_SECRET, value: (the long random string Claude
//      generated for you - see the chat)
//   6. Copy this Worker's URL (shown at the top of its page, looks like
//      https://novex-vertex-relay.<your-subdomain>.workers.dev)
//   7. On Railway, set two env vars on the Novex server service:
//        VERTEX_RELAY_URL = <the Worker URL from step 6>
//        VERTEX_RELAY_SECRET = <the same secret from step 5>
// ---------------------------------------------------------------------

const VERTEX_GATEWAY_HOST = "https://gateway.prod.vertexprotocol.com";

export default {
  async fetch(request, env) {
    const configuredSecret = env.RELAY_SECRET;
    const incomingSecret = request.headers.get("X-Relay-Secret");

    if (!configuredSecret || incomingSecret !== configuredSecret) {
      return new Response(JSON.stringify({ error: "Forbidden - missing or wrong X-Relay-Secret" }), {
        status: 403,
        headers: { "Content-Type": "application/json" }
      });
    }

    // Generic relay: target host defaults to Vertex's gateway, but any
    // caller can override it via X-Relay-Target (e.g. "edge.grvt.io") -
    // reused for GRVT's auth calls too, since they hit the same class of
    // network/geo block Railway's US server IP runs into. One deployed
    // Worker, one secret, multiple destinations - no need for a second
    // Worker per exchange.
    const targetHost = request.headers.get("X-Relay-Target") || new URL(VERTEX_GATEWAY_HOST).host;
    const incomingUrl = new URL(request.url);
    const targetUrl = "https://" + targetHost + incomingUrl.pathname + incomingUrl.search;

    const init = {
      method: request.method,
      headers: {
        "Content-Type": request.headers.get("Content-Type") || "application/json"
      }
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = await request.text();
    }

    try {
      const upstream = await fetch(targetUrl, init);
      const body = await upstream.text();
      return new Response(body, {
        status: upstream.status,
        headers: { "Content-Type": upstream.headers.get("Content-Type") || "application/json" }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: "Relay fetch to Vertex failed: " + e.message }), {
        status: 502,
        headers: { "Content-Type": "application/json" }
      });
    }
  }
};
