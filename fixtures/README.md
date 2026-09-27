# fixtures/ — recorded real API responses

Written only by the client's fixture recorder (`packages/binance/src/fixtures.ts`), e.g. `pnpm reach --fixtures`:

- Path: `fixtures/<module>/<endpoint>-<yyyymmdd>-<n>.json`, where `<endpoint>` is the operation ID from
  `docs/vendor/ENDPOINTS.md` (e.g. `rwa/getRwaTokenList-20260924-1.json`).
- Content: request method, signed path and body; response status, selected headers and body.
- Redacted before writing: API key and secret, our wallet addresses, any value passed in `redact`. Request
  headers (key, signature) are never stored. Public token contract addresses are kept.
- Never hand-edit or fabricate a fixture (CLAUDE.md rule 4). Tests replay these files; product code never reads them.
