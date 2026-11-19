import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace('createSnowflakes();', '');
function page(identity = {}) {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', type: 'password', hidden: true, style: {}, checkValidity: () => true, focus() {} });
    return elements.get(id);
  };
  let callback;
  const context = vm.createContext({
    document: { getElementById: get }, identity,
    window: { addEventListener: (_, handler) => { callback = handler; } },
    localStorage: { removeItem() {} }, clearInterval() {},
  });
  vm.runInContext(script, context);
  return { context, get, callback: () => callback() };
}

test('password visibility toggles accessibly without changing the password', () => {
  const { context, get } = page();
  get('adminPass').value = 'example password';
  const attrs = {};
  const button = { setAttribute: (key, value) => { attrs[key] = value; } };
  context.togglePassword('adminPass', button);
  assert.equal(get('adminPass').type, 'text');
  assert.equal(attrs['aria-pressed'], 'true');
  context.togglePassword('adminPass', button);
  assert.equal(get('adminPass').type, 'password');
  assert.equal(attrs['aria-pressed'], 'false');
  assert.equal(get('adminPass').value, 'example password');
});

test('email retries surface rate limits and release the button', async () => {
  const { context, get } = page({ signup: async () => { throw Object.assign(new Error('Rate limited'), { status: 429 }); } });
  get('setupEmail').value = 'organizer@example.test';
  get('setupAdminPass').value = 'example password';
  const button = {};
  await context.resendConfirmation('setupEmail', 'setupAdminPass', button);
  assert.match(get('authMessage').textContent, /Wait a few minutes/);
  assert.equal(button.disabled, false);
});

test('recovery callback opens password entry before normal initialization', async () => {
  const { context, get, callback } = page({ handleAuthCallback: async () => ({ type: 'recovery' }) });
  await callback();
  assert.equal(get('recoveryScreen').hidden, false);
  assert.equal(get('mainApp').style.display, 'none');
  let saved;
  context.identity.updateUser = async update => { saved = update.password; };
  context.initApp = async () => {};
  get('recoveryPassword').value = 'new example password';
  await context.saveRecoveredPassword();
  assert.equal(saved, 'new example password');
  assert.equal(get('recoveryPassword').value, '');
  assert.equal(get('recoveryScreen').hidden, true);
});

test('name suggestions tolerate typos, transpositions, accents, and partial names', () => {
  const { context } = page();
  const participants = ['Camila Reyes', 'Mateo Santos', 'José Cruz'].map(realName => ({ realName }));
  for (const query of ['Camlia', 'Camila Reyse', 'Reyes', 'cami']) {
    assert.equal(context.matchingNames(participants, query)[0], 'Camila Reyes');
  }
  assert.equal(context.matchingNames(participants, 'jose')[0], 'José Cruz');
  assert.equal(context.matchingNames(participants, 'zzzzzzzzzz').length, 0);
});

test('classmate list hides aliases while admin wishlists show items even before pairing', () => {
  const { context, get } = page();
  context.esc = value => String(value).replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const data = { participants: [{ realName: 'Camila Reyes', secretName: 'Hidden Alias', wishlist: [
    { name: '<Notebook>', link: 'https://example.test/item' },
    { name: 'Pencil', link: 'javascript:alert(1)' },
  ] }], pairings: [] };
  context.renderParticipants(data);
  assert.match(get('participantList').innerHTML, /Camila Reyes/);
  assert.doesNotMatch(get('participantList').innerHTML, /Hidden Alias/);
  context.renderAdminPairings(data);
  assert.match(get('adminWishlists').innerHTML, /Hidden Alias/);
  assert.match(get('adminWishlists').innerHTML, /&lt;Notebook>/);
  assert.match(get('adminWishlists').innerHTML, /https:\/\/example.test\/item/);
  assert.doesNotMatch(get('adminWishlists').innerHTML, /javascript:/);
});

test('a misspelled name suggests a selection without revealing a match', async () => {
  const { context, get } = page();
  get('revealName').value = 'Camlia Reyes';
  get('revealResult').innerHTML = 'Previous match';
  const data = { participants: [{ realName: 'Camila Reyes' }], pairings: [{ giver: 'Camila Reyes', receiver: 'Mateo Santos' }] };
  context.loadData = async () => data;
  context.closeNameSuggestions = () => {};
  let suggested = false;
  context.updateNameSuggestions = () => { suggested = true; };
  context.showToast = () => {};
  await context.revealMatch();
  assert.equal(suggested, true);
  assert.equal(get('revealResult').innerHTML, '');
});
