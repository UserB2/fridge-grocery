import {categories, ingredients, recipes} from './data.js';
import {normalizeName, findIngredient, makeItem, freshProfile, recipeStatus, addShopping, savePurchase, transferPurchase, parseMoney, purchaseSummary, persistState, loadState, filterShopping} from './core.js';
import {createAccountClient,createCloudStore} from './cloud.js';
import {cloudConfig} from './cloud-config.js';
import {importProfile,readProfileExport} from './sync-state.js';

const KEY = 'fridge-grocery:v1:state';
const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => crypto.randomUUID();
const today = () => {const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const money = (value,currency='USD') => value == null ? '미입력' : new Intl.NumberFormat('ko-KR',{style:'currency',currency,minimumFractionDigits:currency==='KRW'?0:2,maximumFractionDigits:2}).format(value);
const ingredient = (id) => ingredients.find(i=>i.id===id);
const emoji = (category) => ({'소스/양념':'🫙','육류':'🥩','수산물':'🐟','채소':'🥬','과일':'🍎','달걀/유제품':'🥚','곡류/면':'🍚','기타':'🥣'}[category]||'🥣');
const icon = (name) => {const paths={recipes:'M4 3h16v18H4z M8 3v18 M12 7h4 M12 11h4',fridge:'M6 2h12v20H6z M6 9h12 M9 5v1 M9 13v3',shopping:'M3 3h2l3 12h11l2-8H6 M9 20h.01 M18 20h.01',history:'M3 12a9 9 0 1 0 3-6 M3 3v5h5 M12 7v5l3 2',plus:'M12 5v14 M5 12h14',search:'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',arrow:'M5 12h14 M14 7l5 5-5 5',check:'M5 12l4 4L19 6',close:'M6 6l12 12 M6 18L18 6',user:'M20 21v-2a7 7 0 0 0-14 0v2 M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0'};return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${(paths[name]||paths.plus).split(' M').map((p,i)=>`<path d="${i?'M':''}${p}"/>`).join('')}</svg>`;};
let browserStorage;
try{browserStorage=window.localStorage;}catch{}
const loaded=loadState(browserStorage,KEY);
let storageProblem=loaded.blocked?'저장된 데이터를 읽지 못했어요. 기존 기록 보호를 위해 저장을 멈췄어요. 브라우저 저장 공간과 설정을 확인해 주세요.':'';
let readBlocked=loaded.blocked;
let state=loaded.state;
if(!state) {const p=freshProfile(uid(),'나의 주방');state={version:1,activeProfileId:p.id,profiles:[p]};}
const profile=()=>state.profiles.find(p=>p.id===state.activeProfileId);
let view=['recipes','fridge','shopping','history'].includes(location.hash.slice(1))?location.hash.slice(1):'recipes';
const filters={recipes:{search:'',cuisine:'전체',mode:'전체'},fridge:{search:'',category:'전체',location:'전체'},shopping:{search:'',category:'전체',status:'전체'}};
let selected=new Set();
let timer;
let modalContext=null;
let accountClient=null,cloudStore=null,accountUser=null,accountPhase='local',accountRevision=0;
let writeBusy=false,accountEpoch=0,accountCleanup=()=>{},pendingRemote=false;
const dirtyPrices=new Map();
const editing=()=>$('#modal').open||dirtyPrices.size>0||writeBusy;
const shoppingCurrency=()=>profile().shoppingCurrency||'USD';
function toast(message,error=false){const t=$('#toast');t.textContent=message;t.classList.toggle('error',error);t.hidden=false;window.clearTimeout(timer);timer=window.setTimeout(()=>t.hidden=true,4200);}
async function commit(next,message,refresh=true){
  if(writeBusy){toast('저장 중이에요. 잠시 기다려 주세요.',true);return false;}
  if(!accountUser&&readBlocked){toast(storageProblem,true);return false;}
  const epoch=accountEpoch,disabled=[...document.querySelectorAll('button,input,select')].map(el=>[el,el.disabled]);
  writeBusy=true;for(const [el]of disabled)el.disabled=true;
  try{
    if(accountUser){const saved=await cloudStore.save(next,{expectedRevision:accountRevision});if(epoch!==accountEpoch)return false;accountRevision=saved.revision;}
    else persistState(browserStorage,KEY,next);
    state=next;pendingRemote=false;storageProblem='';if(refresh)render();if(message)toast(message);return true;
  }catch(error){
    if(epoch!==accountEpoch)return false;
    if(accountUser)showSyncRecovery(error.message||'계정에 저장하지 못했어요. 입력은 그대로 유지했어요.');
    else storageProblem='변경 내용을 저장하지 못했어요. 저장 공간과 브라우저 설정을 확인해 주세요.';
    toast(accountUser?(error.message||'저장하지 못했어요.'):storageProblem,true);return false;
  }finally{writeBusy=false;for(const [el,value]of disabled)el.disabled=value;renderAccountStatus();}
}
function commitProfile(next,message,refresh=true){return commit({...state,profiles:state.profiles.map(p=>p.id===next.id?next:p)},message,refresh);}
function updateProfile(change,message,refresh=true){const next=structuredClone(profile());change(next);return commitProfile(next,message,refresh);}
function closeModal(){$('#modal').close();modalContext=null;}
function openModal(content,context){modalContext=context;const m=$('#modal');m.innerHTML=content;m.showModal();}
function dialog(title,body,actions='',form=''){return `${form?`<form id="${form}">`:''}<div class="dialog-header"><h2 class="dialog-title" id="dialog-title">${title}</h2><button type="button" class="btn ghost icon" data-action="close" aria-label="닫기">${icon('close')}</button></div><div class="dialog-body">${body}</div>${actions?`<div class="dialog-actions">${actions}</div>`:''}${form?'</form>':''}`;}
function field(label,name,value='',type='text',options=''){return `<label class="field"><span class="field-label">${label}</span><input name="${name}" type="${type}" value="${esc(value)}" ${options}></label>`;}
function selectField(label,name,values,value){return `<label class="field"><span class="field-label">${label}</span><select name="${name}">${values.map(v=>`<option ${v===value?'selected':''} value="${esc(v)}">${esc(v)}</option>`).join('')}</select></label>`;}
function dateLabel(date){const [y,m,d]=(date||today()).split('-');return `${y}.${m}.${d}`;}
function topbar(kicker,title,description,actions=''){return `<header class="topbar"><div><p class="eyebrow">${kicker}</p><h1 class="page-title">${title}</h1><p class="page-description">${description}</p></div><div class="topbar-actions">${actions}<button class="btn secondary mobile-profile" data-action="profiles" aria-label="프로필 선택">${icon('user')} ${esc(profile().name)}</button></div></header>`;}
function empty(title,description,action=''){return `<div class="empty-state"><span class="empty-icon">${view==='fridge'?'🥬':view==='shopping'?'🧺':'🍽️'}</span><h3>${title}</h3><p>${description}</p>${action}</div>`;}
function render(){
  const nav=[['recipes','요리 고르기'],['fridge','내 냉장고'],['shopping','장보기'],['history','구매 내역']];
  $('#navigation').innerHTML=nav.map(([id,label])=>`<button class="nav-btn" ${view===id?'aria-current="page"':''} data-action="navigate" data-view="${id}"><span class="nav-icon">${icon(id)}</span><span>${label}</span>${id==='shopping'&&profile().shopping.length?`<span class="nav-count">${profile().shopping.length}</span>`:''}</button>`).join('');
  $('#profile-button').innerHTML=`${icon('user')}<span>${esc(profile().name)}</span><span aria-hidden="true">⌄</span>`;
  $('#main-content').innerHTML=(storageProblem?`<p class="notice error" role="alert">${esc(storageProblem)}</p>`:'')+({recipes:renderRecipes,fridge:renderFridge,shopping:renderShopping,history:renderHistory}[view]());
  renderAccountStatus();
}
function searchField(placeholder,value){return `<label class="search-field">${icon('search')}<input id="view-search" class="search-input" type="search" placeholder="${placeholder}" value="${esc(value)}" aria-label="${placeholder}"></label>`;}
function chips(values,current,filter){return `<div class="chip-list">${values.map(v=>`<button class="chip ${current===v?'active':''}" aria-pressed="${current===v}" data-action="filter" data-filter="${filter}" data-value="${esc(v)}">${esc(v)}</button>`).join('')}</div>`;}
function recipeCard(recipe,index){const status=recipeStatus(recipe,profile(),today());return `<article class="recipe-card"><button class="recipe-visual cuisine-${recipe.cuisine}" data-action="recipe" data-id="${recipe.id}" aria-label="${esc(recipe.name)} 재료와 조리법 보기"><span>${recipe.emoji}</span><span class="recipe-time">◷ ${recipe.time}분</span></button><div class="recipe-body"><div class="recipe-meta"><span>${recipe.cuisine}</span><span>기본 레시피</span></div><button class="recipe-name" data-action="recipe" data-id="${recipe.id}">${esc(recipe.name)}</button><p class="recipe-description">${esc(recipe.description)}</p><p class="recipe-status ${status.ready?'ready':status.missing.length<=2?'near':''}">${status.ready?'● 지금 만들 수 있어요':`재료 ${status.missing.length}개가 더 필요해요`}</p><div class="recipe-footer"><span class="recipe-ingredients">${recipe.required.slice(0,3).map(id=>esc(ingredient(id)?.name||id)).join(' · ')}${recipe.required.length>3?' …':''}</span><label class="select-recipe"><input type="checkbox" data-action="select-recipe" data-id="${recipe.id}" ${selected.has(recipe.id)?'checked':''}><span>요리 선택</span></label></div></div></article>`;}
function recommendation(){const f=filters.recipes;const eligible=recipes.filter(r=>(f.cuisine==='전체'||r.cuisine===f.cuisine)&&recipeStatus(r,profile(),today()).ready);const key=`${today()}:${f.cuisine}`;const current=eligible.find(r=>r.id===profile().recommendations[key])||eligible[0];return {eligible,current,key};}
function renderRecipes(){const f=filters.recipes;const statuses=recipes.map(r=>({r,s:recipeStatus(r,profile(),today())}));const ready=statuses.filter(x=>x.s.ready).length;const near=statuses.filter(x=>x.s.missing.length>0&&x.s.missing.length<=2).length;let list=statuses.filter(({r,s})=>(f.cuisine==='전체'||r.cuisine===f.cuisine)&&(!f.search||normalizeName(r.name+' '+r.required.map(id=>ingredient(id)?.name||'').join(' ')).includes(normalizeName(f.search)))&&(f.mode==='전체'||f.mode==='지금 만들 수 있어요'&&s.ready||f.mode==='1~2개만 더 있으면'&&s.missing.length>0&&s.missing.length<=2));
 const {current}=recommendation();return topbar('COOK SOMETHING GOOD','오늘은 무엇을 만들까요?','먹고 싶은 요리를 고르면, 장보기까지 한 번에.',`<button class="btn secondary" data-action="navigate" data-view="fridge">${icon('fridge')} 냉장고 살펴보기</button>`)+`<section class="hero"><div class="hero-copy"><p class="hero-kicker">나의 재료로 시작하는 한 끼</p><h2>냉장고 속 재료,<br>오늘의 요리가 되다.</h2><p>있는 재료는 먼저 쓰고,<br>필요한 것만 가볍게 장봐요.</p><button class="btn primary" data-action="recommend">${current?'오늘의 요리 추천':'내 재료로 요리 찾기'} ${icon('arrow')}</button></div><div class="hero-art" aria-hidden="true"><div class="hero-orbit"><span class="hero-leaf">🌿</span><span class="hero-tomato">🍅</span><span class="hero-plate">🥗</span><span class="hero-egg">🥚</span></div><span class="hero-sticker">Fresh ideas,<br>every day.</span></div></section><div class="stats-grid"><div class="stat-card"><span class="stat-label">내 냉장고</span><span class="stat-value">${profile().fridge.length}<small>개 재료</small></span><span class="stat-symbol">🥬</span></div><div class="stat-card"><span class="stat-label">지금 만들 수 있는 요리</span><span class="stat-value">${ready}<small>가지</small></span><span class="stat-symbol">🍳</span></div><div class="stat-card"><span class="stat-label">조금만 더 있으면</span><span class="stat-value">${near}<small>가지</small></span><span class="stat-symbol">🧺</span></div></div><section><div class="section-heading"><div><h2 class="section-title">만들고 싶은 요리</h2><p class="section-meta">여러 요리를 골라도, 공통 재료는 하나로 모아드려요.</p></div><span class="badge muted">${recipes.length}가지 레시피</span></div><div class="toolbar">${chips(['전체','한식','양식','중식'],f.cuisine,'cuisine')}${searchField('요리나 재료 검색',f.search)}</div>${chips(['전체','지금 만들 수 있어요','1~2개만 더 있으면'],f.mode,'mode')}<p class="section-meta result-count">${list.length}가지 요리 · 재료 보유 여부 기준이며, 필요한 양은 따로 확인해 주세요.</p><div class="recipe-grid">${list.map(({r},i)=>recipeCard(r,i)).join('')}</div>${!list.length?empty('조건에 맞는 요리가 없어요','다른 검색어나 요리 종류를 골라 보세요.') :''}</section>${selected.size?`<div class="selection-bar"><span><strong>${selected.size}가지 요리</strong>를 골랐어요</span><div><button class="btn ghost small" data-action="clear-selection">선택 해제</button><button class="btn primary" data-action="recipe-list">장보기 목록 만들기 ${icon('arrow')}</button></div></div>`:''}`;}
function renderFridge(){const f=filters.fridge;const list=profile().fridge.filter(i=>(f.category==='전체'||i.category===f.category)&&(f.location==='전체'||i.location===f.location)&&(!f.search||normalizeName(i.name).includes(normalizeName(f.search))));return topbar('MY LITTLE PANTRY','내 냉장고','무엇이 있는지 알면, 장보기가 가벼워져요.',`<button class="btn primary" data-action="add-item" data-kind="fridge">${icon('plus')} 재료 추가</button>`)+`<div class="toolbar">${searchField('재료 이름 검색',f.search)}<label class="location-filter">보관 위치 <select id="location-filter">${['전체','냉장','냉동','실온'].map(v=>`<option ${f.location===v?'selected':''}>${v}</option>`).join('')}</select></label></div><div class="chip-list category-chips">${['전체',...categories].map(c=>`<button class="chip ${f.category===c?'active':''}" data-action="filter" data-filter="category" data-value="${esc(c)}" aria-pressed="${f.category===c}">${esc(c)} <span>${c==='전체'?profile().fridge.length:profile().fridge.filter(i=>i.category===c).length}</span></button>`).join('')}</div>${!profile().fridge.length?empty('우리 집 재료부터 담아볼까요?','달걀, 우유, 간장처럼 지금 가지고 있는 재료를 추가해 주세요.',`<button class="btn primary" data-action="add-item" data-kind="fridge">${icon('plus')} 첫 재료 추가</button>`):!list.length?empty('해당하는 재료가 없어요','다른 분류나 보관 위치를 선택해 보세요.'):categories.filter(c=>list.some(i=>i.category===c)).map(c=>`<section class="category-group"><h2 class="section-title">${emoji(c)} ${c}<small>${list.filter(i=>i.category===c).length}</small></h2><div class="inventory-grid">${list.filter(i=>i.category===c).map(i=>`<article class="inventory-card"><span class="item-icon">${emoji(c)}</span><div class="item-info"><h3 class="item-name">${esc(i.name)}</h3><p class="item-meta">${esc(i.quantity!==''?`${i.quantity}${i.unit?' '+i.unit:''}`:'수량 미입력')} · ${esc(i.location)}</p>${i.expiry?`<span class="badge ${i.expiry<today()?'warning':'muted'}">${i.expiry<today()?'기한 지남 · ':''}${dateLabel(i.expiry)}</span>`:''}</div><div class="item-actions"><button class="btn ghost small" data-action="edit-item" data-kind="fridge" data-id="${i.id}">수정</button><button class="btn ghost small" data-action="delete-item" data-kind="fridge" data-id="${i.id}">소진</button></div></article>`).join('')}</div></section>`).join('')}<p class="notice">기한이 지났거나 수량이 0인 재료는 요리 추천에서 제외해요. 소비기한은 직접 확인한 날짜를 입력해 주세요.</p>`;}
function resetShoppingFilters(){filters.shopping={search:'',category:'전체',status:'전체'};}
function renderShopping(){
  const p=profile(), f=filters.shopping;
  const list=filterShopping(p.shopping,f,recipes);
  const checked=p.shopping.filter(i=>i.checked);
  const priced=checked.filter(i=>i.price!=null);
  const sum=priced.reduce((a,i)=>a+Math.round(i.price*100),0)/100;
  const shownIds=new Set(list.map(i=>i.id));
  const hiddenChecked=checked.filter(i=>!shownIds.has(i.id)).length;
  const active=!!f.search.trim()||f.category!=='전체'||f.status!=='전체';
  const filterRow=(label,values,key,count)=>`<div class="shopping-filter-row"><span class="shopping-filter-label">${label}</span><div class="chip-list" role="group" aria-label="${label}">${values.map(value=>`<button class="chip ${f[key]===value?'active':''}" aria-pressed="${f[key]===value}" data-action="filter" data-filter="${key}" data-value="${esc(value)}">${esc(value)} <span>${count(value)}</span></button>`).join('')}</div></div>`;
  const controls=p.shopping.length?`<section class="panel shopping-filters" aria-label="장보기 필터"><div class="toolbar">${searchField('품목이나 연결된 요리 검색',f.search)}<button class="btn secondary small" data-action="reset-shopping-filters" ${active?'':'disabled'}>필터 초기화</button></div>${filterRow('식품 분류',['전체',...categories],'category',value=>value==='전체'?p.shopping.length:p.shopping.filter(i=>i.category===value).length)}${filterRow('구매 상태',['전체','미구매','구매 완료'],'status',value=>value==='전체'?p.shopping.length:value==='구매 완료'?checked.length:p.shopping.length-checked.length)}<p class="section-meta shopping-result" aria-live="polite">전체 ${p.shopping.length}개 중 <strong>${list.length}개</strong> 표시</p></section>`:'';
  const rows=list.map(i=>`<article class="shopping-row ${i.checked?'is-checked':''}"><label class="shopping-check"><input type="checkbox" data-action="check-item" data-id="${i.id}" ${i.checked?'checked':''} aria-label="${esc(i.name)} 구매 완료"></label><span class="item-icon">${emoji(i.category)}</span><div class="shopping-info"><h3 class="item-name">${esc(i.name)}</h3><p class="item-meta">${esc(i.category)}${i.quantity!==''?` · ${esc(i.quantity)} ${esc(i.unit)}`:''}</p>${i.recipeIds?.length?`<p class="recipe-source">${i.recipeIds.map(id=>esc(recipes.find(r=>r.id===id)?.name||'')).filter(Boolean).join(' · ')}</p>`:''}</div><div class="shopping-fields"><label class="price-field"><span>품목 금액</span><input type="number" inputmode="decimal" min="0" step="0.01" data-price-id="${i.id}" value="${esc(dirtyPrices.has(i.id)?dirtyPrices.get(i.id):i.price??'')}" placeholder="미입력" aria-label="${esc(i.name)} 줄 전체 구매 금액"></label><button class="btn ghost small" data-action="edit-item" data-kind="shopping" data-id="${i.id}">수정</button><button class="btn ghost small" data-action="delete-item" data-kind="shopping" data-id="${i.id}">삭제</button></div></article>`).join('');
  const body=!p.shopping.length?empty('장보기 목록이 비어 있어요','먹고 싶은 요리를 고르거나 필요한 품목을 직접 추가해 보세요.',`<button class="btn secondary" data-action="navigate" data-view="recipes">요리 고르러 가기 ${icon('arrow')}</button>`):`${list.length?`<div class="panel shopping-list">${rows}</div>`:empty('조건에 맞는 품목이 없어요','검색어나 분류·구매 상태를 바꿔 보세요.',`<button class="btn secondary" data-action="reset-shopping-filters">전체 품목 보기</button>`)}<div class="checkout-bar"><div><span class="section-meta">전체 목록 기준 · 구매 체크 ${checked.length}개 · 가격 입력 ${priced.length}개</span><p class="amount">입력된 품목 합계 <strong>${money(sum,shoppingCurrency())}</strong></p></div><button class="btn primary" data-action="checkout" ${!checked.length?'disabled':''}>구매 내역 저장 ${icon('arrow')}</button></div>${hiddenChecked?`<p class="notice shopping-hidden-note">필터로 보이지 않는 구매 체크 품목 <strong>${hiddenChecked}개</strong>도 구매 내역에 함께 저장돼요.</p>`:''}<p class="notice">가격은 개당 가격이 아닌 <strong>그 품목 전체에 지불한 금액</strong>이에요. 현재 표시는 <select id="shopping-currency" aria-label="금액 표시 통화"><option value="USD" ${shoppingCurrency()==='USD'?'selected':''}>USD · 미국 달러</option><option value="KRW" ${shoppingCurrency()==='KRW'?'selected':''}>KRW · 대한민국 원</option></select> 기준이며, 저장할 때 최종 통화를 선택할 수 있어요.</p>`;
  return topbar('A LIGHTER GROCERY RUN','장보기 목록','필요한 것만 사고, 구매 기록은 차곡차곡.',`<button class="btn primary" data-action="add-item" data-kind="shopping">${icon('plus')} 품목 추가</button>`)+`<div class="section-heading"><div><h2 class="section-title">다음 장보기 <span class="badge muted">${p.shopping.length}개</span></h2><p class="section-meta">구매한 품목을 체크한 뒤 구매 내역으로 저장하세요.</p></div></div>`+controls+body;
}
function renderHistory(){const trips=[...profile().purchases].sort((a,b)=>b.date.localeCompare(a.date));return topbar('YOUR KITCHEN JOURNAL','구매 내역','장본 날의 기록이, 다음 장보기의 힌트가 돼요.')+`<div class="section-heading"><h2 class="section-title">저장한 장보기</h2><span class="section-meta">${trips.length}번의 기록</span></div>${!trips.length?empty('첫 장보기를 기록해 보세요','장보기 목록에서 구매한 품목을 체크하고 저장하면 여기에 남아요.',`<button class="btn secondary" data-action="navigate" data-view="shopping">장보기 목록 보기 ${icon('arrow')}</button>`):`<div class="history-list">${trips.map(t=>{const summary=purchaseSummary(t);const remaining=t.items.filter(i=>!i.transferred).length;return `<article class="history-card panel"><div class="history-header"><div><p class="eyebrow">${dateLabel(t.date)}${t.store?' · '+esc(t.store):''}</p><h3>${esc(t.title||'장보기 기록')}</h3><p class="section-meta">${t.items.length}개 품목 · ${remaining?`${remaining}개 냉장고 등록 대기`:'냉장고 등록 완료'}</p></div><div class="history-amount"><span class="section-meta">${t.total==null?'입력된 품목 합계':'실제 결제 총액'}</span><strong>${money(t.total??summary.subtotal,t.currency)}</strong></div></div><div class="history-items">${t.items.map(i=>`<span>${emoji(i.category)} ${esc(i.name)}</span>`).join('')}</div><div class="history-footer"><span class="section-meta">가격 입력 ${summary.priced}/${summary.count}개</span><button class="btn secondary small" data-action="purchase" data-id="${t.id}">내역 보기 ${icon('arrow')}</button></div></article>`;}).join('')}</div>`}`;}
function updateShoppingSummary(){const checked=profile().shopping.filter(i=>i.checked);const priced=checked.filter(i=>i.price!=null);const bar=$('.checkout-bar');if(bar){bar.querySelector('.section-meta').textContent=`전체 목록 기준 · 구매 체크 ${checked.length}개 · 가격 입력 ${priced.length}개`;bar.querySelector('.amount strong').textContent=money(priced.reduce((sum,i)=>sum+Math.round(i.price*100),0)/100,shoppingCurrency());}}
function showItem(kind,id){const item=profile()[kind].find(i=>i.id===id);const i=item||makeItem({});openModal(dialog(`${item?'수정':'추가'}할 ${kind==='fridge'?'냉장고 재료':'장보기 품목'}`,`<div class="form-grid">${field('재료 이름','name',i.name,'text','required maxlength="60" list="ingredient-names" autocomplete="off"')}<datalist id="ingredient-names">${ingredients.map(i=>`<option value="${esc(i.name)}">${esc(i.category)}</option>`).join('')}</datalist>${selectField('식품 분류','category',categories,i.category)}${field('수량 · 선택','quantity',i.quantity,'number','min="0" step="any" inputmode="decimal"')}${field('단위 · 선택','unit',i.unit,'text','placeholder="개, g, 봉, 병…" maxlength="20"')}${selectField('보관 위치','location',['냉장','냉동','실온'],i.location)}${field('소비기한 · 선택','expiry',i.expiry,'date')}${kind==='shopping'?field('품목 전체 구매 금액 · 선택','price',i.price??'','number','min="0" step="0.01" inputmode="decimal"'):''}</div><p class="field-help">${kind==='shopping'?'가격은 이 줄의 전체 수량에 지불한 금액이에요. 통화는 구매 내역 저장 시 선택해 주세요.':'수량과 소비기한을 몰라도 재료를 등록할 수 있어요.'}</p>`,`<button type="button" class="btn secondary" data-action="close">취소</button><button class="btn primary" type="submit">${item?'수정 내용 저장':'추가하기'}</button>`,'item-form'),{kind,id});}
function showRecipe(id,recommended=false){const r=recipes.find(r=>r.id===id);if(!r)return;const s=recipeStatus(r,profile(),today());const missing=new Set(s.missing.map(i=>i.id));openModal(dialog(`${r.emoji} ${esc(r.name)}`,`${recommended?'<p class="badge success">오늘의 요리 추천</p>':''}<p class="section-meta">${r.cuisine} · 약 ${r.time}분 · 직접 작성한 기본 레시피</p><p>${esc(r.description)}</p><h3>필수 재료</h3><ul class="ingredient-list">${r.required.map(id=>`<li class="ingredient-row"><span>${esc(ingredient(id)?.name||id)}</span><span class="badge ${missing.has(id)?'warning':'success'}">${missing.has(id)?'필요해요':'보유 중'}</span></li>`).join('')}</ul>${r.optional.length?`<p class="field-help">선택 재료: ${r.optional.map(id=>esc(ingredient(id)?.name||id)).join(', ')}</p>`:''}<h3>이렇게 만들어 보세요</h3><ol class="steps">${r.steps.map(s=>`<li>${esc(s)}</li>`).join('')}</ol><p class="notice">보유 여부로 재료를 비교해요. 분량과 충분한 양, 실제 식재료 상태는 요리 전에 확인해 주세요.</p>`,` ${recommended?'<button type="button" class="btn secondary" data-action="recommend-again">다시 추천</button>':''}<button type="button" class="btn primary" data-action="single-recipe-list" data-id="${r.id}">장보기 재료 고르기 ${icon('arrow')}</button>`),{recipeId:id});}
function showRecipeList(ids){const chosen=recipes.filter(r=>ids.includes(r.id));const merged=new Map();for(const r of chosen){const missing=new Set(recipeStatus(r,profile(),today()).missing.map(i=>i.id));for(const id of r.required){if(!merged.has(id))merged.set(id,{...ingredient(id),recipeIds:[],missing:false});const m=merged.get(id);m.recipeIds.push(r.id);m.missing=m.missing||missing.has(id);}}openModal(dialog('장보기 재료를 골라 주세요',`<p class="section-meta">${chosen.map(r=>esc(r.name)).join(' · ')}</p><div class="toolbar"><span>기본은 부족한 재료만 선택해요.</span><button type="button" class="btn ghost small" data-action="select-all-ingredients">전체 재료 선택</button></div><ul class="ingredient-list">${[...merged.values()].map(i=>`<li><label class="ingredient-row"><span><input type="checkbox" name="ingredientIds" value="${i.id}" ${i.missing?'checked':''}> ${esc(i.name)}</span><span class="badge ${i.missing?'warning':'success'}">${i.missing?'필요해요':'보유 중'}</span></label></li>`).join('')}</ul><p class="notice">이미 있는 재료도 선택해 다시 살 수 있어요. 공통 재료는 하나로 모으고 수량은 장보기 목록에서 입력해 주세요.</p>`,`<button type="button" class="btn secondary" data-action="close">취소</button><button class="btn primary" type="submit">선택한 재료 담기</button>`,'recipe-list-form'),{merged:[...merged.values()]});}
function itemPurchaseFields(i,history=false){return `<div class="purchase-item"><div class="purchase-item-title"><strong>${emoji(i.category)} ${esc(i.name)}</strong>${history?`<span class="badge ${i.transferred?'success':'muted'}">${i.transferred?'냉장고 등록 완료':'등록 대기'}</span>`:''}</div><div class="form-grid compact">${field('품목 전체 금액',`price_${i.id}`,i.price??'','number','min="0" step="0.01" inputmode="decimal"')}${!i.transferred?`${field('수량',`quantity_${i.id}`,i.quantity??'','number','min="0" step="any"')}${field('단위',`unit_${i.id}`,i.unit||'','text','maxlength="20"')}${selectField('분류',`category_${i.id}`,categories,i.category)}${selectField('보관 위치',`location_${i.id}`,['냉장','냉동','실온'],i.location||'냉장')}${field('소비기한',`expiry_${i.id}`,i.expiry||'','date')}`:''}</div>${history&&!i.transferred?`<label class="transfer-check"><input type="checkbox" name="transferIds" value="${i.id}" checked> 이 품목을 냉장고에 넣기</label>`:''}</div>`;}
function showCheckout(){const items=profile().shopping.filter(i=>i.checked);if(!items.length)return;openModal(dialog('이번 장보기를 기록해요',`<p class="section-meta">구매 체크한 ${items.length}개 품목만 저장해요. 미구매 항목은 목록에 남아요.</p><div class="form-grid">${field('내역 이름','title','장보기','text','maxlength="80"')}${field('구매일','date',today(),'date','required')}${field('구매처 · 선택','store','','text','placeholder="마트, 온라인…" maxlength="80"')}${selectField('통화','currency',['USD','KRW'],shoppingCurrency())}${field('실제 결제 총액 · 선택','total','','number','min="0" step="0.01" inputmode="decimal"')}</div><p class="field-help">품목 가격을 몰라도 총액만 저장할 수 있어요. 총액에는 세금·할인을 반영해 주세요.</p><h3>구매품과 냉장고 등록 정보</h3>${items.map(i=>itemPurchaseFields(i)).join('')}<div class="notice" id="live-summary"></div>`,`<button class="btn secondary" type="submit" value="save">기록만 저장</button><button class="btn primary" type="submit" value="transfer">저장하고 냉장고에 넣기</button>`,'checkout-form'),{items});updateLiveSummary();}
function showPurchase(id){const p=profile().purchases.find(p=>p.id===id);if(!p)return;openModal(dialog(esc(p.title||'장보기 기록'),`<div class="form-grid">${field('내역 이름','title',p.title,'text','maxlength="80"')}${field('구매일','date',p.date,'date','required')}${field('구매처 · 선택','store',p.store,'text','maxlength="80"')}${selectField('통화','currency',['USD','KRW'],p.currency)}${field('실제 결제 총액 · 선택','total',p.total??'','number','min="0" step="0.01" inputmode="decimal"')}</div><h3>구매한 품목</h3>${p.items.map(i=>itemPurchaseFields(i,true)).join('')}<div class="notice" id="live-summary"></div><p class="field-help">냉장고에 넣은 뒤에도 구매 기록은 유지돼요. 이미 등록한 품목은 다시 넣지 않아요.</p>`,`<button class="btn secondary" type="submit" value="save">기록 수정 저장</button>${p.items.some(i=>!i.transferred)?'<button class="btn primary" type="submit" value="transfer">선택 품목 냉장고에 넣기</button>':''}`,'purchase-form'),{purchaseId:id,items:p.items});updateLiveSummary();}
function formItems(form,items){const fd=new FormData(form);return items.map(i=>{const out={...i,price:parseMoney(fd.get(`price_${i.id}`))};if(!i.transferred){out.quantity=String(fd.get(`quantity_${i.id}`)||'');out.unit=String(fd.get(`unit_${i.id}`)||'').trim();out.category=String(fd.get(`category_${i.id}`)||i.category);out.location=String(fd.get(`location_${i.id}`)||'냉장');out.expiry=String(fd.get(`expiry_${i.id}`)||'');}return out;});}
function updateLiveSummary(){const form=$('#checkout-form')||$('#purchase-form');if(!form)return;try{const fd=new FormData(form);const p={items:formItems(form,modalContext.items),total:parseMoney(fd.get('total')),currency:fd.get('currency')};const s=purchaseSummary(p);$('#live-summary').innerHTML=`가격 입력 ${s.priced}/${s.count}개 · <strong>입력된 품목 합계 ${money(s.subtotal,p.currency)}</strong>${p.total!=null?`<br>실제 결제 총액 ${money(p.total,p.currency)} · 차이 ${money(s.difference,p.currency)}`:''}`;}catch{ $('#live-summary').textContent='금액은 0 이상의 숫자로 소수 둘째 자리까지 입력해 주세요.';}}
function exportCurrentProfile(){const payload={format:'fridge-grocery-profile',version:1,exportedAt:new Date().toISOString(),profile:structuredClone(profile())};const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download=`${profile().name.replace(/[^\p{L}\p{N}_-]/gu,'_')}-profile-${today()}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('현재 프로필의 목록을 파일로 내보냈어요.');}
function showProfiles(){
  const local=loadState(browserStorage,KEY);
  const account=accountUser?`<p class="notice">${esc(accountUser.email)} 계정의 목록이에요. 같은 Google 계정으로 로그인한 기기에서 함께 사용해요.</p><button type="button" class="btn secondary" data-action="logout">로그아웃</button><h3>이 기기의 기존 기록 가져오기</h3>${local.state?.profiles.map(p=>`<button type="button" class="profile-row" data-action="import-local" data-id="${esc(p.id)}"><span>${esc(p.name)}</span><span>냉장고 ${p.fridge.length} · 장보기 ${p.shopping.length} · 구매 ${p.purchases.length}</span></button>`).join('')||'<p class="field-help">이 기기에 저장한 기존 프로필이 없어요.</p>'}<label class="field"><span class="field-label">내보낸 목록 파일 가져오기</span><input type="file" id="import-profile-file" accept="application/json,.json"></label>`:`<p class="notice">로그인 전 목록은 이 브라우저에 저장돼요. Google 계정으로 로그인하면 기기 간 동기화를 사용할 수 있어요.</p><button type="button" class="btn primary" data-action="google-login" ${accountClient?'':'disabled'}>Google로 로그인</button>${accountClient?'':'<p class="field-help">계정 연결을 준비 중이에요. 현재 목록은 그대로 사용할 수 있어요.</p>'}`;
  openModal(dialog('나의 주방 프로필',`${account}<h3>${accountUser?'계정의 주방':'이 기기의 프로필'}</h3><div class="profile-list">${state.profiles.map(p=>`<button type="button" class="profile-row" data-action="switch-profile" data-id="${esc(p.id)}"><span>${icon('user')} ${esc(p.name)}</span><span>${p.id===state.activeProfileId?'사용 중':'선택'}</span></button>`).join('')}</div><h3>새 주방 만들기</h3>${field('주방 이름','profileName','','text','required maxlength="30" placeholder="예: 우리 집" autocomplete="off"')}`,`<button type="button" class="btn secondary" data-action="export-profile">현재 목록 내보내기</button><button type="button" class="btn secondary" data-action="close">닫기</button><button class="btn primary" type="submit">주방 만들기</button>`,'profile-form'),{});
}

function renderAccountStatus(){
  let banner=$('#account-status');
  if(!banner){banner=document.createElement('div');banner.id='account-status';banner.className='account-status';$('#main-content').prepend(banner);}
  const labels={loading:'계정 기록을 불러오는 중',synced:'동기화 완료',saving:'동기화 중',offline:'연결 확인 필요',conflict:'다른 기기의 변경 확인 필요'};
  const text=accountUser?`${accountUser.email} · ${pendingRemote?'새 변경 확인 대기':labels[accountPhase]||'연결 확인 필요'}`:'이 기기에 저장 중';
  banner.innerHTML=`<span role="status">${esc(text)}</span>${accountUser?'<button type="button" class="btn ghost small" data-action="refresh-account">최신 기록 확인</button>':''}`;
  const notice=$('.storage-notice');if(notice)notice.textContent=accountUser?'같은 계정의 기기와 동기화해요.':'로그인하면 다른 기기와 동기화할 수 있어요.';
}
function showSyncRecovery(message){
  const parent=$('#modal').open?$('#modal .dialog-body'):$('#main-content');
  let box=parent.querySelector('.sync-recovery');if(!box){box=document.createElement('div');box.className='notice error sync-recovery';parent.prepend(box);}
  box.innerHTML=`<p>${esc(message)}</p><button type="button" class="btn secondary small" data-action="reload-account">입력 보관 후 최신 기록 불러오기</button>`;
}
function downloadJson(value,filename){
  const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download=filename;link.click();window.setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function exportDrafts(){
  const form=$('#modal form');
  downloadJson({format:'fridge-grocery-unsaved-draft',version:1,exportedAt:new Date().toISOString(),state:structuredClone(state),prices:Object.fromEntries(dirtyPrices),form:form?{id:form.id,fields:[...new FormData(form).entries()].filter(([,v])=>typeof v==='string')}:null},`냉장고-입력보관-${today()}.json`);
}
function applyAccountSnapshot(snapshot){
  if(editing()){pendingRemote=true;renderAccountStatus();return;}
  const profiles=snapshot.state?.profiles||[freshProfile(uid(),'나의 주방')];
  let preferred=state.activeProfileId;
  try{preferred=browserStorage?.getItem(`fridge-grocery:active:${accountUser.id}`)||preferred;}catch{}
  state={version:1,profiles:structuredClone(profiles),activeProfileId:profiles.some(p=>p.id===preferred)?preferred:profiles[0].id};
  accountRevision=snapshot.revision;pendingRemote=false;storageProblem='';selected.clear();render();
}
async function refreshAccount(force=false){
  if(!accountUser||writeBusy)return;
  if(editing()&&!force){pendingRemote=true;renderAccountStatus();return;}
  try{await cloudStore.read();}catch(error){if(error.code!=='SESSION_CHANGED')toast('최신 기록을 불러오지 못했어요. 연결을 확인해 주세요.',true);}
}
async function bringProfile(incoming){
  const base=cloudStore.snapshot()?.state?{version:1,profiles:state.profiles}:null;
  const next=importProfile(base,incoming,incoming.sourceProfileId||incoming.id);
  if(await commit({...next,activeProfileId:next.profiles.find(p=>p.sourceProfileId===(incoming.sourceProfileId||incoming.id))?.id||state.activeProfileId},'기존 기록을 계정에 가져왔어요.')){closeModal();render();}
}

export async function initializeAccounts(factory=createAccountClient){
  accountCleanup();const initEpoch=++accountEpoch;let disposed=false,channel=null,poll=null,subscription=null;
  try{accountClient=await factory(cloudConfig);}catch{toast('계정 연결을 불러오지 못했어요. 이 기기의 목록은 사용할 수 있어요.',true);return ()=>{};}
  if(initEpoch!==accountEpoch)return ()=>{};
  if(!accountClient){renderAccountStatus();return ()=>{};}
  const client=accountClient;
  async function changeSession(user){
    if(disposed||user?.id===accountUser?.id)return;
    const epoch=++accountEpoch;
    if(channel){void client.removeChannel(channel);channel=null;}
    cloudStore?.disconnect();accountUser=user||null;dirtyPrices.clear();pendingRemote=false;
    if($('#modal').open)closeModal();
    if(!user){
      accountPhase='local';accountRevision=0;const local=loadState(browserStorage,KEY);readBlocked=local.blocked;
      const p=freshProfile(uid(),'나의 주방');state=local.state||{version:1,activeProfileId:p.id,profiles:[p]};
      storageProblem=local.blocked?'이 기기의 기록을 읽지 못했어요. 기존 기록 보호를 위해 저장을 멈췄어요.':'';render();return;
    }
    // Hide the previous account immediately, before starting a possibly slow request.
    const blank=freshProfile(uid(),'나의 주방');state={version:1,activeProfileId:blank.id,profiles:[blank]};accountRevision=0;accountPhase='loading';storageProblem='';render();
    cloudStore=createCloudStore(client,{storage:browserStorage,onStatus:phase=>{if(epoch===accountEpoch){accountPhase=phase;renderAccountStatus();}},onChange:snapshot=>{if(epoch===accountEpoch)applyAccountSnapshot(snapshot);}});
    try{
      const snapshot=await cloudStore.connect(user);if(epoch!==accountEpoch)return;
      channel=client.channel(`fridge-${user.id}`).on('postgres_changes',{event:'*',schema:'public',table:'fridge_accounts',filter:`user_id=eq.${user.id}`},()=>{void refreshAccount();}).subscribe();
      if(!snapshot.state)showProfiles();
    }catch(error){if(epoch===accountEpoch&&error.code!=='SESSION_CHANGED')showSyncRecovery('계정 기록을 불러오지 못했어요. 연결을 확인한 뒤 최신 기록을 불러와 주세요.');}
  }
  subscription=client.auth.onAuthStateChange((_event,session)=>{window.setTimeout(()=>{if(!disposed)void changeSession(session?.user||null);},0);}).data.subscription;
  const result=await client.auth.getSession();if(!disposed)await changeSession(result.data.session?.user||null);
  const resume=()=>{if(document.visibilityState==='visible')void refreshAccount();};
  window.addEventListener('online',resume);window.addEventListener('focus',resume);document.addEventListener('visibilitychange',resume);
  poll=window.setInterval(resume,30000);
  accountCleanup=()=>{disposed=true;window.clearInterval(poll);subscription?.unsubscribe();if(channel)void client.removeChannel(channel);cloudStore?.disconnect();window.removeEventListener('online',resume);window.removeEventListener('focus',resume);document.removeEventListener('visibilitychange',resume);};
  renderAccountStatus();return accountCleanup;
}
async function recommend(again=false){const {eligible,key}=recommendation();if(!eligible.length){const nearest=recipes.filter(r=>filters.recipes.cuisine==='전체'||r.cuisine===filters.recipes.cuisine).map(r=>({r,s:recipeStatus(r,profile(),today())})).sort((a,b)=>a.s.missing.length-b.s.missing.length).slice(0,3);openModal(dialog('재료를 조금 더 준비해 볼까요?',`<p>현재 보유한 재료만으로 만들 수 있는 ${filters.recipes.cuisine==='전체'?'':filters.recipes.cuisine+' '}요리가 없어요. 아래 요리에 필요한 재료를 확인해 보세요.</p>${nearest.map(({r,s})=>`<button class="profile-row" data-action="recipe" data-id="${r.id}"><span>${r.emoji} ${esc(r.name)}</span><span>부족 ${s.missing.length}개</span></button>`).join('')}`,`<button type="button" class="btn secondary" data-action="close">닫기</button>`),{});return;}
const previous=profile().recommendations[key];const pool=again&&eligible.length>1?eligible.filter(r=>r.id!==previous):eligible;const stored=eligible.find(r=>r.id===previous);const picked=!again&&stored?stored:pool[Math.floor(Math.random()*pool.length)];if(picked.id!==previous&&!await updateProfile(p=>p.recommendations[key]=picked.id))return;if($('#modal').open)closeModal();showRecipe(picked.id,true);}
function navigate(next){view=next;location.hash=next;render();window.scrollTo({top:0,behavior:'instant'});}
document.addEventListener('click',async event=>{const target=event.target.closest('[data-action]');if(!target||target.disabled||writeBusy)return;const {action,id,kind}=target.dataset;
if(action==='navigate')navigate(target.dataset.view);
if(action==='profiles')showProfiles();
if(action==='export-profile')exportCurrentProfile();
if(action==='close')closeModal();
if(action==='filter'){filters[view][target.dataset.filter]=target.dataset.value;render();if(view==='shopping')[...document.querySelectorAll('[data-action="filter"]')].find(button=>button.dataset.filter===target.dataset.filter&&button.dataset.value===target.dataset.value)?.focus({preventScroll:true});}
if(action==='reset-shopping-filters'){resetShoppingFilters();render();$('#view-search')?.focus({preventScroll:true});}
if(action==='add-item')showItem(kind);
if(action==='edit-item')showItem(kind,id);
if(action==='delete-item'){const item=profile()[kind].find(i=>i.id===id);openModal(dialog(kind==='fridge'?'재료를 소진했나요?':'품목을 삭제할까요?',`<p><strong>${esc(item.name)}</strong>${kind==='fridge'?'을(를) 현재 냉장고에서 제거해요. 구매 기록은 그대로 남아요.':'을(를) 장보기 목록에서 삭제해요.'}</p>`,`<button type="button" class="btn secondary" data-action="close">취소</button><button type="button" class="btn danger" data-action="confirm-delete" data-kind="${kind}" data-id="${id}">${kind==='fridge'?'소진 처리':'삭제'}</button>`),{});}
if(action==='confirm-delete'){if(await updateProfile(p=>p[kind]=p[kind].filter(i=>i.id!==id),kind==='fridge'?'냉장고에서 소진 처리했어요.':'목록에서 삭제했어요.'))closeModal();}
if(action==='recipe'){if($('#modal').open)closeModal();showRecipe(id);}
if(action==='clear-selection'){selected.clear();render();}
if(action==='recipe-list')showRecipeList([...selected]);
if(action==='single-recipe-list'){closeModal();showRecipeList([id]);}
if(action==='select-all-ingredients')document.querySelectorAll('[name="ingredientIds"]').forEach(i=>i.checked=true);
if(action==='checkout')showCheckout();
if(action==='purchase')showPurchase(id);
if(action==='recommend'||action==='recommend-again')recommend(action==='recommend-again');
if(action==='switch-profile'){
  if(dirtyPrices.size){toast('입력한 금액을 먼저 저장하거나 입력 보관 후 최신 기록을 불러와 주세요.',true);return;}
  if(accountUser){state={...state,activeProfileId:id};try{browserStorage?.setItem(`fridge-grocery:active:${accountUser.id}`,id);}catch{}selected.clear();resetShoppingFilters();closeModal();render();}
  else if(await commit({...state,activeProfileId:id},'프로필을 바꿨어요.')){selected.clear();resetShoppingFilters();closeModal();render();}
}
if(action==='google-login'){try{const result=await accountClient.auth.signInWithOAuth({provider:'google',options:{redirectTo:new URL('./',location.href).href,queryParams:{prompt:'select_account'}}});if(result.error)throw result.error;}catch{toast('Google 로그인을 시작하지 못했어요. 잠시 후 다시 시도해 주세요.',true);}}
if(action==='logout'){const result=await accountClient.auth.signOut({scope:'local'});if(result.error)toast('로그아웃하지 못했어요. 연결을 확인해 주세요.',true);}
if(action==='import-local'){try{const local=loadState(browserStorage,KEY);const incoming=local.state?.profiles.find(p=>p.id===id);if(!incoming)throw new Error('기존 기록을 읽지 못했어요.');await bringProfile(incoming);}catch(error){toast(error.message,true);}}
if(action==='refresh-account'){if(editing())showSyncRecovery('입력 중인 내용이 있어요. 입력을 보관한 뒤 최신 기록을 불러올 수 있어요.');else await refreshAccount();}
if(action==='reload-account'){exportDrafts();closeModal();dirtyPrices.clear();await refreshAccount(true);}

});
document.addEventListener('change',async event=>{const el=event.target;const action=el.dataset.action;
if(action==='select-recipe'){if(el.checked)selected.add(el.dataset.id);else selected.delete(el.dataset.id);render();}
if(action==='check-item'){const value=el.checked;const previous=profile().shopping.find(i=>i.id===el.dataset.id).checked;if(!await updateProfile(p=>p.shopping.find(i=>i.id===el.dataset.id).checked=value))el.checked=previous;}
if(el.dataset.priceId){try{const value=parseMoney(el.value);dirtyPrices.set(el.dataset.priceId,el.value);if(await updateProfile(p=>p.shopping.find(i=>i.id===el.dataset.priceId).price=value,undefined,false)){dirtyPrices.delete(el.dataset.priceId);updateShoppingSummary();}}catch(error){toast(error.message,true);}}
if(el.id==='location-filter'){filters.fridge.location=el.value;render();}
if(el.id==='shopping-currency'){const value=el.value;if(!await updateProfile(p=>p.shoppingCurrency=value))el.value=shoppingCurrency();}
if(el.id==='import-profile-file'&&accountUser){const epoch=accountEpoch;try{const file=el.files[0];if(!file)return;if(file.size>200000)throw new Error('목록 파일이 너무 커요.');const incoming=readProfileExport(await file.text());if(epoch===accountEpoch)await bringProfile(incoming);}catch(error){toast(error.message,true);}}
if(el.name==='name'&&el.closest('#item-form')){const standard=findIngredient(el.value);if(standard)el.form.elements.category.value=standard.category;}
});
document.addEventListener('input',async event=>{if(event.isComposing)return;const el=event.target;if(el.name==='name'&&el.closest('#item-form')){const standard=findIngredient(el.value);if(standard)el.form.elements.category.value=standard.category;}if(el.dataset.priceId){dirtyPrices.set(el.dataset.priceId,el.value);}if(el.id==='view-search'){const start=el.selectionStart,end=el.selectionEnd;filters[view].search=el.value;render();const input=$('#view-search');input.focus({preventScroll:true});if(start!==null)input.setSelectionRange(start,end);}
if(el.closest('#checkout-form,#purchase-form'))updateLiveSummary();});
document.addEventListener('submit',async event=>{const form=event.target;if(!['item-form','profile-form','recipe-list-form','checkout-form','purchase-form'].includes(form.id))return;event.preventDefault();const fd=new FormData(form);
try{
 if(form.id==='item-form'){const {kind,id}=modalContext;const name=String(fd.get('name')||'').trim();if(!name)throw new Error('재료 이름을 입력해 주세요.');const previous=profile()[kind].find(i=>i.id===id);const item=makeItem({...previous,ingredientId:findIngredient(name)?.id||null,name,category:fd.get('category'),quantity:fd.get('quantity'),unit:String(fd.get('unit')||'').trim(),location:fd.get('location'),expiry:fd.get('expiry'),price:kind==='shopping'?parseMoney(fd.get('price')):previous?.price??null});let next=structuredClone(profile());if(id)next[kind]=next[kind].map(i=>i.id===id?item:i);else if(kind==='shopping')next=addShopping(next,[item]).profile;else next.fridge.push(item);if(await commitProfile(next,id?'수정 내용을 저장했어요.':'목록에 추가했어요.'))closeModal();}
 if(form.id==='profile-form'){const name=String(fd.get('profileName')||'').trim();if(!name)throw new Error('사용할 아이디를 입력해 주세요.');if(state.profiles.some(p=>normalizeName(p.name)===normalizeName(name)))throw new Error('같은 아이디가 있어요. 위 목록에서 선택해 주세요.');const p=freshProfile(uid(),name);if(await commit({...state,activeProfileId:p.id,profiles:[...state.profiles,p]},'새 프로필을 만들었어요.')){selected.clear();resetShoppingFilters();closeModal();render();}}
 if(form.id==='recipe-list-form'){const ids=fd.getAll('ingredientIds');if(!ids.length)throw new Error('담을 재료를 한 개 이상 선택해 주세요.');const inputs=modalContext.merged.filter(i=>ids.includes(i.id)).map(i=>({ingredientId:i.id,name:i.name,category:i.category,recipeIds:i.recipeIds}));const result=addShopping(profile(),inputs);if(await commitProfile(result.profile,`${result.added}개를 담았어요.${result.existing?` ${result.existing}개는 이미 목록에 있어요.`:''}`)){selected.clear();closeModal();navigate('shopping');}}
 if(form.id==='checkout-form'){const updated=formItems(form,modalContext.items);const draft={...profile(),shopping:profile().shopping.map(i=>updated.find(x=>x.id===i.id)||i)};const next=savePurchase(draft,{date:fd.get('date'),title:String(fd.get('title')||'').trim(),store:String(fd.get('store')||'').trim(),currency:fd.get('currency'),total:parseMoney(fd.get('total')),transfer:event.submitter?.value==='transfer'});next.shoppingCurrency=String(fd.get('currency'));if(await commitProfile(next,event.submitter?.value==='transfer'?'구매 기록을 저장하고 냉장고에 넣었어요.':'구매 내역을 저장했어요.')){closeModal();navigate(event.submitter?.value==='transfer'?'fridge':'history');}}
 if(form.id==='purchase-form'){const id=modalContext.purchaseId;let next=structuredClone(profile());const p=next.purchases.find(p=>p.id===id);Object.assign(p,{title:String(fd.get('title')||'').trim(),date:String(fd.get('date')),store:String(fd.get('store')||'').trim(),currency:String(fd.get('currency')),total:parseMoney(fd.get('total')),items:formItems(form,p.items)});if(event.submitter?.value==='transfer'){const ids=fd.getAll('transferIds');if(!ids.length)throw new Error('냉장고에 넣을 품목을 선택해 주세요.');next=transferPurchase(next,id,ids);}if(await commitProfile(next,event.submitter?.value==='transfer'?'선택한 품목을 냉장고에 넣었어요.':'구매 기록을 수정했어요.')){closeModal();navigate(event.submitter?.value==='transfer'?'fridge':'history');}}
}catch(error){toast(error.message||'입력 내용을 확인해 주세요.',true);}
});
window.addEventListener('hashchange',()=>{const next=location.hash.slice(1);if(['recipes','fridge','shopping','history'].includes(next)&&view!==next){view=next;render();}});
$('#modal').addEventListener('click',event=>{if(event.target===$('#modal')){const box=event.target.getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)closeModal();}});
window.addEventListener('storage',event=>{if(event.key===KEY&&!accountUser){readBlocked=true;storageProblem='다른 탭에서 목록이 변경되었어요. 새로고침한 뒤 계속 사용해 주세요.';render();}});
render();

void initializeAccounts();
