import {loadState} from './core.js';

const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const validId=value=>typeof value==='string'&&value.trim().length>0&&value.length<=200;
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
    for(const purchase of profile.purchases??[])uniqueIds(purchase.items);
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
  require(typeof text==='string'&&text.length<=200000);
  let value;
  try{value=JSON.parse(text);}catch{throw new Error('읽을 수 있는 목록 파일을 선택해 주세요.');}
  require(record(value)&&value.format==='fridge-grocery-profile'&&value.version===1);
  return validateAccountState({version:1,profiles:[value.profile]}).profiles[0];
}

export function accountCacheKey(userId){
  require(validId(userId));
  return `fridge-grocery:account:${encodeURIComponent(userId)}`;
}
