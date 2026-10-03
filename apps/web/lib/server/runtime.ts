/**
 * Where the server code runs. On Cloudflare Workers (G2-2: apps/web through the OpenNext adapter)
 * two things differ from a Node server: an I/O object such as a database socket belongs to the
 * request that opened it (context.ts), and the client's address is in cf-connecting-ip (http.ts).
 */
export const onWorkers =
  typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';
