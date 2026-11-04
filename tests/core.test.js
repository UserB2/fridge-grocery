import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../core.js';

test('money accepts zero and decimal line totals, while blank stays missing', () => {
  assert.equal(typeof core.parseMoney, 'function');
  for (const [input, expected] of [['', null], ['  ', null], [null, null], ['0', 0], [0, 0], ['12.34', 12.34], [' 7.5 ', 7.5]]) {
    assert.equal(core.parseMoney(input), expected);
  }
});

test('money rejects negative, malformed, nonfinite and fractional-cent amounts', () => {
  assert.equal(typeof core.parseMoney, 'function');
  for (const input of ['-1', '1.234', '1e2', '12 dollars', Infinity, NaN, {}, true]) {
    assert.throws(() => core.parseMoney(input), /[가-힣]/);
  }
});

test('new browser profiles have independent empty collections', () => {
  assert.equal(typeof core.freshProfile, 'function');
  const first = core.freshProfile('a', '첫 번째');
  const second = core.freshProfile('b', '두 번째');
  first.fridge.push({ name: '우유' });
  assert.equal(second.fridge.length, 0);
  assert.deepEqual(second, { id: 'b', name: '두 번째', fridge: [], shopping: [], purchases: [], recommendations: {} });
});

test('purchase summary adds line totals in cents without multiplying quantities', () => {
  assert.equal(typeof core.purchaseSummary, 'function');
  assert.deepEqual(core.purchaseSummary({ total: 0.4, items: [{ price: 0.1, quantity: '10' }, { price: 0.2 }, { price: 0 }, { price: null }] }), {
    subtotal: 0.3, priced: 3, count: 4, difference: 0.1,
  });
  assert.deepEqual(core.purchaseSummary({ total: null, items: [{ price: null }] }), {
    subtotal: 0, priced: 0, count: 1, difference: null,
  });
});

test('persist writes the entire next state once and returns it for acceptance', () => {
  assert.equal(typeof core.persistState, 'function');
  const writes = [];
  const state = { activeProfileId: 'a', profiles: [core.freshProfile('a', '가족')] };
  const result = core.persistState({ setItem(key, value) { writes.push([key, value]); } }, 'fridge', state);
  assert.equal(result, state);
  assert.deepEqual(writes, [['fridge', JSON.stringify(state)]]);
});

test('storage failure throws without changing the proposed state', () => {
  assert.equal(typeof core.persistState, 'function');
  const state = { profiles: [core.freshProfile('a', '가족')] };
  const before = JSON.stringify(state);
  let writes = 0;
  assert.throws(() => core.persistState({ setItem() { writes += 1; throw new Error('quota'); } }, 'fridge', state), /quota/);
  assert.equal(writes, 1);
  assert.equal(JSON.stringify(state), before);
});

const shoppingProfile = () => ({
  ...core.freshProfile('a', '가족'),
  shopping: [
    { id: 'apple', ingredientId: null, name: '특별한 사과', category: '과일', quantity: '3', unit: '개', location: '냉장', expiry: '2026-11-09', price: 0.1, checked: true, recipeIds: ['r1'] },
    { id: 'milk', ingredientId: null, name: '목장 우유', category: '유제품', quantity: '2', unit: '팩', location: '냉장', expiry: '', price: 0.2, checked: false, recipeIds: [] },
  ],
});

test('checkout snapshots only checked groceries and preserves pending entries', () => {
  assert.equal(typeof core.savePurchase, 'function');
  const profile = shoppingProfile();
  const before = JSON.stringify(profile);
  const next = core.savePurchase(profile, { date: '2026-11-03', title: '주간 장보기', store: '시장', currency: 'USD', total: '0.15' });
  assert.equal(JSON.stringify(profile), before);
  assert.equal(next.shopping.length, 1);
  assert.equal(next.shopping[0].id, 'milk');
  assert.equal(next.purchases.length, 1);
  const saved = next.purchases[0];
  assert.ok(saved.id);
  assert.equal(saved.date, '2026-11-03');
  assert.equal(saved.title, '주간 장보기');
  assert.equal(saved.store, '시장');
  assert.equal(saved.currency, 'USD');
  assert.equal(saved.total, 0.15);
  assert.equal(saved.items.length, 1);
  assert.equal(saved.items[0].name, '특별한 사과');
  assert.equal(saved.items[0].transferred, false);
  next.purchases[0].items[0].recipeIds.push('r2');
  assert.deepEqual(profile.shopping[0].recipeIds, ['r1']);
});

test('checkout rejects empty selections and invalid amounts without changing a profile', () => {
  assert.equal(typeof core.savePurchase, 'function');
  const profile = shoppingProfile();
  const before = JSON.stringify(profile);
  assert.throws(() => core.savePurchase(profile, { currency: 'USD', total: '-1' }), /[가-힣]/);
  const invalidLine = structuredClone(profile);
  invalidLine.shopping[0].price = '1.234';
  assert.throws(() => core.savePurchase(invalidLine, { currency: 'KRW' }), /[가-힣]/);
  const empty = core.freshProfile('b', '빈 목록');
  assert.throws(() => core.savePurchase(empty, { currency: 'USD' }), /[가-힣]/);
  assert.throws(() => core.savePurchase(profile, { currency: 'EUR' }), /[가-힣]/);
  assert.equal(JSON.stringify(profile), before);
});

test('purchased snapshots transfer once even after the transferred stock is deleted', () => {
  assert.equal(typeof core.transferPurchase, 'function');
  const saved = core.savePurchase(shoppingProfile(), { currency: 'KRW', total: '0' });
  const purchase = saved.purchases[0];
  const next = core.transferPurchase(saved, purchase.id, [purchase.items[0].id]);
  assert.equal(saved.fridge.length, 0);
  assert.equal(saved.purchases[0].items[0].transferred, false);
  assert.equal(next.fridge.length, 1);
  assert.equal(next.fridge[0].name, '특별한 사과');
  assert.equal(next.fridge[0].quantity, '3');
  assert.equal(next.fridge[0].checked, false);
  assert.notEqual(next.fridge[0].id, purchase.items[0].id);
  assert.equal(next.purchases[0].items[0].transferred, true);
  const deleted = { ...next, fridge: [] };
  const retried = core.transferPurchase(deleted, purchase.id, [purchase.items[0].id]);
  assert.equal(retried.fridge.length, 0);
  assert.equal(retried.purchases[0].items[0].transferred, true);
  assert.equal(retried.purchases[0].items[0].price, 0.1);
});

test('checkout can transfer immediately and later additions keep a separate purchase history', () => {
  assert.equal(typeof core.savePurchase, 'function');
  const first = core.savePurchase(shoppingProfile(), { currency: 'USD', transfer: true });
  assert.equal(first.fridge.length, 1);
  assert.equal(first.purchases[0].items[0].transferred, true);
  first.shopping[0].checked = true;
  const second = core.savePurchase(first, { currency: 'KRW', total: 0, transfer: true });
  assert.equal(second.purchases.length, 2);
  assert.equal(second.fridge.length, 2);
  assert.deepEqual(new Set(second.purchases.map(p => p.currency)), new Set(['USD', 'KRW']));
  assert.equal(first.purchases.length, 1);
});

test('ingredient aliases and surrounding whitespace resolve to one canonical item', async () => {
  assert.equal(typeof core.findIngredient, 'function');
  assert.equal(typeof core.makeItem, 'function');
  const { ingredients } = await import('../data.js');
  const ingredient = ingredients.find(entry => entry.aliases.length > 0);
  assert.ok(ingredient, 'catalog must include an alias to exercise canonical matching');
  assert.equal(core.normalizeName('  MiXeD 이름  '), 'mixed 이름');
  assert.equal(core.findIngredient(`  ${ingredient.aliases[0].toUpperCase()}  `).id, ingredient.id);
  const item = core.makeItem({ name: ingredient.aliases[0], quantity: 0, price: '0' });
  assert.ok(item.id);
  assert.equal(item.ingredientId, ingredient.id);
  assert.equal(item.name, ingredient.name);
  assert.equal(item.category, ingredient.category);
  assert.equal(item.quantity, '0');
  assert.equal(item.price, 0);
  assert.deepEqual(item.recipeIds, []);
  assert.equal(item.location, '냉장');
  assert.equal(item.checked, false);
  assert.equal(item.expiry, '');
  assert.equal(item.unit, '');
});

test('custom items preserve their name and manual category without shared recipe arrays', () => {
  assert.equal(typeof core.makeItem, 'function');
  const recipeIds = ['r1'];
  const item = core.makeItem({ name: '  우리집 특별 소스  ', category: '직접 분류', recipeIds });
  assert.equal(item.ingredientId, null);
  assert.equal(item.name, '우리집 특별 소스');
  assert.equal(item.category, '직접 분류');
  assert.equal(item.quantity, '');
  assert.equal(item.price, null);
  recipeIds.push('r2');
  assert.deepEqual(item.recipeIds, ['r1']);
  assert.equal(core.findIngredient('존재하지 않는 제품 xyz'), null);
});

test('recipe readiness excludes expired and zero stock, but ignores optional ingredients', async () => {
  assert.equal(typeof core.availableIds, 'function');
  assert.equal(typeof core.recipeStatus, 'function');
  const { ingredients } = await import('../data.js');
  const [a, b, c, d] = ingredients;
  const profile = core.freshProfile('a', '가족');
  profile.fridge = [
    core.makeItem({ ingredientId: a.id, quantity: '', expiry: '2026-11-03' }),
    core.makeItem({ ingredientId: b.id, quantity: '0.00' }),
    core.makeItem({ ingredientId: c.id, quantity: '2', expiry: '2026-11-02' }),
    core.makeItem({ ingredientId: d.id, quantity: '1', expiry: '' }),
  ];
  assert.deepEqual(core.availableIds(profile, '2026-11-03'), new Set([a.id, d.id]));
  const recipe = { required: [a.id, b.id, c.id], optional: [d.id] };
  const status = core.recipeStatus(recipe, profile, '2026-11-03');
  assert.deepEqual(status.missing.map(entry => entry.id), [b.id, c.id]);
  assert.equal(status.availableCount, 1);
  assert.equal(status.ready, false);
  assert.equal(core.recipeStatus({ required: [a.id], optional: [b.id] }, profile, '2026-11-03').ready, true);
});

test('shopping deduplication merges recipe sources and preserves all manual fields', async () => {
  assert.equal(typeof core.addShopping, 'function');
  const { ingredients } = await import('../data.js');
  const ingredient = ingredients.find(entry => entry.aliases.length);
  const prior = core.makeItem({ name: ingredient.name, quantity: '3', unit: '봉지', price: 7.5, checked: true, recipeIds: ['first'] });
  const profile = { ...core.freshProfile('a', '가족'), shopping: [prior] };
  const before = JSON.stringify(profile);
  const result = core.addShopping(profile, [
    { name: ingredient.aliases[0], quantity: '1', price: null, recipeIds: ['second'] },
    { name: '  내 소스  ', recipeIds: ['third'] },
    { name: '내 소스', quantity: '5', recipeIds: ['fourth'] },
  ]);
  assert.equal(JSON.stringify(profile), before);
  assert.equal(result.added, 1);
  assert.equal(result.existing, 2);
  assert.equal(result.profile.shopping.length, 2);
  const kept = result.profile.shopping[0];
  assert.equal(kept.id, prior.id);
  assert.equal(kept.quantity, '3');
  assert.equal(kept.unit, '봉지');
  assert.equal(kept.price, 7.5);
  assert.equal(kept.checked, true);
  assert.deepEqual(kept.recipeIds, ['first', 'second']);
  assert.deepEqual(result.profile.shopping[1].recipeIds, ['third', 'fourth']);
});

test('state loading handles an absent key and read failure without writing', () => {
  assert.equal(typeof core.loadState, 'function');
  let reads = 0;
  const storage = { getItem(key) { reads += 1; assert.equal(key, 'saved'); return null; }, setItem() { assert.fail('loading must never write'); } };
  assert.deepEqual(core.loadState(storage, 'saved'), { state: null, blocked: false });
  assert.equal(reads, 1);
  assert.deepEqual(core.loadState({ getItem() { throw new Error('denied'); } }, 'saved'), { state: null, blocked: true });
  assert.deepEqual(core.loadState(undefined, 'saved'), { state: null, blocked: true });
});

test('state loading rejects malformed roots and nested collections as one blocked read', () => {
  assert.equal(typeof core.loadState, 'function');
  const valid = { version: 1, profiles: [{ id: 'a', name: '가족' }] };
  const cases = [
    '', '{', 'null', '[]', 'true',
    JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, profiles: [] }),
    JSON.stringify({ ...valid, profiles: {} }),
    JSON.stringify({ ...valid, profiles: [null] }),
    JSON.stringify({ ...valid, profiles: [{ id: 4, name: '가족' }] }),
    JSON.stringify({ ...valid, profiles: [{ id: 'a', name: 4 }] }),
    ...['fridge', 'shopping', 'purchases', 'recommendations'].map(key => JSON.stringify({ ...valid, profiles: [{ id: 'a', name: '가족', [key]: null }] })),
    JSON.stringify({ ...valid, profiles: [{ id: 'a', name: '가족', fridge: { name: '계란' } }] }),
    JSON.stringify({ ...valid, profiles: [{ id: 'a', name: '가족', shopping: [null] }] }),
    JSON.stringify({ ...valid, profiles: [{ id: 'a', name: '가족', purchases: [{ id: 'p', items: {} }] }] }),
    JSON.stringify({ ...valid, profiles: [{ id: 'a', name: '가족', purchases: [{ id: 'p', items: [null] }] }] }),
    JSON.stringify({ ...valid, profiles: [{ id: 'a', name: '가족', fridge: [{ name: '계란', price: '1.234' }] }] }),
  ];
  for (const raw of cases) {
    assert.deepEqual(core.loadState({ getItem() { return raw; }, setItem() { assert.fail('blocked reads must never overwrite stored data'); } }, 'saved'), { state: null, blocked: true }, raw);
  }
});

test('state loading normalizes missing defaults and preserves profiles, extras and transfer flags', () => {
  assert.equal(typeof core.loadState, 'function');
  const source = {
    version: 1, activeProfileId: 'missing', appExtra: 'keep', profiles: [
      { id: 'a', name: '첫 주방', shoppingCurrency: 'KRW', fridge: [{ id: 'egg-stock', name: '계란' }] },
      { ...shoppingProfile(), purchases: [{ id: 'p', date: '2026-11-03', title: '시장', store: '', currency: 'USD', total: 0, items: [{ ...shoppingProfile().shopping[0], transferred: true, extra: 'keep snapshot' }] }] },
    ],
  };
  source.profiles[1].id = 'b';
  const raw = JSON.stringify(source);
  const result = core.loadState({ getItem() { return raw; }, setItem() { assert.fail('normalizing must not persist automatically'); } }, 'saved');
  assert.equal(result.blocked, false);
  assert.equal(result.state.activeProfileId, 'a');
  assert.equal(result.state.appExtra, 'keep');
  assert.equal(result.state.profiles.length, 2);
  assert.equal(result.state.profiles[0].shoppingCurrency, 'KRW');
  assert.deepEqual(result.state.profiles[0].shopping, []);
  assert.deepEqual(result.state.profiles[0].purchases, []);
  assert.deepEqual(result.state.profiles[0].recommendations, {});
  assert.equal(result.state.profiles[0].fridge[0].quantity, '');
  assert.equal(result.state.profiles[0].fridge[0].ingredientId, 'egg');
  assert.equal(result.state.profiles[1].purchases[0].items[0].transferred, true);
  assert.equal(result.state.profiles[1].purchases[0].items[0].extra, 'keep snapshot');
  assert.equal(JSON.stringify(source), raw);
  const selected = { ...source, activeProfileId: 'b' };
  assert.equal(core.loadState({ getItem() { return JSON.stringify(selected); } }, 'saved').state.activeProfileId, 'b');
});

test('state loading blocks malformed purchase display fields and item metadata', () => {
  assert.equal(typeof core.loadState, 'function');
  const purchase = { id: 'p', date: '2026-11-03', title: '장보기', store: '', currency: 'USD', total: null, items: [{ id: 'item', name: '계란', transferred: false }] };
  const variants = [
    { ...purchase, id: undefined },
    { ...purchase, id: '' },
    { ...purchase, date: undefined },
    { ...purchase, date: '' },
    { ...purchase, date: '2026-1-3' },
    { ...purchase, currency: undefined },
    { ...purchase, currency: 'bad currency' },
    { ...purchase, date: 7 },
    { ...purchase, items: {} },
    { ...purchase, items: [null] },
    { ...purchase, items: [{ name: '계란', recipeIds: {} }] },
    { ...purchase, items: [{ name: '계란', transferred: 'false' }] },
  ];
  for (const value of variants) {
    const state = { version: 1, profiles: [{ id: 'a', name: '가족', purchases: [value] }] };
    assert.deepEqual(core.loadState({ getItem() { return JSON.stringify(state); } }, 'saved'), { state: null, blocked: true });
  }
});
