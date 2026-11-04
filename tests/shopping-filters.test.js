import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../core.js';

const groceries = [
  { id: 'egg', ingredientId: 'egg', name: '달걀', category: '달걀/유제품', checked: false, recipeIds: ['breakfast'] },
  { id: 'milk', ingredientId: 'milk', name: '우유', category: '달걀/유제품', checked: true, recipeIds: ['breakfast'] },
  { id: 'onion', ingredientId: 'onion', name: '양파', category: '채소', checked: false, recipeIds: ['soup'] },
  { id: 'custom', ingredientId: null, name: '우리집 Café 소스 🌶️', category: '기타', checked: false, recipeIds: [] },
];
const recipes = [
  { id: 'breakfast', name: '아침 Toast' },
  { id: 'soup', name: '양파 수프' },
];
const ids = items => items.map(item => item.id);

test('shopping filters show all items by default and handle an empty list', () => {
  assert.equal(typeof core.filterShopping, 'function');
  assert.deepEqual(ids(core.filterShopping(groceries)), ['egg', 'milk', 'onion', 'custom']);
  assert.deepEqual(ids(core.filterShopping(groceries, { search: '   ', category: '전체', status: '전체' })), ['egg', 'milk', 'onion', 'custom']);
  assert.deepEqual(core.filterShopping([]), []);
});

test('search, exact category and purchase status all restrict the same results', () => {
  assert.equal(typeof core.filterShopping, 'function');
  assert.deepEqual(ids(core.filterShopping(groceries, { search: '아침', category: '달걀/유제품', status: '미구매' }, recipes)), ['egg']);
  assert.deepEqual(ids(core.filterShopping(groceries, { search: '아침', category: '달걀/유제품', status: '구매 완료' }, recipes)), ['milk']);
  assert.deepEqual(core.filterShopping(groceries, { search: '우유', category: '채소', status: '구매 완료' }), []);
  assert.deepEqual(core.filterShopping(groceries, { category: '달걀' }), []);
});

test('only a literal true checked flag counts as purchased', () => {
  assert.equal(typeof core.filterShopping, 'function');
  const items = [
    { id: 'yes', name: '첫째', checked: true },
    { id: 'no', name: '둘째', checked: false },
    { id: 'missing', name: '셋째' },
    { id: 'truthy', name: '넷째', checked: 1 },
  ];
  assert.deepEqual(ids(core.filterShopping(items, { status: '구매 완료' })), ['yes']);
  assert.deepEqual(ids(core.filterShopping(items, { status: '미구매' })), ['no', 'missing', 'truthy']);
});

test('search finds canonical ingredient names and aliases from ingredient IDs', () => {
  assert.equal(typeof core.filterShopping, 'function');
  const items = [{ id: 'farm', ingredientId: 'egg', name: '농장 특란', category: '달걀/유제품' }];
  assert.deepEqual(ids(core.filterShopping(items, { search: ' 계란 ' })), ['farm']);
  assert.deepEqual(ids(core.filterShopping(items, { search: '달걀' })), ['farm']);
  assert.deepEqual(ids(core.filterShopping(items, { search: '특란' })), ['farm']);
});

test('exact canonical or alias names resolve ingredients when their ID is absent or unknown', () => {
  assert.equal(typeof core.filterShopping, 'function');
  const items = [
    { id: 'canonical', name: ' 달걀 ' },
    { id: 'alias', ingredientId: 'unknown', name: ' 계란 ' },
    { id: 'partial', name: '계란빵' },
  ];
  assert.deepEqual(ids(core.filterShopping(items, { search: '달걀류' })), ['canonical', 'alias']);
  assert.deepEqual(ids(core.filterShopping(items, { search: '계란빵' })), ['partial']);
});

test('search normalizes case and surrounding whitespace without losing Unicode text', () => {
  assert.equal(typeof core.filterShopping, 'function');
  assert.deepEqual(ids(core.filterShopping(groceries, { search: '  CAFÉ  ' })), ['custom']);
  assert.deepEqual(ids(core.filterShopping(groceries, { search: '🌶️' })), ['custom']);
  assert.deepEqual(core.filterShopping(groceries, { search: '없는 이름' }), []);
});

test('recipe search matches only names of linked catalog recipes and ignores missing links', () => {
  assert.equal(typeof core.filterShopping, 'function');
  const items = [
    { id: 'linked', name: '특제 재료', recipeIds: ['missing', 'breakfast'] },
    { id: 'unlinked', name: '다른 재료', recipeIds: ['soup'] },
    { id: 'none', name: '별도 재료' },
  ];
  assert.deepEqual(ids(core.filterShopping(items, { search: ' TOAST ' }, recipes)), ['linked']);
  assert.deepEqual(ids(core.filterShopping(items, { search: '수프' }, recipes)), ['unlinked']);
  assert.deepEqual(core.filterShopping(items, { search: 'Toast' }), []);
  assert.deepEqual(core.filterShopping(items, { search: 'breakfast' }, recipes), []);
});

test('filtering preserves source order, original item references and all saved fields', () => {
  assert.equal(typeof core.filterShopping, 'function');
  const items = [
    { id: 'z', name: '맞춤 소스 Z', category: '기타', checked: true, price: 0, quantity: '3', recipeIds: ['breakfast'], extra: { saved: true } },
    { id: 'a', name: '맞춤 소스 A', category: '기타', checked: true, price: null, quantity: '', recipeIds: [] },
    { id: 'hidden', name: '별도 재료', category: '기타', checked: false, recipeIds: [] },
  ];
  const before = structuredClone(items);
  for (const item of items) {
    Object.freeze(item.recipeIds);
    if (item.extra) Object.freeze(item.extra);
    Object.freeze(item);
  }
  Object.freeze(items);
  const catalog = Object.freeze(recipes.map(recipe => Object.freeze({ ...recipe })));
  const filters = Object.freeze({ search: '소스', category: '기타', status: '구매 완료' });
  const result = core.filterShopping(items, filters, catalog);
  assert.deepEqual(ids(result), ['z', 'a']);
  assert.equal(result[0], items[0]);
  assert.equal(result[1], items[1]);
  assert.deepEqual(items, before);
});
