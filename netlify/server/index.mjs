import { and, eq } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { exchanges } from '../../db/schema.ts';
import { randomInt } from 'node:crypto';

const identityEndpoint = 'https://engineeringbunot.netlify.app/.netlify/identity/user';
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const view = row => ({ participants: row.participants, pairings: row.pairings, prevPairings: row.prevPairings, version: row.version });

async function userFor(request) {
  const cookie = request.headers.get('cookie') || '';
  const token = cookie.split(';').map(s => s.trim()).find(s => s.startsWith('nf_jwt='))?.slice(7);
  if (!token) return null;
  const response = await fetch(identityEndpoint, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) return null;
  const user = await response.json();
  return user.confirmed_at ? user : null;
}

export default async function handler(request) {
  try {
    const path = new URL(request.url).pathname;
    const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
    if (!path.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    if (request.method !== 'GET' && request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    if (request.method === 'POST') {
      if (request.headers.get('origin') !== new URL(request.url).origin) fail(403, 'Please use this site to make changes.');
      if (!request.headers.get('content-type')?.startsWith('application/json')) fail(415, 'JSON required.');
    }
    const [row] = await db.select().from(exchanges).where(eq(exchanges.id, 1));
    if (path === '/api/status' && request.method === 'GET') return json({ initialized: !!row });
    if (path === '/api/data' && request.method === 'GET') {
      if (!row) fail(409, 'Ask your organizer to finish setup.');
      return json(view(row));
    }
    if (path === '/api/admin' && request.method === 'GET') {
      const user = await userFor(request);
      if (!row || !user || user.id !== row.ownerId) fail(403, 'Sign in with the organizer account.');
      return json(view(row));
    }
    if (request.method !== 'POST') fail(404, 'Not found.');
    const body = await request.json().catch(() => fail(400, 'Invalid JSON.'));
    if (path === '/api/setup') {
      const user = await userFor(request);
      if (!user) fail(401, 'Confirm your email and sign in to finish setup.');
      if (row) {
        if (row.ownerId !== user.id) fail(409, 'An organizer has already set up this exchange.');
        return json(view(row));
      }
      const [created] = await db.insert(exchanges).values({ id: 1, ownerId: user.id }).onConflictDoNothing().returning();
      if (!created) fail(409, 'Setup is already complete. Reload this page.');
      return json(view(created), 201);
    }
    if (!row) fail(409, 'Ask your organizer to finish setup.');
    let participants = row.participants;
    let pairings = row.pairings;
    let prevPairings = row.prevPairings;
    if (path === '/api/register') {
      const { realName, secretName, wishlist } = body;
      if (![realName, secretName].every(v => typeof v === 'string' && v.trim() && v.length <= 150)) fail(400, 'Enter both names (up to 150 characters).');
      if (!Array.isArray(wishlist) || !wishlist.length || wishlist.length > 30 || wishlist.some(w => !w || typeof w.name !== 'string' || !w.name.trim() || w.name.length > 500 || typeof w.link !== 'string' || w.link.length > 2000 || (w.link && !/^https?:\/\//i.test(w.link)))) fail(400, 'Add wishlist items with optional http or https links.');
      if (participants.some(p => p.realName.toLowerCase() === realName.trim().toLowerCase())) fail(409, 'This name is already registered.');
      participants = [...participants, { realName: realName.trim(), secretName: secretName.trim(), wishlist }];
      pairings = [];
      prevPairings = [];
    } else if (path === '/api/shuffle') {
      const user = await userFor(request);
      if (!user || user.id !== row.ownerId) fail(403, 'Sign in with the organizer account.');
      if (participants.length < 2) fail(400, 'Need at least 2 participants.');
      // Save current pairings for undo
      prevPairings = pairings.length > 0 ? [...pairings] : prevPairings;
      const names = participants.map(p => p.realName);
      for (let i = names.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [names[i], names[j]] = [names[j], names[i]];
      }
      pairings = names.map((giver, i) => ({ giver, receiver: names[(i + 1) % names.length] }));
    } else if (path === '/api/unshuffle') {
      const user = await userFor(request);
      if (!user || user.id !== row.ownerId) fail(403, 'Sign in with the organizer account.');
      if (!prevPairings || prevPairings.length === 0) fail(400, 'No previous pairings to restore.');
      // Swap: current becomes prev, prev becomes current
      const temp = pairings;
      pairings = prevPairings;
      prevPairings = temp;
    } else if (path === '/api/edit') {
      const user = await userFor(request);
      if (!user || user.id !== row.ownerId) fail(403, 'Sign in with the organizer account.');
      const { realName, newSecretName, newWishlist, newRealName } = body;
      if (typeof realName !== 'string' || !realName.trim()) fail(400, 'Specify the participant to edit.');
      const idx = participants.findIndex(p => p.realName === realName);
      if (idx === -1) fail(404, 'Participant not found.');
      const updated = { ...participants[idx] };
      if (typeof newSecretName === 'string' && newSecretName.trim()) {
        if (newSecretName.length > 150) fail(400, 'Secret name must be 150 characters or less.');
        updated.secretName = newSecretName.trim();
      }
      if (typeof newRealName === 'string' && newRealName.trim()) {
        if (newRealName.length > 150) fail(400, 'Real name must be 150 characters or less.');
        if (newRealName.trim().toLowerCase() !== realName.toLowerCase() && participants.some(p => p.realName.toLowerCase() === newRealName.trim().toLowerCase())) fail(409, 'A participant with that real name already exists.');
        // Update pairings to reflect the new real name
        const oldName = updated.realName;
        const freshName = newRealName.trim();
        pairings = pairings.map(p => ({
          giver: p.giver === oldName ? freshName : p.giver,
          receiver: p.receiver === oldName ? freshName : p.receiver,
        }));
        prevPairings = prevPairings.map(p => ({
          giver: p.giver === oldName ? freshName : p.giver,
          receiver: p.receiver === oldName ? freshName : p.receiver,
        }));
        updated.realName = freshName;
      }
      if (Array.isArray(newWishlist)) {
        if (!newWishlist.length || newWishlist.length > 30) fail(400, 'Wishlist must have 1-30 items.');
        if (newWishlist.some(w => !w || typeof w.name !== 'string' || !w.name.trim() || w.name.length > 500 || typeof w.link !== 'string' || w.link.length > 2000 || (w.link && !/^https?:\/\//i.test(w.link)))) fail(400, 'Invalid wishlist items.');
        updated.wishlist = newWishlist;
      }
      participants = [...participants];
      participants[idx] = updated;
    } else if (path === '/api/delete') {
      const user = await userFor(request);
      if (!user || user.id !== row.ownerId) fail(403, 'Sign in with the organizer account.');
      const { realName } = body;
      if (typeof realName !== 'string' || !realName.trim()) fail(400, 'Specify the participant to delete.');
      const idx = participants.findIndex(p => p.realName === realName);
      if (idx === -1) fail(404, 'Participant not found.');
      participants = participants.filter((_, i) => i !== idx);
      // Clear pairings since they're now invalid
      pairings = [];
      prevPairings = [];
    } else if (path === '/api/import') {
      const user = await userFor(request);
      if (!user || user.id !== row.ownerId) fail(403, 'Sign in with the organizer account.');
      const { participants: importedParticipants, pairings: importedPairings } = body;
      if (!Array.isArray(importedParticipants) || !importedParticipants.length) fail(400, 'Import data must contain participants.');
      // Validate each participant
      for (const p of importedParticipants) {
        if (!p || typeof p.realName !== 'string' || !p.realName.trim() || p.realName.length > 150) fail(400, `Invalid participant name: ${p?.realName || '(empty)'}`);
        if (typeof p.secretName !== 'string' || !p.secretName.trim() || p.secretName.length > 150) fail(400, `Invalid secret name for ${p.realName}.`);
        if (!Array.isArray(p.wishlist) || !p.wishlist.length || p.wishlist.length > 30) fail(400, `Invalid wishlist for ${p.realName}.`);
        for (const w of p.wishlist) {
          if (!w || typeof w.name !== 'string' || !w.name.trim() || w.name.length > 500) fail(400, `Invalid wishlist item for ${p.realName}.`);
          if (typeof w.link !== 'string' || w.link.length > 2000 || (w.link && !/^https?:\/\//i.test(w.link))) fail(400, `Invalid wishlist link for ${p.realName}.`);
        }
      }
      // Check for duplicate real names
      const names = new Set();
      for (const p of importedParticipants) {
        const lower = p.realName.trim().toLowerCase();
        if (names.has(lower)) fail(400, `Duplicate participant: ${p.realName}`);
        names.add(lower);
      }
      participants = importedParticipants.map(p => ({
        realName: p.realName.trim(),
        secretName: p.secretName.trim(),
        wishlist: p.wishlist.map(w => ({ name: w.name.trim(), link: w.link || '' }))
      }));
      // Validate and import pairings if provided
      if (Array.isArray(importedPairings) && importedPairings.length > 0) {
        const validNames = new Set(participants.map(p => p.realName));
        const allValid = importedPairings.every(p => p && typeof p.giver === 'string' && typeof p.receiver === 'string' && validNames.has(p.giver) && validNames.has(p.receiver));
        pairings = allValid ? importedPairings : [];
      } else {
        pairings = [];
      }
      prevPairings = [];
    } else if (path === '/api/reset') {
      const user = await userFor(request);
      if (!user || user.id !== row.ownerId) fail(403, 'Sign in with the organizer account.');
      participants = [];
      pairings = [];
      prevPairings = [];
    } else {
      fail(404, 'Not found.');
    }
    const [saved] = await db.update(exchanges).set({ participants, pairings, prevPairings, version: row.version + 1 })
      .where(and(eq(exchanges.id, 1), eq(exchanges.version, row.version))).returning();
    if (!saved) fail(409, 'Someone else updated the exchange. Please try again.');
    return json(view(saved));
  } catch (error) {
    return Response.json({ error: error.status ? error.message : 'Unable to connect. Please try again.' }, { status: error.status || 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
