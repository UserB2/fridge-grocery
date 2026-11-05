import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Window} from 'happy-dom';
import {freshProfile,makeItem} from '../core.js';

const tick=async()=>{for(let i=0;i<10;i++)await new Promise(resolve=>setImmediate(resolve));};
async function waitFor(check){for(let i=0;i<40;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.ok(check(),'expected UI state did not appear');}
async function page(localProfile=freshProfile('local','기존 주방')){
  const window=new Window({url:'https://example.com/fridge/'});
  window.document.write(await readFile(new URL('../index.html',import.meta.url),'utf8'));
  const local={version:1,activeProfileId:localProfile.id,profiles:[localProfile]};
  window.localStorage.setItem('fridge-grocery:v1:state',JSON.stringify(local));
  const prior={};for(const key of ['window','document','location','FormData']){prior[key]=globalThis[key];globalThis[key]=window[key];}
  const app=await import(`../app.js?test=${crypto.randomUUID()}`);await tick();
  const cleanups=[];
  return {window,document:window.document,app,cleanups,async close(){for(const cleanup of cleanups)await cleanup?.();await window.happyDOM.close();for(const key of Object.keys(prior))globalThis[key]=prior[key];}};
}
function backend(){
  let listener=()=>{},realtime=()=>{},fail=false;
  const profile=freshProfile('cloud','계정 주방');profile.shopping.push(makeItem({id:'milk',name:'우유',price:6,checked:true}));
  let row={user_id:'alice',state:{version:1,profiles:[profile]},revision:1,mutation_id:crypto.randomUUID()};
  const client={
    auth:{async getSession(){return {data:{session:{user:{id:'alice',email:'alice@example.com'}}},error:null};},onAuthStateChange(fn){listener=fn;return {data:{subscription:{unsubscribe(){}}}};},async signOut(){listener('SIGNED_OUT',null);return {error:null};},async signInWithOAuth(){return {data:{},error:null};}},
    from(){return {select(){return this;},eq(){return this;},async maybeSingle(){return {data:structuredClone(row),error:null};}};},
    async rpc(name,args){if(fail)throw new Error('offline');if(args.p_expected_revision!==row.revision)return {data:null,error:{message:'VERSION_CONFLICT'}};row={...row,state:args.p_state,revision:row.revision+1,mutation_id:args.p_mutation_id};return {data:structuredClone(row),error:null};},
    channel(){return {on(event,filter,fn){realtime=fn;return this;},subscribe(){return this;}};},async removeChannel(){}
  };
  return {client,setFailure(){fail=true;},update(){row={...row,revision:row.revision+1};realtime({});},row:()=>row};
}

test('local users retain their records and see Google login availability in the profile dialog',async()=>{
  const p=await page();try{
    p.document.querySelector('[data-action="profiles"]').click();
    assert.match(p.document.querySelector('#modal').textContent,/Google로 로그인/);
    assert.match(p.document.querySelector('#profile-button').textContent,/기존 주방/);
    assert.ok(p.document.querySelector('[data-action="export-profile"]'));
  }finally{await p.close();}
});

test('email signup uses a separate identity and switches to the synced account',async()=>{
  const p=await page();try{
    const b=backend();
    const user={id:'alice',email:'placeholder@password.fridge.invalid',user_metadata:{fridge_login_email:'alice@example.com'}};
    let onSession,credentials;
    Object.assign(b.client.auth,{
      async getSession(){return {data:{session:null}};},
      onAuthStateChange(fn){onSession=fn;return {data:{subscription:{unsubscribe(){}}}};},
      async signUp(params){credentials=params;onSession('SIGNED_IN',{user});return {data:{session:{user}},error:null};}
    });
    p.cleanups.push(await p.app.initializeAccounts(async()=>b.client));
    p.document.querySelector('[data-action="profiles"]').click();
    p.document.querySelector('[data-action="email-signup"]').click();
    const form=p.document.querySelector('#email-auth-form');
    form.elements.login.value='Alice@Example.com';
    form.elements.password.value='a-test-password';
    form.elements.confirmPassword.value='mismatched-password';
    const submit=()=>form.dispatchEvent(new p.window.Event('submit',{bubbles:true,cancelable:true}));
    submit();await tick();
    assert.equal(credentials,undefined);
    assert.match(form.querySelector('[role="alert"]').textContent,/일치/);
    form.elements.confirmPassword.value=form.elements.password.value;
    submit();
    await waitFor(()=>p.document.querySelector('#profile-button').textContent.includes('계정 주방'));
    assert.match(credentials.email,/^[a-f0-9]{64}@password\.fridge\.invalid$/);
    assert.equal(credentials.options.data.fridge_login_email,'alice@example.com');
    assert.equal(p.document.querySelector('#modal').open,false);
    assert.match(p.document.querySelector('#account-status').textContent,/alice@example.com/);
  }finally{await p.close();}
});

test('a username signs in using its case-insensitive identifier',async()=>{
  const p=await page();try{
    const b=backend();
    let credentials;
    Object.assign(b.client.auth,{
      async getSession(){return {data:{session:null}};},
      async signInWithPassword(params){credentials=params;return {data:{session:null},error:{code:'invalid_credentials'}};}
    });
    p.cleanups.push(await p.app.initializeAccounts(async()=>b.client));
    p.document.querySelector('[data-action="profiles"]').click();
    p.document.querySelector('[data-action="email-login"]').click();
    const form=p.document.querySelector('#email-auth-form');
    form.elements.login.value='Union';
    form.elements.password.value='a-test-password';
    form.dispatchEvent(new p.window.Event('submit',{bubbles:true,cancelable:true}));
    await waitFor(()=>credentials);
    const expected=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('union'))).toString('hex');
    assert.equal(credentials.email,expected+'@password.fridge.invalid');
    assert.match(form.querySelector('[role="alert"]').textContent,/아이디 또는 이메일/);
  }finally{await p.close();}
});

test('account login switches state while logout restores the untouched local profile',async()=>{
  const p=await page();try{
    assert.equal(typeof p.app.initializeAccounts,'function');
    const b=backend();p.cleanups.push(await p.app.initializeAccounts(async()=>b.client));await tick();
    assert.match(p.document.querySelector('#profile-button').textContent,/계정 주방/);
    assert.equal(JSON.parse(p.window.localStorage.getItem('fridge-grocery:v1:state')).profiles[0].name,'기존 주방');
    p.document.querySelector('[data-action="profiles"]').click();
    p.document.querySelector('[data-action="logout"]').click();await tick();
    await waitFor(()=>p.document.querySelector('#profile-button').textContent.includes('기존 주방'));
    assert.match(p.document.querySelector('#profile-button').textContent,/기존 주방/);
    assert.doesNotMatch(p.document.querySelector('#main-content').textContent,/alice@example.com/);
  }finally{await p.close();}
});

test('a failed cloud price save leaves the entered value visible and the stored amount unchanged',async()=>{
  const p=await page();try{
    assert.equal(typeof p.app.initializeAccounts,'function');
    const b=backend();p.cleanups.push(await p.app.initializeAccounts(async()=>b.client));await tick();
    p.document.querySelector('[data-action="navigate"][data-view="shopping"]').click();
    b.setFailure();const input=p.document.querySelector('[data-price-id="milk"]');input.value='8';
    input.dispatchEvent(new p.window.Event('input',{bubbles:true}));input.dispatchEvent(new p.window.Event('change',{bubbles:true}));await tick();
    assert.equal(p.document.querySelector('[data-price-id="milk"]').value,'8');
    assert.equal(b.row().state.profiles[0].shopping[0].price,6);
    assert.match(p.document.querySelector('#toast').textContent,/확인|유지/);
  }finally{await p.close();}
});

test('remote change while editing keeps the form draft and rejects stale save',async()=>{
  const p=await page();try{
    assert.equal(typeof p.app.initializeAccounts,'function');
    const b=backend();p.cleanups.push(await p.app.initializeAccounts(async()=>b.client));await tick();
    p.document.querySelector('[data-action="navigate"][data-view="shopping"]').click();
    p.document.querySelector('[data-action="edit-item"][data-id="milk"]').click();
    const form=p.document.querySelector('#item-form');form.elements.name.value='작성 중인 이름';b.update();await tick();
    assert.equal(form.elements.name.value,'작성 중인 이름');
    form.dispatchEvent(new p.window.Event('submit',{bubbles:true,cancelable:true}));await tick();
    assert.equal(p.document.querySelector('#modal').open,true);
    assert.equal(form.elements.name.value,'작성 중인 이름');
    assert.equal(b.row().state.profiles[0].shopping[0].name,'우유');
  }finally{await p.close();}
});

test('legacy local ID and expiry values render as text without injecting event handlers',async()=>{
  const local=freshProfile('local','기존 주방');
  local.fridge.push(makeItem({id:'x" onclick="alert(1)',name:'우유',expiry:'<img src=x onerror=alert(2)>-01-01'}));
  const p=await page(local);try{
    p.document.querySelector('[data-action="navigate"][data-view="fridge"]').click();
    assert.equal(p.document.querySelectorAll('#main-content [onclick],#main-content [onerror],#main-content img').length,0);
    assert.match(p.document.querySelector('#main-content').textContent,/<img src=x/);
  }finally{await p.close();}
});
