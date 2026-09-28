import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import worker from './index';
import { dishId, type RatingsEnv } from './ratings';

let mf: Miniflare;
let env: RatingsEnv;

const RATER = 'rater-1';

function req(
  path: string,
  method = 'GET',
  body?: unknown,
  raterId: string | null = RATER
): Request {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (raterId) headers['X-Rater-ID'] = raterId;
  return new Request(`https://example.org${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
}

const rate = (dish: string, rating: unknown, raterId: string | null = RATER) =>
  worker.fetch(req('/api/ratings', 'POST', { dish, rating }, raterId), env);

const read = (dishes: string[], raterId: string | null = RATER) =>
  worker.fetch(req(`/api/ratings?dishes=${encodeURIComponent(dishes.join(','))}`, 'GET', undefined, raterId), env);

const catalog = (date: string, dishes: unknown) =>
  worker.fetch(req('/api/dishes/catalog', 'POST', { date, dishes }), env);

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['RATINGS_DB']
  });
  env = { RATINGS_DB: await mf.getD1Database('RATINGS_DB') } as unknown as RatingsEnv;
  // Vitest runs from the worker directory.
  const schema = readFileSync('schema.sql', 'utf8');
  for (const statement of schema.split(';').filter((part: string) => part.trim())) {
    await env.RATINGS_DB.prepare(statement).run();
  }
});

beforeEach(async () => {
  await env.RATINGS_DB.batch([
    env.RATINGS_DB.prepare('DELETE FROM dish_ratings'),
    env.RATINGS_DB.prepare('DELETE FROM rater_writes'),
    env.RATINGS_DB.prepare('DELETE FROM dish_days'),
    env.RATINGS_DB.prepare('DELETE FROM dishes')
  ]);
});

afterAll(async () => {
  await mf.dispose();
});

describe('dish ids', () => {
  test('normalise the same way the widget does', () => {
    expect(dishId('  Scrambled   Eggs ')).toBe('scrambled eggs');
    expect(dishId('BBQ Chicken Wings')).toBe('bbq chicken wings');
  });
});

describe('reading ratings', () => {
  test('unknown dishes read as empty, and no dishes is an empty map', async () => {
    expect(await (await read(['Nothing Yet'])).json()).toEqual({ ratings: {} });
    expect(await (await worker.fetch(req('/api/ratings'), env)).json()).toEqual({ ratings: {} });
  });

  test('aggregates every rater and reports the caller own rating', async () => {
    await rate('Scrambled Eggs', 5);
    await rate('Scrambled Eggs', 3, 'rater-2');
    await rate('Scrambled Eggs', 4, 'rater-3');

    const mine = (await (await read(['scrambled eggs'])).json()) as any;
    expect(mine.ratings['scrambled eggs']).toEqual({ count: 3, average: 4, myRating: 5 });

    const anonymous = (await (await read(['scrambled eggs'], null)).json()) as any;
    expect(anonymous.ratings['scrambled eggs']).toEqual({ count: 3, average: 4, myRating: null });
  });

  test('rounds the average to one decimal', async () => {
    await rate('Poutine', 5, 'rater-1');
    await rate('Poutine', 4, 'rater-2');
    await rate('Poutine', 4, 'rater-3');
    const data = (await (await read(['Poutine'])).json()) as any;
    expect(data.ratings.poutine.average).toBe(4.3);
  });

  test('rejects a rater id that is missing or malformed', async () => {
    expect((await rate('Poutine', 4, null)).status).toBe(400);
    expect((await rate('Poutine', 4, 'has spaces')).status).toBe(400);
    expect((await rate('Poutine', 4, 'x'.repeat(65))).status).toBe(400);
  });
});

describe('writing ratings', () => {
  test('re-rating replaces the previous value instead of adding one', async () => {
    expect(await (await rate('Poutine', 5)).json()).toMatchObject({
      rating: { count: 1, average: 5, myRating: 5 }
    });
    expect(await (await rate('Poutine', 2)).json()).toMatchObject({
      rating: { count: 1, average: 2, myRating: 2 }
    });
  });

  test('validates the dish and the star value', async () => {
    for (const rating of [0, 6, 2.5, 'three', null, undefined]) {
      expect((await rate('Poutine', rating)).status).toBe(400);
    }
    expect((await rate('   ', 4)).status).toBe(400);
    expect((await rate('x'.repeat(141), 4)).status).toBe(400);
    expect((await worker.fetch(req('/api/ratings', 'POST', { rating: 4 }), env)).status).toBe(400);
    expect((await worker.fetch(req('/api/ratings', 'POST', undefined), env)).status).toBe(400);
  });

  test('dish names are matched case- and space-insensitively', async () => {
    await rate('Scrambled Eggs', 5);
    await rate('  scrambled   eggs ', 3);
    const data = (await (await read(['Scrambled Eggs'])).json()) as any;
    expect(data.ratings['scrambled eggs'].count).toBe(1);
    expect(data.ratings['scrambled eggs'].myRating).toBe(3);
  });

  test('a rater is capped per day', async () => {
    const day = new Date().toISOString().slice(0, 10);
    await env.RATINGS_DB
      .prepare('INSERT INTO rater_writes (rater_id, day, count) VALUES (?, ?, 300)')
      .bind(RATER, day)
      .run();
    expect((await rate('One Too Many', 4)).status).toBe(429);
    // A different rater on the same day is unaffected.
    expect((await rate('One Too Many', 4, 'rater-2')).status).toBe(200);
  });
});

describe('removing ratings', () => {
  const remove = (dish: unknown, raterId: string | null = RATER) =>
    worker.fetch(req('/api/ratings', 'DELETE', { dish }, raterId), env);

  test('clears only the caller own rating and returns the new aggregate', async () => {
    await rate('Scrambled Eggs', 5);
    await rate('Scrambled Eggs', 3, 'rater-2');
    await rate('Scrambled Eggs', 4, 'rater-3');

    const after = (await (await remove('Scrambled Eggs')).json()) as any;
    expect(after.rating).toEqual({ count: 2, average: 3.5, myRating: null });

    const mine = (await (await read(['scrambled eggs'])).json()) as any;
    expect(mine.ratings['scrambled eggs']).toEqual({ count: 2, average: 3.5, myRating: null });
    // Another rater's rating is untouched.
    const other = (await (await read(['scrambled eggs'], 'rater-2')).json()) as any;
    expect(other.ratings['scrambled eggs'].myRating).toBe(3);
  });

  test('deleting the last rating leaves the dish unrated', async () => {
    await rate('Poutine', 4);
    const after = (await (await remove('Poutine')).json()) as any;
    expect(after.rating).toEqual({ count: 0, average: 0, myRating: null });

    // A dish with no ratings is absent from the read map, as before this change.
    const data = (await (await read(['Poutine'])).json()) as any;
    expect(data.ratings.poutine).toBeUndefined();
    expect(data.ratings).toEqual({});
  });

  test('deleting a rating you never made is a no-op, not an error', async () => {
    await rate('Poutine', 4, 'rater-2');
    const response = await remove('Poutine');
    expect(response.status).toBe(200);
    const after = (await response.json()) as any;
    expect(after.rating).toEqual({ count: 1, average: 4, myRating: null });
  });

  test('matches dish names case- and space-insensitively', async () => {
    await rate('Scrambled Eggs', 5);
    const response = await remove('  scrambled   eggs ');
    expect(response.status).toBe(200);
    const after = (await response.json()) as any;
    expect(after.rating).toEqual({ count: 0, average: 0, myRating: null });
  });

  test('requires a rater id and a valid dish', async () => {
    expect((await remove('Poutine', null)).status).toBe(400);
    expect((await remove('Poutine', 'has spaces')).status).toBe(400);
    expect((await remove('   ')).status).toBe(400);
    expect((await remove('x'.repeat(141))).status).toBe(400);
    expect((await worker.fetch(req('/api/ratings', 'DELETE', undefined), env)).status).toBe(400);
  });

  test('after clearing, the rater can rate the dish again', async () => {
    await rate('Poutine', 5);
    await remove('Poutine');
    expect(await (await rate('Poutine', 2)).json()).toMatchObject({
      rating: { count: 1, average: 2, myRating: 2 }
    });
  });
});

describe('cataloguing', () => {
  test('records each dish once and keeps ratings across days', async () => {
    expect(await (await catalog('2026-09-25', ['Scrambled Eggs', 'scrambled eggs', 'Poutine'])).json())
      .toEqual({ catalogued: 2 });
    await rate('Poutine', 5);

    expect(await (await catalog('2026-09-26', ['Poutine', 'Naan Bread'])).json())
      .toEqual({ catalogued: 2 });

    const listed = (await (await worker.fetch(req('/api/dishes'), env)).json()) as any;
    const poutine = listed.dishes.find((dish: any) => dish.id === 'poutine');
    expect(poutine).toMatchObject({ name: 'Poutine', firstSeen: '2026-09-25', lastSeen: '2026-09-26', count: 1, average: 5 });

    const days = await env.RATINGS_DB
      .prepare('SELECT day FROM dish_days WHERE dish_id = ? ORDER BY day')
      .bind('poutine')
      .all<{ day: string }>();
    expect((days.results ?? []).map((row) => row.day)).toEqual(['2026-09-25', '2026-09-26']);
  });

  test('validates the date and the dish list', async () => {
    expect((await catalog('25-09-2026', ['Poutine'])).status).toBe(400);
    expect((await catalog('2026-09-25', 'Poutine')).status).toBe(400);
    expect(await (await catalog('2026-09-25', [])).json()).toEqual({ catalogued: 0 });
    expect(await (await catalog('2026-09-25', [42, '', '  '])).json()).toEqual({ catalogued: 0 });
  });
});

describe('routing', () => {
  test('answers preflight and rejects unknown routes', async () => {
    const options = await worker.fetch(req('/api/ratings', 'OPTIONS'), env);
    expect(options.status).toBe(204);
    expect(options.headers.get('Access-Control-Allow-Origin')).toBe('*');

    expect((await worker.fetch(req('/api/nope'), env)).status).toBe(404);
    expect((await worker.fetch(req('/api/dishes', 'DELETE'), env)).status).toBe(404);
  });

  test('DELETE is advertised in the CORS methods', async () => {
    const options = await worker.fetch(req('/api/ratings', 'OPTIONS'), env);
    expect(options.headers.get('Access-Control-Allow-Methods')).toContain('DELETE');
  });

  test('GET responses carry CORS so an iframe on another site can read them', async () => {
    const response = await read(['Poutine']);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});
