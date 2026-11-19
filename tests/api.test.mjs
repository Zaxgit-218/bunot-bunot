import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

let row;
let conflict = false;
let user = null;
const columns = { id: 'id', version: 'version' };
const matches = (record, conditions) => conditions.every(c => record[c.column] === c.value);
const database = {
  select: () => ({ from: () => ({ where: async () => row ? [structuredClone(row)] : [] }) }),
  insert: () => ({ values: values => ({ onConflictDoNothing: () => ({ returning: async () => {
    if (row) return [];
    row = { participants: [], pairings: [], version: 0, ...values };
    return [structuredClone(row)];
  } }) }) }),
  update: () => ({ set: values => ({ where: conditions => ({ returning: async () => {
    if (conflict || !matches(row, conditions)) return [];
    row = { ...row, ...values };
    return [structuredClone(row)];
  } }) }) }),
};
mock.module('drizzle-orm', { namedExports: {
  eq: (column, value) => ({ column, value }), and: (...conditions) => conditions,
} });
mock.module('../db/index.ts', { namedExports: { db: database } });
mock.module('../db/schema.ts', { namedExports: { exchanges: columns } });
const { default: handler } = await import('../netlify/server/index.mjs');
mock.method(globalThis, 'fetch', async (url) => {
  assert.equal(url, 'https://engineeringbunot.netlify.app/.netlify/identity/user');
  return user ? Response.json(user) : Response.json({}, { status: 401 });
});
const origin = 'https://example.netlify.app';
const call = (path, body, authenticated = false, requestOrigin = origin) => handler(new Request(origin + '/api/' + path, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { 'Content-Type': 'application/json', Origin: requestOrigin, ...(authenticated ? { Cookie: 'nf_jwt=test-session' } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
}));
const participant = name => ({ realName: name, secretName: 'Alias ' + name, wishlist: [{ name: 'Book', link: '' }] });

test('fresh setup requires a confirmed organizer and cannot be claimed twice', async () => {
  row = undefined;
  assert.deepEqual(await (await call('status')).json(), { initialized: false });
  assert.equal((await call('setup', {})).status, 401);
  user = { id: 'organizer', confirmed_at: '2026-11-17' };
  assert.equal((await call('setup', {}, true)).status, 201);
  user = { id: 'outsider', confirmed_at: '2026-11-17' };
  assert.equal((await call('setup', {}, true)).status, 409);
  assert.equal(row.ownerId, 'organizer');
});

test('registration persists wishlists, rejects duplicates and unsafe links', async () => {
  assert.equal((await call('register', participant('Ada'))).status, 200);
  assert.equal((await call('register', participant('ada'))).status, 409);
  assert.equal((await call('register', { ...participant('Bob'), wishlist: [{ name: 'Bad link', link: 'javascript:alert(1)' }] })).status, 400);
  assert.equal((await call('register', participant('Bob'))).status, 200);
  assert.equal(row.participants.length, 2);
  const data = await (await call('data')).json();
  assert.equal(data.participants[0].wishlist[0].name, 'Book');
  assert.equal(data.ownerId, undefined);
  assert.equal(data.adminPass, undefined);
});

test('only the organizer can pair or reset, and nobody draws themselves', async () => {
  assert.equal((await call('shuffle', {})).status, 403);
  assert.equal((await call('reset', {}, true)).status, 403);
  user = { id: 'organizer', confirmed_at: '2026-11-17' };
  assert.equal((await call('shuffle', {}, true)).status, 200);
  assert.equal(row.pairings.length, 2);
  assert.ok(row.pairings.every(p => p.giver !== p.receiver));
  assert.equal(new Set(row.pairings.map(p => p.receiver)).size, 2);
});

test('conflicting updates fail without overwriting saved records', async () => {
  conflict = true;
  const before = structuredClone(row);
  assert.equal((await call('register', participant('Cara'))).status, 409);
  assert.deepEqual(row, before);
  conflict = false;
  assert.equal((await call('register', participant('Cara'))).status, 200);
  assert.deepEqual(row.pairings, []);
});

test('cross-site writes are rejected and reset retains organizer ownership', async () => {
  assert.equal((await call('reset', {}, true, 'https://elsewhere.example')).status, 403);
  assert.equal((await call('reset', {}, true)).status, 200);
  assert.deepEqual(row.participants, []);
  assert.deepEqual(row.pairings, []);
  assert.equal(row.ownerId, 'organizer');
});
