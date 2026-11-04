import { ingredients } from './data.js';

export function normalizeName(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function findIngredient(name) {
  const normalized = normalizeName(name);
  return ingredients.find(ingredient => [ingredient.name, ...ingredient.aliases].some(alias => normalizeName(alias) === normalized)) || null;
}

export function makeItem(input = {}) {
  const canonical = ingredients.find(ingredient => ingredient.id === input.ingredientId) || findIngredient(input.name);
  return {
    id: input.id || uniqueId(),
    ingredientId: canonical?.id || null,
    name: canonical?.name || String(input.name || '').trim(),
    category: input.category || canonical?.category || '기타',
    quantity: input.quantity === null || input.quantity === undefined ? '' : String(input.quantity),
    unit: String(input.unit || ''),
    location: input.location || '냉장',
    expiry: input.expiry || '',
    price: parseMoney(input.price),
    checked: input.checked === true,
    recipeIds: [...new Set(Array.isArray(input.recipeIds) ? input.recipeIds : [])],
  };
}

export function availableIds(profile, today = localToday()) {
  const available = new Set();
  for (const item of profile.fridge) {
    const ingredient = ingredients.find(entry => entry.id === item.ingredientId) || findIngredient(item.name);
    const quantity = String(item.quantity ?? '').trim();
    if (!ingredient || (quantity !== '' && Number(quantity) <= 0) || (item.expiry && item.expiry < today)) continue;
    available.add(ingredient.id);
  }
  return available;
}

export function recipeStatus(recipe, profile, today) {
  const available = availableIds(profile, today);
  const required = [...new Set(recipe.required)];
  const missing = required.filter(id => !available.has(id)).map(id => ingredients.find(ingredient => ingredient.id === id));
  return { missing, availableCount: required.length - missing.length, ready: missing.length === 0 };
}

export function addShopping(profile, inputs) {
  const next = structuredClone(profile);
  let added = 0;
  let existing = 0;
  const identity = item => item.ingredientId ? `ingredient:${item.ingredientId}` : `custom:${normalizeName(item.name)}`;
  for (const input of inputs) {
    const candidate = makeItem(input);
    const prior = next.shopping.find(item => identity(item) === identity(candidate));
    if (prior) {
      prior.recipeIds = [...new Set([...(prior.recipeIds || []), ...candidate.recipeIds])];
      existing += 1;
    } else {
      next.shopping.push(candidate);
      added += 1;
    }
  }
  return { profile: next, added, existing };
}

export function parseMoney(value) {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return null;
  const raw = typeof value === 'string' ? value.trim() : String(value);
  if (!['string', 'number'].includes(typeof value) || !/^\d+(?:\.\d{1,2})?$/.test(raw)) {
    throw new Error('금액은 0 이상의 숫자로 소수점 두 자리까지 입력해 주세요.');
  }
  const amount = Number(raw);
  if (!Number.isFinite(amount) || !Number.isSafeInteger(Math.round(amount * 100))) {
    throw new Error('입력 가능한 금액 범위를 초과했습니다.');
  }
  return amount;
}

export function freshProfile(id, name) {
  return { id, name, fridge: [], shopping: [], purchases: [], recommendations: {} };
}

export function purchaseSummary(purchase) {
  let cents = 0;
  let priced = 0;
  for (const item of purchase.items) {
    const price = parseMoney(item.price);
    if (price !== null) {
      cents += Math.round(price * 100);
      priced += 1;
    }
  }
  const total = parseMoney(purchase.total);
  return {
    subtotal: cents / 100,
    priced,
    count: purchase.items.length,
    difference: total === null ? null : (Math.round(total * 100) - cents) / 100,
  };
}

export function persistState(storage, key, state) {
  storage.setItem(key, JSON.stringify(state));
  return state;
}

export function loadState(storage, key) {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return { state: null, blocked: false };
    const state = JSON.parse(raw);
    const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const require = condition => { if (!condition) throw new Error('저장 형식을 읽을 수 없어요.'); };
    require(record(state) && state.version === 1 && Array.isArray(state.profiles) && state.profiles.length > 0);
    const item = value => {
      require(record(value));
      require(typeof value.name === 'string' || ingredients.some(ingredient => ingredient.id === value.ingredientId));
      require(value.recipeIds === undefined || (Array.isArray(value.recipeIds) && value.recipeIds.every(id => typeof id === 'string')));
      require(value.transferred === undefined || typeof value.transferred === 'boolean');
      return { ...value, ...makeItem(value) };
    };
    const profiles = state.profiles.map(profile => {
      require(record(profile) && typeof profile.id === 'string' && typeof profile.name === 'string');
      for (const collection of ['fridge', 'shopping', 'purchases']) {
        require(profile[collection] === undefined || Array.isArray(profile[collection]));
      }
      require(profile.recommendations === undefined || record(profile.recommendations));
      const purchases = (profile.purchases ?? []).map(purchase => {
        require(record(purchase) && Array.isArray(purchase.items));
        require(typeof purchase.id === 'string' && purchase.id.trim().length > 0);
        require(typeof purchase.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(purchase.date));
        require(['USD', 'KRW'].includes(purchase.currency));
        for (const field of ['title', 'store']) require(purchase[field] === undefined || typeof purchase[field] === 'string');
        return { ...purchase, total: parseMoney(purchase.total), items: purchase.items.map(item) };
      });
      return {
        ...profile,
        fridge: (profile.fridge ?? []).map(item),
        shopping: (profile.shopping ?? []).map(item),
        purchases,
        recommendations: profile.recommendations ?? {},
      };
    });
    const activeProfileId = profiles.some(profile => profile.id === state.activeProfileId) ? state.activeProfileId : profiles[0].id;
    return { state: { ...state, profiles, activeProfileId }, blocked: false };
  } catch {
    return { state: null, blocked: true };
  }
}

function uniqueId() {
  return globalThis.crypto.randomUUID();
}

function localToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function savePurchase(profile, details = {}) {
  const checked = profile.shopping.filter(item => item.checked);
  if (!checked.length) throw new Error('구매한 항목을 먼저 선택해 주세요.');
  const currency = details.currency || 'USD';
  if (!['USD', 'KRW'].includes(currency)) throw new Error('통화는 USD 또는 KRW를 선택해 주세요.');
  const purchase = {
    id: uniqueId(),
    date: details.date || localToday(),
    title: String(details.title || '장보기').trim() || '장보기',
    store: String(details.store || '').trim(),
    currency,
    total: parseMoney(details.total),
    items: checked.map(item => ({ ...structuredClone(item), price: parseMoney(item.price), transferred: false })),
  };
  let next = structuredClone(profile);
  next.shopping = next.shopping.filter(item => !item.checked);
  next.purchases.unshift(purchase);
  if (details.transfer) next = transferPurchase(next, purchase.id, purchase.items.map(item => item.id));
  return next;
}

export function transferPurchase(profile, purchaseId, itemIds = []) {
  const next = structuredClone(profile);
  const purchase = next.purchases.find(entry => entry.id === purchaseId);
  if (!purchase) return next;
  const selected = new Set(itemIds);
  for (const snapshot of purchase.items) {
    if (!selected.has(snapshot.id) || snapshot.transferred) continue;
    const { transferred, ...item } = structuredClone(snapshot);
    next.fridge.push({ ...item, id: uniqueId(), checked: false });
    snapshot.transferred = true;
  }
  return next;
}
