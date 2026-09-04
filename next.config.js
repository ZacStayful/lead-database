/** @type {import('next').NextConfig} */

/**
 * The /.well-known OAuth discovery documents are served through REWRITES rather
 * than from an `src/app/.well-known/…` directory.
 *
 * Next's App Router does not reliably route a dot-prefixed path segment, and the
 * failure mode is a 404 — which is indistinguishable from the 404 these documents
 * exist to fix. A rewrite onto an ordinary route is provably served, and the
 * handlers are plain route handlers with nothing special about them.
 *
 * RFC 9728 clients derive the protected-resource document either at the bare
 * path or with the resource's path inserted (`…/api/mcp`), and Claude probes
 * both, so the `:path*` form answers any suffix with the one document. The
 * `resource` field inside it is what actually identifies us.
 *
 * The authorization-server document is served at the BARE PATH ONLY: our issuer
 * has no path component, so RFC 8414's path-insertion form does not apply, and
 * answering at `…/api/mcp` would hand a strict client an issuer that does not
 * match the URL it derived — a worse failure than a 404, because it comes after
 * the client has committed to us.
 */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: "/.well-known/oauth-protected-resource",
        destination: "/api/oauth/metadata/protected-resource",
      },
      {
        source: "/.well-known/oauth-protected-resource/:path*",
        destination: "/api/oauth/metadata/protected-resource",
      },
      {
        source: "/.well-known/oauth-authorization-server",
        destination: "/api/oauth/metadata/authorization-server",
      },
    ];
  },
};

module.exports = nextConfig;
