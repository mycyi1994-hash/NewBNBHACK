/**
 * The OpenAPI document (TASKS M2-08) against the code: every route file is documented with the
 * methods it exports and nothing else, and the request bodies are the schemas the routes enforce.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GET as openapiRoute } from '../app/api/openapi/route';
import { openApiDocument } from '../lib/server/openapi';
import { JudgePlanBody, SkillPlanBody } from '../lib/server/schemas';
import { call } from './harness';

const API = path.join(import.meta.dirname, '..', 'app', 'api');

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(full);
    return entry.name === 'route.ts' ? [full] : [];
  });
}

const routes = routeFiles(API).map((file) => ({
  file,
  path: `/api/${path.relative(API, path.dirname(file)).split(path.sep).join('/')}`.replace(
    /\[(\w+)\]/g,
    '{$1}',
  ),
}));

describe('OpenAPI document', () => {
  const doc = openApiDocument('https://yieldvest.example');

  it('documents every route file, with exactly the methods it exports', async () => {
    expect(Object.keys(doc.paths).sort()).toEqual(routes.map((r) => r.path).sort());
    for (const route of routes) {
      const exported = Object.keys((await import(route.file)) as Record<string, unknown>)
        .filter((name) => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(name))
        .map((name) => name.toLowerCase())
        .sort();
      const documented = Object.keys(doc.paths[route.path as keyof typeof doc.paths]).sort();
      expect({ path: route.path, methods: documented }).toEqual({
        path: route.path,
        methods: exported,
      });
    }
  });

  it('takes request bodies from the schemas the routes validate with', () => {
    const { JudgePlanBody: judge, SkillPlanBody: skill } = doc.components.schemas;
    expect(judge).toMatchObject({ type: 'object', required: ['ticker', 'amountUsd'] });
    expect(skill).toMatchObject({
      type: 'object',
      required: [
        'owner',
        'walletAddress',
        'ticker',
        'issuer',
        'contributionUsd',
        'maxPerBuyUsd',
        'maxDailyUsd',
      ],
    });
    // The same zod objects parse what the document promises.
    expect(JudgePlanBody.parse({ ticker: 'nvda', amountUsd: '5' })).toEqual({
      ticker: 'NVDA',
      mode: 'safe',
      amountUsd: '5',
      window: 'regular_session',
    });
    expect(() => SkillPlanBody.parse({ owner: 'skill', walletAddress: '0x12' })).toThrow();
    expect(JSON.stringify(doc)).not.toContain('"$schema"');
  });

  it('is served at /api/openapi with the configured app URL', async () => {
    const res = await call<{ openapi: string; servers: { url: string }[] }>(openapiRoute, {
      path: '/api/openapi',
    });
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.servers).toHaveLength(1);
  });
});
