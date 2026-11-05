import {loadState} from './core.js';

const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(value);
const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(`${value}T00:00:00Z`))&&new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;
const checkExpiry=item=>require(item.expiry===undefined||item.expiry===null||item.expiry===''||validDate(item.expiry));
function require(condition){if(!condition)throw new Error('목록 파일의 형식을 확인해 주세요.');}
function uniqueIds(items){
  require(Array.isArray(items));
  const ids=new Set();
  for(const item of items){require(record(item)&&validId(item.id)&&!ids.has(item.id));ids.add(item.id);}
}

export function validateAccountState(input){
  require(record(input)&&input.version===1&&Array.isArray(input.profiles)&&input.profiles.length>0);
  const raw=JSON.stringify(input);
  require(new TextEncoder().encode(raw).length<=200000);
  uniqueIds(input.profiles);
  for(const profile of input.profiles){
    require(typeof profile.name==='string'&&profile.name.trim().length>0);
    for(const kind of ['fridge','shopping','purchases'])uniqueIds(profile[kind]??[]);
    for(const item of [...(profile.fridge??[]),...(profile.shopping??[])])checkExpiry(item);
    for(const purchase of profile.purchases??[]){require(validDate(purchase.date));uniqueIds(purchase.items);purchase.items.forEach(checkExpiry);}
    require(profile.sourceProfileId===undefined||validId(profile.sourceProfileId));
  }
  const loaded=loadState({getItem:()=>raw},'validation');
  require(!loaded.blocked&&loaded.state);
  return {version:1,profiles:loaded.state.profiles};
}

export function importProfile(state,profile,sourceId){
  require(validId(sourceId));
  const next=state===null?{version:1,profiles:[]}:validateAccountState(state);
  if(next.profiles.some(p=>p.sourceProfileId===sourceId))return next;
  const incoming=validateAccountState({version:1,profiles:[profile]}).profiles[0];
  incoming.id=crypto.randomUUID();
  incoming.sourceProfileId=sourceId;
  next.profiles.push(incoming);
  return validateAccountState(next);
}

export function readProfileExport(text){
  require(typeof text==='string'&&new TextEncoder().encode(text).length<=2000000);
  let value;
  try{value=JSON.parse(text);}catch{throw new Error('읽을 수 있는 목록 파일을 선택해 주세요.');}
  require(record(value)&&value.format==='fridge-grocery-profile'&&value.version===1);
  return validateAccountState({version:1,profiles:[value.profile]}).profiles[0];
}

export function accountCacheKey(userId){
  require(validId(userId));
  return `fridge-grocery:account:${encodeURIComponent(userId)}`;
}
