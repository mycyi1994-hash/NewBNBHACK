/**
 * OpenNext adapter for Cloudflare Workers (G2-2), defaults only: every route is dynamic and
 * reads Postgres, so there is no incremental cache, tag cache or revalidation queue to bind.
 */
import { defineCloudflareConfig } from '@opennextjs/cloudflare';

export default defineCloudflareConfig();
