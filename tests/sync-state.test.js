import test from 'node:test';
import assert from 'node:assert/strict';
import {freshProfile, makeItem, savePurchase} from '../core.js';
import {validateAccountState, importProfile, readProfileExport, accountCacheKey} from '../sync-state.js';

const sample = () => ({version:1,profiles:[freshProfile('kitchen-1','우리 주방')]});

test('account documents validate and preserve historical purchase registration and prices', () => {
  const input=sample();
  input.profiles[0].shopping.push(makeItem({id:'milk',name:'우유',quantity:'2',price:6,checked:true}));
  input.profiles[0]=savePurchase(input.profiles[0],{transfer:true,total:6,currency:'USD'});
  const result=validateAccountState(input);
  assert.equal(result.profiles[0].purchases[0].items[0].transferred,true);
  assert.equal(result.profiles[0].purchases[0].total,6);
  assert.equal(result.profiles[0].fridge[0].quantity,'2');
  assert.equal(result.activeProfileId,undefined);
  result.profiles[0].fridge[0].name='변경';
  assert.equal(input.profiles[0].fridge[0].name,'우유');
});

test('invalid account shapes, missing IDs, duplicate IDs and malformed money are rejected', () => {
  for(const bad of [null,{}, {version:2,profiles:[]}, {version:1,profiles:[]}]) assert.throws(()=>validateAccountState(bad));
  const missing=sample(); missing.profiles[0].fridge=[{name:'우유'}];
  assert.throws(()=>validateAccountState(missing));
  const duplicate=sample(); duplicate.profiles.push({...duplicate.profiles[0]});
  assert.throws(()=>validateAccountState(duplicate));
  const money=sample(); money.profiles[0].shopping=[{id:'x',name:'우유',price:-3}];
  assert.throws(()=>validateAccountState(money));
  const tooBig=sample(); tooBig.profiles[0].name='x'.repeat(250001);
  assert.throws(()=>validateAccountState(tooBig));
});

test('import adds a separate kitchen without changing local records and is idempotent', () => {
  const original=sample();
  const local=freshProfile('local-profile','KM');
  local.fridge.push(makeItem({id:'milk',name:'우유',price:0}));
  const result=importProfile(original,local,'local-profile');
  assert.equal(result.profiles.length,2);
  assert.equal(original.profiles.length,1);
  assert.equal(local.id,'local-profile');
  assert.equal(result.profiles[1].fridge[0].price,0);
  assert.equal(result.profiles[1].sourceProfileId,'local-profile');
  const again=importProfile(result,local,'local-profile');
  assert.equal(again.profiles.length,2);
  assert.deepEqual(again,result);
});

test('the first import creates one kitchen rather than retaining a placeholder kitchen',()=>{
  const result=importProfile(null,freshProfile('local','KM'),'local');
  assert.equal(result.profiles.length,1);
  assert.equal(result.profiles[0].name,'KM');
  assert.equal(result.profiles[0].sourceProfileId,'local');
});

test('export parsing accepts current profile exports and rejects foreign or corrupt files', () => {
  const profile=freshProfile('old','나');
  assert.equal(readProfileExport(JSON.stringify({format:'fridge-grocery-profile',version:1,profile})).id,'old');
  for(const text of ['not-json','{}',JSON.stringify({format:'other',version:1,profile})]) assert.throws(()=>readProfileExport(text));
});

test('account caches never share the existing local key or another account key', () => {
  assert.notEqual(accountCacheKey('alice'),accountCacheKey('bob'));
  assert.notEqual(accountCacheKey('alice'),'fridge-grocery:v1:state');
  assert.throws(()=>accountCacheKey(''));
});

test('hostile IDs and expiry markup are rejected before account imports can reach HTML templates',()=>{
  for(const value of [{id:'x" onclick="alert(1)',expiry:''},{id:'safe',expiry:'<img src=x onerror=alert(2)>-01-01'},{id:'safe',expiry:'2026-02-30'}]){
    const profile=freshProfile('local','KM');profile.fridge=[makeItem({name:'우유',...value})];
    assert.throws(()=>readProfileExport(JSON.stringify({format:'fridge-grocery-profile',version:1,profile})));
  }
});

test('large pretty-printed exports round trip when the compact document is within its limit',()=>{
  const profile=freshProfile('stock','많은 재료');
  profile.fridge=Array.from({length:700},(_,i)=>makeItem({id:`row-${i}`,name:'우유'}));
  validateAccountState({version:1,profiles:[profile]});
  const exported=JSON.stringify({format:'fridge-grocery-profile',version:1,profile},null,2);
  assert.ok(new TextEncoder().encode(exported).length>200000);
  assert.equal(readProfileExport(exported).fridge.length,700);
});
