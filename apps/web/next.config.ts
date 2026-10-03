import type { NextConfig } from 'next';

/** M3-05: every response; the Content-Security-Policy (with its nonce) is set in proxy.ts. */
const SECURITY_HEADERS = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  headers: () => Promise.resolve([{ source: '/:path*', headers: SECURITY_HEADERS }]),
  // Not bundled by Next, so the Cloudflare build (OpenNext, G2-2) bundles postgres.js's own
  // `workerd` build (cloudflare:sockets) rather than its Node build: there every TLS connection
  // (Neon's sslmode=require) failed with ERR_OPTION_NOT_IMPLEMENTED "The
  // options.rejectUnauthorized option is not implemented". An external package must resolve from
  // apps/web, hence postgres in its dependencies.
  serverExternalPackages: ['postgres'],
  // Workspace packages ship TypeScript sources (exports → src/*.ts) with NodeNext `.js` imports.
  transpilePackages: [
    '@yieldvest/binance',
    '@yieldvest/chain',
    '@yieldvest/config',
    '@yieldvest/core',
    '@yieldvest/db',
  ],
  webpack: (config: { resolve: { extensionAlias?: Record<string, string[]> } }) => {
    config.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] };
    return config;
  },
};

export default nextConfig;
