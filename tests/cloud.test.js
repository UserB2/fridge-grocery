import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudStore, createAccountClient} from '../cloud.js';
import {freshProfile} from '../core.js';

const state=name=>({version:1,profiles:[freshProfile('kitchen',name)]});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function service(){
  const rows=new Map();
  let readGate=null,loseResponse=false,offline=false;
  return {rows,setReadGate(value){readGate=value;},loseNextResponse(){loseResponse=true;},setOffline(value){offline=value;},client(userId){return {
    from(table){assert.equal(table,'fridge_accounts');return {select(){return this;},eq(key,value){assert.equal(key,'user_id');assert.equal(value,userId);return this;},async maybeSingle(){if(readGate)await readGate.promise;if(offline)throw new Error('network');return {data:structuredClone(rows.get(userId)??null),error:null};}};},
    async rpc(name,args){assert.equal(name,'save_fridge_state');if(offline)throw new Error('network');const row=rows.get(userId);
      if(row?.mutation_id===args.p_mutation_id)return {data:structuredClone(row),error:null};
      if((row?.revision??0)!==args.p_expected_revision)return {data:null,error:{code:'P0001',message:'VERSION_CONFLICT'}};
      const next={user_id:userId,state:structuredClone(args.p_state),revision:(row?.revision??0)+1,mutation_id:args.p_mutation_id};rows.set(userId,next);
      if(loseResponse){loseResponse=false;throw new Error('lost response');}return {data:structuredClone(next),error:null};
    }
  };}};
}

test('unconfigured login remains local and never loads an external SDK',async()=>{
  assert.equal(await createAccountClient({url:'',publishableKey:''}),null);
});

test('two devices reject stale updates instead of losing an accepted change',async()=>{
  const backend=service();const a=createCloudStore(backend.client('alice')),b=createCloudStore(backend.client('alice'));
  await a.connect({id:'alice'});await b.connect({id:'alice'});
  await a.save(state('first'));
  await assert.rejects(()=>b.save(state('stale')),error=>error.code==='CONFLICT');
  assert.equal(backend.rows.get('alice').state.profiles[0].name,'first');
  const latest=await b.read();assert.equal(latest.state.profiles[0].name,'first');
  await b.save(state('second'));assert.equal(backend.rows.get('alice').revision,2);
});

test('lost response is reconciled using the saved mutation and never duplicated',async()=>{
  const backend=service();const store=createCloudStore(backend.client('alice'));
  await store.connect({id:'alice'});backend.loseNextResponse();
  const result=await store.save(state('saved'));
  assert.equal(result.revision,1);assert.equal(backend.rows.get('alice').revision,1);
});

test('an incoming update does not authorize a draft based on an older displayed revision',async()=>{
  const backend=service();const a=createCloudStore(backend.client('alice')),b=createCloudStore(backend.client('alice'));
  await a.connect({id:'alice'});await a.save(state('initial'));await b.connect({id:'alice'});
  await a.save(state('remote changed'));await b.read();
  await assert.rejects(()=>b.save(state('older draft'),{expectedRevision:1}),error=>error.code==='CONFLICT');
  assert.equal(backend.rows.get('alice').state.profiles[0].name,'remote changed');
});

test('failed connection blocks writes and retains the last accepted cache',async()=>{
  const backend=service();const values=new Map();const storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
  const store=createCloudStore(backend.client('alice'),{storage});await store.connect({id:'alice'});await store.save(state('safe'));
  backend.setOffline(true);
  await assert.rejects(()=>store.save(state('not saved')));
  assert.equal(store.snapshot().state.profiles[0].name,'safe');
  await assert.rejects(()=>store.save(state('also not saved')));
  backend.setOffline(false);await store.read();await store.save(state('reconnected'));
  assert.equal(store.snapshot().state.profiles[0].name,'reconnected');
});

test('disconnect invalidates delayed reads and clears only the old account cache',async()=>{
  const backend=service();const values=new Map([['fridge-grocery:v1:state','original']]);
  const storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
  const changes=[];const store=createCloudStore(backend.client('alice'),{storage,onChange:v=>changes.push(v)});
  await store.connect({id:'alice'});await store.save(state('private'));
  const count=changes.length;const gate=deferred();backend.setReadGate(gate);
  const pending=store.read();store.disconnect();gate.resolve();
  await assert.rejects(()=>pending,error=>error.code==='SESSION_CHANGED');
  assert.equal(store.snapshot(),null);assert.equal(changes.length,count);
  assert.equal(values.size,1);assert.equal(values.get('fridge-grocery:v1:state'),'original');
});

test('cached documents are account-specific and do not turn an offline session into editable data',async()=>{
  const backend=service();const values=new Map();const storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
  const a=createCloudStore(backend.client('alice'),{storage});await a.connect({id:'alice'});await a.save(state('alice only'));
  backend.setOffline(true);
  const b=createCloudStore(backend.client('bob'),{storage});await assert.rejects(()=>b.connect({id:'bob'}));assert.equal(b.snapshot(),null);
  const again=createCloudStore(backend.client('alice'),{storage});const cached=await again.connect({id:'alice'});
  assert.equal(cached.state.profiles[0].name,'alice only');await assert.rejects(()=>again.save(state('offline edit')));
});
