import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

test('database enforces ownership, atomic versions and replay safety for real SQL roles',async()=>{
  const db=new PGlite();
  try{
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;
      create table auth.users(id uuid primary key);
      insert into auth.users values ('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002');
      create publication supabase_realtime;`);
    await db.exec(await readFile(new URL('../supabase/schema.sql',import.meta.url),'utf8'));
    const alice='00000000-0000-0000-0000-000000000001',bob='00000000-0000-0000-0000-000000000002';
    const first={version:1,profiles:[{id:'a',name:'A',fridge:[],shopping:[],purchases:[],recommendations:{}}]};
    let caller=alice;
    const save=async(state,revision,mutation)=>db.query('select public.save_fridge_state($1::jsonb,$2::bigint,$3::uuid,$4::uuid) as result',[JSON.stringify(state),revision,mutation,caller]);
    await db.exec(`set role authenticated; set request.jwt.claim.sub='${alice}';`);
    const mutation='10000000-0000-0000-0000-000000000001';
    const saved=(await save(first,0,mutation)).rows[0].result;assert.equal(saved.revision,1);assert.equal(saved.user_id,alice);
    assert.equal((await save(first,0,mutation)).rows[0].result.revision,1);
    await assert.rejects(()=>save(first,0,'10000000-0000-0000-0000-000000000002'),/VERSION_CONFLICT/);
    await assert.rejects(()=>db.query('update public.fridge_accounts set state=$1',[first]),/permission denied/);
    await assert.rejects(()=>db.query('insert into public.fridge_accounts(user_id,state) values($1,$2)',[bob,first]),/permission denied/);
    await assert.rejects(()=>db.query('delete from public.fridge_accounts'),/permission denied/);
    await db.exec(`set request.jwt.claim.sub='${bob}';`);
    caller=bob;
    assert.equal((await db.query('select * from public.fridge_accounts')).rows.length,0);
    assert.equal((await save(first,0,'10000000-0000-0000-0000-000000000003')).rows[0].result.user_id,bob);
    await assert.rejects(()=>db.query('select public.save_fridge_state(p_state=>$1::jsonb,p_expected_revision=>1,p_mutation_id=>$2::uuid,p_expected_user_id=>$3::uuid)',[JSON.stringify(first),'10000000-0000-0000-0000-000000000099',alice]),/SESSION_CHANGED/);
    assert.equal((await db.query('select * from public.fridge_accounts where user_id=$1',[alice])).rows.length,0);
    await assert.rejects(()=>save({version:1,profiles:[]},1,'10000000-0000-0000-0000-000000000004'),/INVALID_STATE/);
    await db.exec('reset role; set role anon;');
    await assert.rejects(()=>db.query('select * from public.fridge_accounts'),/permission denied/);
    await assert.rejects(()=>save(first,0,'10000000-0000-0000-0000-000000000005'),/permission denied/);
    await db.exec('reset role;');
    assert.equal((await db.query('select * from public.fridge_accounts')).rows.length,2);
  }finally{await db.close();}
});
