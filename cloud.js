import {validateAccountState,accountCacheKey} from './sync-state.js';

const failure=(code,message)=>Object.assign(new Error(message),{code});
export async function createAccountClient(config){
  if(!config?.url||!config?.publishableKey)return null;
  if(!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(config.url))throw new Error('계정 연결 주소를 확인해 주세요.');
  const {createClient}=await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/+esm');
  return createClient(config.url,config.publishableKey,{auth:{flowType:'pkce',persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
}

export function createCloudStore(client,{storage,onChange=()=>{},onStatus=()=>{}}={}){
  let user=null,current=null,epoch=0,busy=false,blocked=true;
  const status=value=>onStatus(value);
  function check(token){if(token!==epoch||!user)throw failure('SESSION_CHANGED','로그인 계정이 변경되었어요.');}
  function parse(row){
    if(row===null)return {state:null,revision:0,mutationId:null};
    if(row.user_id!==user.id||!Number.isSafeInteger(row.revision)||row.revision<1)throw failure('INVALID_DATA','계정 기록을 읽지 못했어요.');
    return {state:validateAccountState(row.state),revision:row.revision,mutationId:row.mutation_id};
  }
  async function fetchRow(token){
    const result=await client.from('fridge_accounts').select('user_id,state,revision,mutation_id').eq('user_id',user.id).maybeSingle();
    check(token);if(result.error)throw result.error;return parse(result.data);
  }
  function accept(snapshot){
    current=structuredClone(snapshot);blocked=false;
    try{storage?.setItem(accountCacheKey(user.id),JSON.stringify({user_id:user.id,...snapshot}));}catch{}
    status('synced');onChange(structuredClone(current));return structuredClone(current);
  }
  return {
    snapshot(){return current&&structuredClone(current);},
    async connect(nextUser){
      this.disconnect();user={id:nextUser.id};const token=epoch;status('loading');
      try{return accept(await fetchRow(token));}catch(error){
        check(token);blocked=true;status('offline');
        try{
          const cached=JSON.parse(storage?.getItem(accountCacheKey(user.id))??'null');
          if(cached?.user_id===user.id&&cached.state&&Number.isSafeInteger(cached.revision)&&cached.revision>0){
            current={state:validateAccountState(cached.state),revision:cached.revision,mutationId:cached.mutationId};
            onChange(structuredClone(current));return structuredClone(current);
          }
        }catch{}
        throw error;
      }
    },
    async read(){
      if(!user)throw failure('SIGNED_OUT','먼저 로그인해 주세요.');
      if(busy)throw failure('BUSY','저장 중이에요. 잠시 기다려 주세요.');
      const token=epoch;
      try{return accept(await fetchRow(token));}catch(error){check(token);blocked=true;status('offline');throw error;}
    },
    async save(input,{expectedRevision=current?.revision??0}={}){
      if(!user)throw failure('SIGNED_OUT','먼저 로그인해 주세요.');
      if(busy)throw failure('BUSY','저장 중이에요. 잠시 기다려 주세요.');
      if(blocked)throw failure('RELOAD_REQUIRED','연결을 확인하고 최신 기록을 불러온 뒤 다시 저장해 주세요.');
      const state=validateAccountState(input),token=epoch,mutationId=crypto.randomUUID(),revision=expectedRevision;
      busy=true;status('saving');
      try{
        const result=await client.rpc('save_fridge_state',{p_state:state,p_expected_revision:revision,p_mutation_id:mutationId});
        check(token);
        if(result.error){
          if(result.error.message?.includes('VERSION_CONFLICT'))throw failure('CONFLICT','다른 기기에서 목록이 바뀌었어요. 입력을 보관하고 최신 기록을 불러와 주세요.');
          throw result.error;
        }
        return accept(parse(result.data));
      }catch(error){
        check(token);blocked=true;
        if(error.code==='CONFLICT'){status('conflict');throw error;}
        // A network error may arrive after the server committed. Reconcile before retrying.
        try{
          const latest=await fetchRow(token);
          if(latest.mutationId===mutationId)return accept(latest);
        }catch(reconcileError){if(reconcileError.code==='SESSION_CHANGED')throw reconcileError;}
        status('offline');throw failure('UNCERTAIN','저장 여부를 확인하지 못했어요. 입력을 유지했어요. 연결을 확인한 뒤 최신 기록을 불러와 주세요.');
      }finally{if(token===epoch)busy=false;}
    },
    disconnect(){
      epoch++;busy=false;blocked=true;current=null;
      if(user){try{storage?.removeItem(accountCacheKey(user.id));}catch{}}
      user=null;
    }
  };
}
