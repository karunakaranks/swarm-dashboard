const CRED_KEY='swarm-creds-v1', TIMEOUT_MS=30*60*1000;
const AGENTS=["all","mac-claude","vm-claude","chrome-claude"];
const AGENT_LABELS={"all":"ALL","mac-claude":"MAC","vm-claude":"VM","chrome-claude":"CHROME"};
const TIME_FILTERS=[
  {key:"all",label:"ALL",fn:()=>true},
  {key:"hour",label:"1H",fn:t=>new Date(t.created_at)>=new Date(Date.now()-3600000)},
  {key:"today",label:"TODAY",fn:t=>new Date(t.created_at).toDateString()===new Date().toDateString()},
  {key:"yesterday",label:"YESTERDAY",fn:t=>{const y=new Date();y.setDate(y.getDate()-1);return new Date(t.created_at).toDateString()===y.toDateString();}},
  {key:"week",label:"WEEK",fn:t=>new Date(t.created_at)>=new Date(Date.now()-7*86400000)},
];
const STATUS_META={
  "pending":    {color:"#ffaa00",bg:"#1a0e00",label:"PENDING"},
  "in-progress":{color:"#b041ff",bg:"#0e0020",label:"ACTIVE"},
  "done":       {color:"#7fff3a",bg:"#081500",label:"DONE"},
  "failed":     {color:"#ff3b6e",bg:"#1a0010",label:"FAILED"},
  "backlog":    {color:"#5090ff",bg:"#000a1a",label:"BACKLOG"},
};

let sbClient=null,channel=null,tasks=[],agentFilter="all",timeFilter="all",statusFilter="all";
let clockTimer=null,recentlyChanged=new Set(),expandedIds=new Set();
let _fsKeyCounter=0, _fsStore={};

const $=id=>document.getElementById(id);
const show=id=>$(id).classList.remove("hidden");
const hide=id=>$(id).classList.add("hidden");

// ── Markdown via marked.js + DOMPurify ────────────────────────────────────
function setupMarked(){
  marked.setOptions({ gfm: true, breaks: true });
}

function renderMd(raw){
  if(!raw||!raw.trim())return'';
  try{
    const html = marked.parse(raw);
    return DOMPurify.sanitize(html, {
      ADD_ATTR: ['target','rel'],
      ALLOWED_TAGS: ['h1','h2','h3','h4','h5','h6','p','br','strong','em','del',
                     'code','pre','ul','ol','li','blockquote','hr','a','table',
                     'thead','tbody','tr','th','td','div','span'],
    });
  }catch(e){
    return`<pre style="color:var(--text2);white-space:pre-wrap">${esc(raw)}</pre>`;
  }
}

function looksLikeMarkdown(text){
  if(!text||text.length<10)return false;
  return /^#{1,6} /m.test(text)   ||
         /\*\*.+\*\*/m.test(text) ||
         /^[-*] /m.test(text)     ||
         /```/.test(text)         ||
         /`[^`]+`/.test(text)     ||
         /^\d+\. /m.test(text)    ||
         /^> /m.test(text);
}

// ── Utils ──────────────────────────────────────────────────────────────────
function esc(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function truncTask(s,max){
  const t=String(s||"");
  if(t.length<=max)return esc(t);
  return`<span class="task-trunc">${esc(t.slice(0,max))}…</span>`;
}
function formatDuration(ms){
  if(!ms||ms<0)return"—";
  const s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60);
  if(h>0)return`${h}h ${m%60}m`;if(m>0)return`${m}m ${s%60}s`;return`${s}s`;
}
function timeAgo(ts){return ts?formatDuration(Date.now()-new Date(ts).getTime())+" ago":"—";}
function fmt(ts){return ts?new Date(ts).toLocaleString():"—";}
function saveCreds(url,key){localStorage.setItem(CRED_KEY,btoa(JSON.stringify({url,key})));}
function loadCreds(){try{const r=localStorage.getItem(CRED_KEY);return r?JSON.parse(atob(r)):null;}catch{return null;}}
function clearCredsStorage(){localStorage.removeItem(CRED_KEY);}
function setLive(state,label){$("live-pill").className="live-pill "+(state!=="live"?state:"");$("live-label").textContent=label;}

// ── Supabase ───────────────────────────────────────────────────────────────
async function initSupabase(url,key){
  sbClient=supabase.createClient(url,key,{realtime:{params:{eventsPerSecond:10}}});
  const{data,error}=await sbClient.from("swarm_tasks").select("*").order("created_at",{ascending:false}).limit(500);
  if(error)throw new Error(error.message);
  tasks=data;
  const _p=data.filter(t=>t.status==='pending').length;
  const _a=data.filter(t=>t.status==='in-progress').length;
  console.log(`[swarm] Initial fetch: ${data.length} tasks, ${_p} pending, ${_a} active`);
  if(_p||_a)console.log('[swarm] Non-done:',data.filter(t=>t.status!=='done'&&t.status!=='failed').map(t=>({id:t.id,status:t.status})));
  render();
  setLive("connecting","LINKING…");
  channel=sbClient.channel("swarm_live")
    .on("postgres_changes",{event:"*",schema:"public",table:"swarm_tasks"},p=>{
      const{eventType,new:nr,old:or}=p;
      if(eventType==="INSERT"){tasks.unshift(nr);recentlyChanged.add(nr.id);
        showToast(`NEW: ${(nr.task||nr.slug||nr.id||'').slice(0,40)}`, STATUS_META['pending'].color);}
      else if(eventType==="UPDATE"){const i=tasks.findIndex(t=>t.id===nr.id);if(i!==-1){const prev=tasks[i];tasks[i]=nr;
        // Only toast on status transitions, not every progress update
        if(prev.status!==nr.status){
          if(nr.status==='done')   showToast(`DONE: ${(nr.task||nr.slug||'').slice(0,40)}`,   STATUS_META['done'].color);
          else if(nr.status==='failed') showToast(`FAILED: ${(nr.task||nr.slug||'').slice(0,40)}`, STATUS_META['failed'].color);
          else if(nr.status==='in-progress') showToast(`ACTIVE: ${(nr.task||nr.slug||'').slice(0,40)}`, STATUS_META['in-progress'].color);
        }}else{tasks.unshift(nr);}recentlyChanged.add(nr.id);
      }
      else if(eventType==="DELETE")tasks=tasks.filter(t=>t.id!==or.id);
      render();setTimeout(()=>recentlyChanged.delete(nr?.id||or?.id),800);
    })
    .subscribe(s=>{
      if(s==="SUBSCRIBED"){setLive("live","LIVE");hide("header-err");startPollFallback();}
      else if(s==="CHANNEL_ERROR"){setLive("error","SEVERED");$("header-err").textContent="⚠ SEVERED";show("header-err");}
      else if(s==="TIMED_OUT")setLive("error","TIMEOUT");
      else if(s==="CLOSED")setLive("connecting","RELINKING…");
    });
}

// ── Poll fallback: re-fetch every 15s to catch missed Realtime events ──
let _pollInterval=null;
function startPollFallback(){
  if(_pollInterval)return;
  _pollInterval=setInterval(async()=>{
    if(!sbClient)return;
    // Don't overwrite search results
    if(_searchQuery)return;
    try{
      const{data}=await sbClient.from("swarm_tasks").select("*").order("created_at",{ascending:false}).limit(500);
      if(data){
        const _p=data.filter(t=>t.status==='pending').length;
        const _a=data.filter(t=>t.status==='in-progress').length;
        if(_p||_a)console.log(`[swarm-poll] ${_p} pending, ${_a} active`);
        tasks=data;render();
      }
    }catch(e){/* silent */}
  },15000);
}

async function manualSync(){
  if(!sbClient)return;setLive("connecting","SYNCING…");
  const{data,error}=await sbClient.from("swarm_tasks").select("*").order("created_at",{ascending:false}).limit(500);
  if(error){$("header-err").textContent="⚠ "+error.message;show("header-err");}
  else{tasks=data;render();hide("header-err");}
  setLive("live","LIVE");
}

// ── Render ─────────────────────────────────────────────────────────────────
function badge(status){
  const m=STATUS_META[status]||{color:"#666",bg:"#111",label:(status||"?").toUpperCase()};
  return`<span class="badge" style="background:${m.bg};color:${m.color};border:1px solid ${m.color}33">${m.label}</span>`;
}
function applyFilters(){
  const tf=TIME_FILTERS.find(f=>f.key===timeFilter)?.fn||(()=>true);
  let f=tasks.filter(tf);
  if(agentFilter!=="all")f=f.filter(t=>t.from_agent===agentFilter||t.to_agent===agentFilter);
  if(statusFilter!=="all")f=f.filter(t=>t.status===statusFilter);
  return f;
}

function render(){
  const filtered=applyFilters();
  // Filter stats with active status indicator
  let statsText=filtered.length===tasks.length?`${tasks.length} TASKS`:`${filtered.length}/${tasks.length}`;
  if(statusFilter!=="all"){
    const m=STATUS_META[statusFilter];
    statsText=`<span style="color:${m.color}">${m.label}</span> ${filtered.length}/${tasks.length} <span onclick="setStatus('${statusFilter}')" style="cursor:pointer;color:var(--text3);margin-left:4px" title="Clear filter">✕</span>`;
  }
  $("filter-stats").innerHTML=statsText;
  // cards
  const counts={pending:0,"in-progress":0,done:0,failed:0,backlog:0};
  filtered.forEach(t=>{if(counts[t.status]!==undefined)counts[t.status]++;});
  const icons={pending:"◌","in-progress":"◉",done:"◆",failed:"◈",backlog:"◇"};

  // Backlog handled via status card filter — no separate section
  $("status-cards").innerHTML=Object.entries(counts).map(([st,n])=>{
    const m=STATUS_META[st];
    const active=statusFilter===st;
    const border=active?`2px solid ${m.color}`:`1px solid ${m.color}22`;
    const glow=active?`box-shadow:0 0 12px ${m.color}44,inset 0 0 20px ${m.color}11;`:"";
    return`<div class="card" style="border:${border};cursor:pointer;transition:all .2s;${glow}" onclick="setStatus('${st}')">
      <div class="card-corner" style="border-color:${m.color};box-shadow:0 0 8px ${m.color}44"></div>
      <div class="card-corner-br" style="border-color:${m.color}"></div>
      <div class="card-label" style="color:${m.color}">${icons[st]} ${m.label}${active?" ✕":""}</div>
      <div class="card-count" style="color:${m.color};text-shadow:0 0 20px ${m.color}55">${n}</div>
      <div class="card-sub" style="color:${m.color}">${active?"FILTERED":"UNITS"}</div>
    </div>`;
  }).join("");
  // wip
  const wip=filtered.filter(t=>t.status==="in-progress");
  // Update swarm vein animation state
  updateVeinState(wip.length);
  if(!wip.length){hide("wip-section");}
  else{
    show("wip-section");$("wip-count").textContent=wip.length+" SPAWNING";
    $("wip-grid").innerHTML=wip.map(t=>{
      const ta=t.taken_at?new Date(t.taken_at).getTime():null;
      const el=ta?Date.now()-ta:0;
      const pct=ta?Math.min(99,Math.round(el/TIMEOUT_MS*100)):0;
      const bc=pct>80?"#ff3b6e":pct>50?"#ffaa00":"#b041ff";
      return`<div class="wip-card">
        <div class="wip-top">
          <div class="wip-info">
            <div class="wip-id">${esc(t.id)}</div>
            <div class="wip-task-text">${truncTask(t.task||t.slug||"—",120)}</div>
          </div>
          <div class="wip-timing">
            <div class="wip-timer" data-taken="${esc(t.taken_at||"")}">${formatDuration(el)}</div>
            <div class="wip-timer-label">ELAPSED</div>
          </div>
        </div>
        <div>
          <div class="wip-bar-meta">
            <span class="wip-bar-from">SPAWN: <span style="color:var(--text1)">${esc(t.from_agent||"?")}</span></span>
            <span class="wip-bar-pct" style="color:${pct>80?"#ff3b6e":"var(--text2)"}">${pct}% LIMIT</span>
          </div>
          <div class="wip-bar-track"><div class="wip-bar-fill" style="width:${pct}%;background:${bc};box-shadow:0 0 8px ${bc}88;transition:width 1s linear"></div></div>
        </div>
        ${t.result?`<div class="wip-result-preview">${esc(t.result.slice(0,180))}${t.result.length>180?"…":""}</div>`:""}
      </div>`;
    }).join("");
  }
  // table
  $("table-count").textContent=filtered.length+" TASKS";
  if(!filtered.length){show("table-empty");hide("table-container");$("table-empty").textContent="NO UNITS IN RANGE";}
  else{
    hide("table-empty");show("table-container");
    $("task-tbody").innerHTML=filtered.map(t=>{
      const fl=recentlyChanged.has(t.id)?" flash":"";
      return`<tr class="task-row${fl}" data-status="${esc(t.status)}" onclick="toggleRow(this,'${esc(btoa(unescape(encodeURIComponent(JSON.stringify(t)))))}')">
        <td class="td-id">${esc((t.id||"—").slice(0,17))}</td>
        <td>${badge(t.status)}</td>
        <td class="td-task">${truncTask(t.task||t.slug||"—",80)}</td>
        <td class="td-agent">${esc(t.from_agent||"—")}</td>
        <td class="td-agent">${esc(t.to_agent||"any")}</td>
        <td class="td-time">${timeAgo(t.created_at)}</td>
        <td>${t.status==="backlog"?`<button onclick="event.stopPropagation();approveTask('${esc(t.id)}')" style="background:#5090ff22;border:1px solid #5090ff44;color:#5090ff;border-radius:3px;padding:2px 8px;font-size:9px;cursor:pointer;font-family:'Orbitron',monospace;letter-spacing:.08em">APPROVE</button>`:""}</td>
      </tr>`;
    }).join("");
    // Restore any previously expanded rows
    _restoreExpanded();
    // Render mobile card list
    renderMobileCards(filtered);
  }
}

// ── Expanded detail view with markdown ────────────────────────────────────
function _renderField(label,value,taskName){
  if(!value)return'';
  const isMarkdown=looksLikeMarkdown(value);
  const content=isMarkdown
    ?`<div class="md-body">${renderMd(value)}</div>`
    :`<div style="white-space:pre-wrap;word-break:break-word;color:var(--text1);font-size:12px;line-height:1.7">${esc(value)}</div>`;
  // Store payload in a global map keyed by a short id — avoids any escaping issues in attributes
  const fsKey = 'fs_' + (++_fsKeyCounter);
  _fsStore[fsKey] = {label, value, taskName: taskName||''};
  return`<div class="detail-section">
    <div class="detail-section-label">
      ${label}${isMarkdown?' <span style="color:var(--zerg);font-size:9px;opacity:.7">MD</span>':''}
      <button class="fullscreen-btn" data-fskey="${fsKey}">⛶ FULLSCREEN</button>
    </div>
    <div class="detail-content">${content}</div>
  </div>`;
}

function _buildDetailHTML(t){
  return`<td colspan="6" class="expand-inner">
    <div class="task-detail">
      <div class="detail-header">
        <div>
          <div class="detail-id">${esc(t.id||"—")}</div>
          <div class="detail-title">${esc(t.task||t.slug||"—")}</div>
        </div>
        ${badge(t.status)}
      </div>
      <div class="detail-meta">
        <div class="meta-item"><div class="meta-label">FROM</div><div class="meta-value">${esc(t.from_agent||"—")}</div></div>
        <div class="meta-item"><div class="meta-label">TO</div><div class="meta-value">${esc(t.to_agent||"any")}</div></div>
        <div class="meta-item"><div class="meta-label">CREATED</div><div class="meta-value">${fmt(t.created_at)}</div></div>
        ${t.taken_at?`<div class="meta-item"><div class="meta-label">CLAIMED</div><div class="meta-value">${fmt(t.taken_at)}</div></div>`:''}
        ${t.done_at?`<div class="meta-item"><div class="meta-label">COMPLETE</div><div class="meta-value">${fmt(t.done_at)}</div></div>`:''}
        ${t.taken_at&&t.done_at?`<div class="meta-item"><div class="meta-label">DURATION</div><div class="meta-value" style="color:var(--psi)">${formatDuration(new Date(t.done_at)-new Date(t.taken_at))}</div></div>`:''}
      </div>
      ${_renderField('// CONTEXT',t.context, t.task||t.slug)}
      ${_renderField('// RESULT',t.result, t.task||t.slug)}
    </div>
  </td>`;
}

function _insertDetailRow(row,t){
  const stale=row.nextElementSibling;
  if(stale&&stale.classList.contains("expand-row"))stale.remove();
  const exp=document.createElement("tr");
  exp.className="expand-row";
  exp.dataset.expandFor=t.id;
  exp.innerHTML=_buildDetailHTML(t);
  row.after(exp);
}

function toggleRow(row,encoded){
  const t=JSON.parse(decodeURIComponent(escape(atob(encoded))));
  const next=row.nextElementSibling;
  if(next&&next.classList.contains("expand-row")){
    next.remove();
    expandedIds.delete(t.id);
    return;
  }
  expandedIds.add(t.id);
  _insertDetailRow(row,t);
}

// Re-expand any rows that were open before a render
function _restoreExpanded(){
  if(!expandedIds.size)return;
  document.querySelectorAll("#task-tbody tr.task-row").forEach(row=>{
    const m=row.getAttribute("onclick")?.match(/'([A-Za-z0-9+/=]+)'\)/);
    if(!m)return;
    try{
      const t=JSON.parse(decodeURIComponent(escape(atob(m[1]))));
      if(!expandedIds.has(t.id))return;
      // Use freshest data from tasks array
      const fresh=tasks.find(x=>x.id===t.id)||t;
      _insertDetailRow(row,fresh);
    }catch(e){}
  });
}

// ── Status ticker (fixed bar, replaces floating toasts) ──────────────────
const STATUS_LABELS = {'pending':'PENDING','in-progress':'ACTIVE','done':'DONE','failed':'FAILED'};
let _tickerTimer = null;
function showToast(msg, color='#b041ff', duration=5000){
  const ticker = $('status-ticker');
  const dot = $('ticker-dot');
  const msgEl = $('ticker-msg');
  dot.style.background = color;
  dot.style.boxShadow = `0 0 6px ${color}`;
  msgEl.textContent = msg;
  ticker.classList.add('visible');
  if(_tickerTimer) clearTimeout(_tickerTimer);
  _tickerTimer = setTimeout(()=>{ ticker.classList.remove('visible'); _tickerTimer=null; }, duration);
}
$('ticker-dismiss').addEventListener('click', ()=>{
  $('status-ticker').classList.remove('visible');
  if(_tickerTimer){clearTimeout(_tickerTimer);_tickerTimer=null;}
});
function dismissToast(t){
  // legacy compat — no-op
  setTimeout(()=>t.remove(), 250);
}

// ── Collapsible SPAWNING ──────────────────────────────────────────────────
let wipCollapsed = false;
function toggleWipCollapse(){
  wipCollapsed = !wipCollapsed;
  $('wip-grid').classList.toggle('collapsed', wipCollapsed);
  const icon = $('wip-collapse-icon');
  icon.classList.toggle('collapsed', wipCollapsed);
  icon.textContent = wipCollapsed ? '▸' : '▾';
}

// ── Bookmark count badge ──────────────────────────────────────────────────
function bmUpdateHeaderBtn(){
  const count = bmLoad().length;
  $('bm-open-btn').textContent = count ? `☆ SAVED (${count})` : '☆ SAVED';
}

// ── Mobile task cards ─────────────────────────────────────────────────────
function renderMobileCards(filtered){
  const list = $('task-cards-list');
  if(!filtered.length){ list.innerHTML='<div style="padding:30px;text-align:center;color:var(--text3);font-size:12px">NO UNITS IN RANGE</div>'; return; }
  list.innerHTML = filtered.map(t=>{
    const m = STATUS_META[t.status]||{color:'#888',label:'?'};
    const fl = recentlyChanged.has(t.id)?' flash':'';
    return`<div class="task-card-item${fl}" data-status="${esc(t.status)}"
      onclick="toggleMobileCard(this,'${esc(btoa(unescape(encodeURIComponent(JSON.stringify(t)))))}')">
      <div class="task-card-top">
        <div class="task-card-name">${truncTask(t.task||t.slug||'—',100)}</div>
        ${badge(t.status)}
      </div>
      <div class="task-card-bottom">
        <span class="task-card-id">${esc((t.id||'').slice(0,17))}</span>
        <span class="task-card-agents">${esc(t.from_agent||'?')} → ${esc(t.to_agent||'any')}</span>
        <span class="task-card-age">${timeAgo(t.created_at)}</span>
      </div>
    </div>`;
  }).join('');
  // Restore expanded mobile cards
  if(expandedIds.size){
    list.querySelectorAll('.task-card-item').forEach(card=>{
      const m=card.getAttribute('onclick')?.match(/'([A-Za-z0-9+/=]+)'\)/);
      if(!m)return;
      try{
        const t=JSON.parse(decodeURIComponent(escape(atob(m[1]))));
        if(expandedIds.has(t.id)){
          const fresh=tasks.find(x=>x.id===t.id)||t;
          _insertMobileDetail(card,fresh);
        }
      }catch(e){}
    });
  }
}
function toggleMobileCard(card, encoded){
  const t=JSON.parse(decodeURIComponent(escape(atob(encoded))));
  const next=card.nextElementSibling;
  if(next&&next.classList.contains('mobile-detail')){ next.remove(); expandedIds.delete(t.id); return; }
  expandedIds.add(t.id);
  const fresh=tasks.find(x=>x.id===t.id)||t;
  _insertMobileDetail(card,fresh);
}
function _insertMobileDetail(card,t){
  const stale=card.nextElementSibling;
  if(stale&&stale.classList.contains('mobile-detail'))stale.remove();
  const d=document.createElement('div');
  d.className='mobile-detail';
  d.style.cssText='background:var(--creep);border:1px solid var(--border2);border-top:none;border-radius:0 0 4px 4px;padding:12px 14px;margin-top:-4px;margin-bottom:4px;';
  d.innerHTML=`<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;font-size:11px">
    ${t.from_agent?`<div><div style="color:var(--text3);font-size:9px;font-family:'Orbitron',monospace;letter-spacing:.1em;margin-bottom:2px">FROM</div><div style="color:var(--text1)">${esc(t.from_agent)}</div></div>`:''}
    ${t.taken_at?`<div><div style="color:var(--text3);font-size:9px;font-family:'Orbitron',monospace;letter-spacing:.1em;margin-bottom:2px">CLAIMED</div><div style="color:var(--text1)">${fmt(t.taken_at)}</div></div>`:''}
    ${t.done_at?`<div><div style="color:var(--text3);font-size:9px;font-family:'Orbitron',monospace;letter-spacing:.1em;margin-bottom:2px">DONE</div><div style="color:var(--text1)">${fmt(t.done_at)}</div></div>`:''}
  </div>
  ${t.result?`${_renderField('// RESULT',t.result,t.task||t.slug)}`:''}
  ${t.context?`${_renderField('// CONTEXT',t.context,t.task||t.slug)}`:''}`;
  card.after(d);
}

// ── Pull-to-refresh ───────────────────────────────────────────────────────
(function(){
  let startY=0, pulling=false, triggered=false;
  const THRESHOLD=80;
  document.addEventListener('touchstart',e=>{
    if(window.scrollY===0) startY=e.touches[0].clientY;
    pulling=true; triggered=false;
  },{passive:true});
  document.addEventListener('touchmove',e=>{
    if(!pulling||window.scrollY>0)return;
    const dist=e.touches[0].clientY-startY;
    if(dist<10)return;
    const pct=Math.min(dist/THRESHOLD,1);
    const ind=$('ptr-indicator'), arrow=$('ptr-arrow'), lbl=$('ptr-label');
    ind.classList.add('visible');
    arrow.style.opacity=pct;
    if(dist>=THRESHOLD&&!triggered){ arrow.classList.add('ready'); lbl.textContent='RELEASE TO SYNC'; triggered=true; }
    else if(dist<THRESHOLD){ arrow.classList.remove('ready'); lbl.textContent='PULL TO SYNC'; triggered=false; }
  },{passive:true});
  document.addEventListener('touchend',()=>{
    const ind=$('ptr-indicator');
    ind.classList.remove('visible');
    $('ptr-arrow').classList.remove('ready');
    $('ptr-arrow').style.opacity='';
    $('ptr-label').textContent='PULL TO SYNC';
    if(triggered){ triggered=false; manualSync().then(()=>showToast('SYNCED',STATUS_META['done'].color,2000)); }
    pulling=false;
  },{passive:true});
})();

// ── History / back-swipe navigation ──────────────────────────────────────
// Push a state so back button/swipe closes overlays instead of leaving the page
(function(){
  // On load, push a base 'home' state so there's always a state to pop to
  history.replaceState({page:'home'},'');

  function pushOverlayState(name){
    history.pushState({page:name},'');
  }
  function isAnyOverlayOpen(){
    return $('fs-modal').classList.contains('open') ||
           $('bm-panel').classList.contains('open') ||
           $('confirm-overlay').classList.contains('open');
  }

  // Intercept popstate (back swipe / back button)
  window.addEventListener('popstate', e=>{
    const state = e.state||{};
    // Close any open overlay on back navigation
    if($('fs-modal').classList.contains('open'))         { closeFullscreen(); if(state.page!=='home') history.replaceState({page:'home'},''); return; }
    if($('bm-panel').classList.contains('open'))         { closeBmPanel();    if(state.page!=='home') history.replaceState({page:'home'},''); return; }
    if($('confirm-overlay').classList.contains('open'))  { closeConfirm();    if(state.page!=='home') history.replaceState({page:'home'},''); return; }
    // Nothing open — stay on page
    if(state.page==='home'||!state.page) history.pushState({page:'home'},'');
  });

  // Patch open functions to push history state
  const _origOpenFs   = openFullscreen;
  const _origOpenBm   = openBmPanel;
  const _origOpenConf = openConfirm;

  window.openFullscreen = function(label,value,taskName){
    _origOpenFs(label,value,taskName);
    pushOverlayState('fullscreen');
  };
  window.openBmPanel = function(){
    _origOpenBm();
    pushOverlayState('bookmarks');
  };
  window.openConfirm = function(){
    _origOpenConf();
    pushOverlayState('confirm');
  };
})();

// ── Copy button in fullscreen ─────────────────────────────────────────────
$('fs-copy-btn').addEventListener('click',()=>{
  if(!_currentFsData)return;
  navigator.clipboard.writeText(_currentFsData.value).then(()=>{
    const btn=$('fs-copy-btn');
    btn.textContent='✓ COPIED'; btn.classList.add('copied');
    setTimeout(()=>{ btn.textContent='⎘ COPY'; btn.classList.remove('copied'); },1800);
  }).catch(()=>{
    // Fallback for older browsers
    const ta=document.createElement('textarea');
    ta.value=_currentFsData.value;
    ta.style.position='fixed'; ta.style.opacity='0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    const btn=$('fs-copy-btn');
    btn.textContent='✓ COPIED'; btn.classList.add('copied');
    setTimeout(()=>{ btn.textContent='⎘ COPY'; btn.classList.remove('copied'); },1800);
  });
});


// ── Swarm vein animation state ────────────────────────────────────────────
let _veinActive = null;
function updateVeinState(wipCount){
  const veins = $('swarm-veins');
  if(!veins) return;
  const shouldBeActive = wipCount > 0;
  if(_veinActive === shouldBeActive) return;
  _veinActive = shouldBeActive;
  if(shouldBeActive){ veins.classList.add('active'); startLightning(); }
  else { veins.classList.remove('active'); stopLightning(); }
}

// ── Lightning vein generator ──────────────────────────────────────────────
const HIVE_NODES = [{x:35,y:48},{x:65,y:45},{x:50,y:78}];
const EDGE_TARGETS = [
  {x:0,y:14},{x:0,y:55},{x:0,y:72},{x:0,y:90},
  {x:100,y:16},{x:100,y:52},{x:100,y:86},{x:100,y:96},
  {x:12,y:0},{x:50,y:0},{x:86,y:0},{x:64,y:0},
  {x:14,y:100},{x:50,y:100},{x:84,y:100},{x:32,y:100},
];
let _lightningTimer=null;
let _boltFadeTimers=[];

function lightningPath(x1,y1,x2,y2,jitter,segments){
  // Generate jagged lightning bolt path between two points
  const pts=[{x:x1,y:y1}];
  for(let i=1;i<segments;i++){
    const t=i/segments;
    const mx=x1+(x2-x1)*t;
    const my=y1+(y2-y1)*t;
    // Perpendicular jitter — stronger in middle, weaker at ends
    const strength=Math.sin(t*Math.PI)*jitter;
    const dx=-(y2-y1)/Math.hypot(x2-x1,y2-y1);
    const dy=(x2-x1)/Math.hypot(x2-x1,y2-y1);
    const offset=(Math.random()-0.5)*2*strength;
    pts.push({x:mx+dx*offset, y:my+dy*offset});
  }
  pts.push({x:x2,y:y2});
  let d=`M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for(let i=1;i<pts.length;i++) d+=` L${pts[i].x.toFixed(1)},${pts[i].y.toFixed(1)}`;
  return d;
}

function spawnBolt(){
  const g=$('vein-bolts');
  if(!g)return;
  const ns='http://www.w3.org/2000/svg';
  // Pick random hive node as source
  const src=HIVE_NODES[Math.floor(Math.random()*HIVE_NODES.length)];
  // 60% chance edge target, 30% another hive, 10% random point
  let tgt;
  const r=Math.random();
  if(r<0.6) tgt=EDGE_TARGETS[Math.floor(Math.random()*EDGE_TARGETS.length)];
  else if(r<0.9){ const others=HIVE_NODES.filter(n=>n!==src); tgt=others[Math.floor(Math.random()*others.length)];}
  else tgt={x:Math.random()*100,y:Math.random()*100};

  const dist=Math.hypot(tgt.x-src.x,tgt.y-src.y);
  const segs=Math.max(6,Math.floor(dist/4));
  const jitter=2+Math.random()*4;

  // Main bolt
  const path=document.createElementNS(ns,'path');
  path.setAttribute('d',lightningPath(src.x,src.y,tgt.x,tgt.y,jitter,segs));
  path.setAttribute('fill','none');
  path.setAttribute('stroke-linecap','round');
  path.setAttribute('stroke-linejoin','round');
  path.setAttribute('filter','url(#vglow-bolt)');
  // Random color: 70% purple, 20% pink, 10% green
  const cr=Math.random();
  const color=cr<0.7?'#b041ff':cr<0.9?'#e040fb':'#7fff3a';
  path.setAttribute('stroke',color);
  path.setAttribute('stroke-width',(0.4+Math.random()*0.8).toFixed(2));
  path.setAttribute('stroke-opacity','0');
  path.style.transition='stroke-opacity 0.15s ease-in';
  g.appendChild(path);
  // Flash in
  requestAnimationFrame(()=>{ path.setAttribute('stroke-opacity',(0.3+Math.random()*0.4).toFixed(2)); });

  // Branch bolt (50% chance)
  if(Math.random()<0.5){
    const midIdx=Math.floor(segs*0.4+Math.random()*segs*0.3);
    const t=midIdx/segs;
    const bx=src.x+(tgt.x-src.x)*t+(Math.random()-0.5)*8;
    const by=src.y+(tgt.y-src.y)*t+(Math.random()-0.5)*8;
    const be=EDGE_TARGETS[Math.floor(Math.random()*EDGE_TARGETS.length)];
    const branch=document.createElementNS(ns,'path');
    branch.setAttribute('d',lightningPath(bx,by,be.x,be.y,jitter*0.7,Math.max(4,segs-3)));
    branch.setAttribute('fill','none');
    branch.setAttribute('stroke',color);
    branch.setAttribute('stroke-width',(0.2+Math.random()*0.4).toFixed(2));
    branch.setAttribute('stroke-opacity','0');
    branch.setAttribute('stroke-linecap','round');
    branch.setAttribute('filter','url(#vglow)');
    branch.style.transition='stroke-opacity 0.15s ease-in';
    g.appendChild(branch);
    requestAnimationFrame(()=>{ branch.setAttribute('stroke-opacity',(0.15+Math.random()*0.25).toFixed(2)); });
    // Fade out branch
    const bt=setTimeout(()=>{
      branch.style.transition='stroke-opacity 0.6s ease-out';
      branch.setAttribute('stroke-opacity','0');
      setTimeout(()=>branch.remove(),700);
    },200+Math.random()*400);
    _boltFadeTimers.push(bt);
  }

  // Fade out main bolt
  const ft=setTimeout(()=>{
    path.style.transition='stroke-opacity 0.5s ease-out';
    path.setAttribute('stroke-opacity','0');
    setTimeout(()=>path.remove(),600);
  },150+Math.random()*500);
  _boltFadeTimers.push(ft);
}

function startLightning(){
  if(_lightningTimer)return;
  // Burst of initial bolts
  for(let i=0;i<4;i++) setTimeout(()=>spawnBolt(),i*120);
  // Then ongoing random bolts
  _lightningTimer=setInterval(()=>{
    const count=1+Math.floor(Math.random()*3); // 1-3 bolts per tick
    for(let i=0;i<count;i++) setTimeout(()=>spawnBolt(),Math.random()*300);
  },600+Math.random()*400);
}

function stopLightning(){
  if(_lightningTimer){clearInterval(_lightningTimer);_lightningTimer=null;}
  _boltFadeTimers.forEach(t=>clearTimeout(t));
  _boltFadeTimers=[];
  const g=$('vein-bolts');
  if(g) g.innerHTML='';
}

// ── Search ────────────────────────────────────────────────────────────────
let _searchDebounce=null;
let _searchQuery="";
function handleSearch(q){
  clearTimeout(_searchDebounce);
  _searchQuery=q.trim();
  _searchDebounce=setTimeout(()=>{
    if(!_searchQuery){
      // Cleared search — reload full task list
      manualSync();
      return;
    }
    // FTS via Supabase
    sbClient.from("swarm_tasks").select("*")
      .textSearch("fts",_searchQuery)
      .order("created_at",{ascending:false}).limit(50)
      .then(({data})=>{
        if(data){tasks=data;render();}
      });
  },300);
}

// ── Backlog approve ───────────────────────────────────────────────────────
async function approveTask(id){
  if(!sbClient)return;
  await sbClient.from("swarm_tasks").update({status:"pending"}).eq("id",id).eq("status","backlog");
  showToast(`APPROVED: ${id.slice(0,30)}`,STATUS_META['pending'].color);
  // Refresh
  const{data}=await sbClient.from("swarm_tasks").select("*").order("created_at",{ascending:false}).limit(500);
  if(data){tasks=data;render();}
}

// ── New backlog form ──────────────────────────────────────────────────────
function _populateAgentDropdowns(){
  const real=AGENTS.filter(a=>a!=="all");
  $("backlog-from").innerHTML='<option value="">— select agent —</option>'+real.map(a=>`<option value="${a}">${a.toUpperCase()}</option>`).join("");
  $("backlog-agent").innerHTML='<option value="">— any agent —</option>'+real.map(a=>`<option value="${a}">${a.toUpperCase()}</option>`).join("");
}
function openBacklogForm(){
  _populateAgentDropdowns();
  $("backlog-task").value="";
  $("backlog-context").value="";
  $("backlog-from").value="";
  $("backlog-agent").value="";
  hide("backlog-error");
  $("backlog-submit").disabled=false;
  $("backlog-submit").textContent="ADD TO BACKLOG →";
  $("backlog-overlay").classList.remove("hidden");
  $("backlog-overlay").classList.add("open");
}
function closeBacklogForm(){
  $("backlog-overlay").classList.remove("open");
  $("backlog-overlay").classList.add("hidden");
}
async function submitBacklog(){
  if(!sbClient)return;
  const task=$("backlog-task").value.trim();
  if(!task){
    $("backlog-error").textContent="⚠ Task description is required.";
    show("backlog-error");
    return;
  }
  const fromAgent=$("backlog-from").value;
  if(!fromAgent){
    $("backlog-error").textContent="⚠ Select an agent identity to submit as.";
    show("backlog-error");
    return;
  }
  hide("backlog-error");
  $("backlog-submit").disabled=true;
  $("backlog-submit").textContent="ADDING…";
  const context=$("backlog-context").value.trim();
  const agent=$("backlog-agent").value.trim();
  const row={
    id:crypto.randomUUID(),
    status:"backlog",
    task:task,
    slug:task,
    from_agent:fromAgent,
    to_agent:agent||"any",
    context:context||"",
    result:"",
    created_at:new Date().toISOString()
  };
  const{error}=await sbClient.from("swarm_tasks").insert(row);
  if(error){
    $("backlog-error").textContent="⚠ "+error.message;
    show("backlog-error");
    $("backlog-submit").disabled=false;
    $("backlog-submit").textContent="ADD TO BACKLOG →";
    return;
  }
  showToast("BACKLOG ADDED",STATUS_META['backlog'].color);
  closeBacklogForm();
  const{data}=await sbClient.from("swarm_tasks").select("*").order("created_at",{ascending:false}).limit(500);
  if(data){tasks=data;render();}
}
$("backlog-add-btn").addEventListener("click",openBacklogForm);
$("backlog-cancel").addEventListener("click",closeBacklogForm);
$("backlog-overlay").addEventListener("click",e=>{if(e.target===$("backlog-overlay"))closeBacklogForm();});
$("backlog-submit").addEventListener("click",submitBacklog);

function buildAgentFilters(){
  $("agent-filters").innerHTML=AGENTS.map(a=>
    `<button class="filt-btn ${a===agentFilter?"active":""}" onclick="setAgent('${a}')">${AGENT_LABELS[a]}</button>`
  ).join("");
}
function setStatus(s){statusFilter=(statusFilter===s)?"all":s;render();}

// ── Cost panel ────────────────────────────────────────────────────────────
let _costDays=7;
let _costOpen=false;

function toggleCostPanel(){
  _costOpen=!_costOpen;
  const panel=$('cost-panel');
  if(_costOpen){panel.classList.add('open');renderCost();}
  else panel.classList.remove('open');
}

function setCostDays(d){
  _costDays=d;
  document.querySelectorAll('.cost-filters button').forEach(b=>b.classList.remove('active'));
  const id=d===0?'cost-all':d===1?'cost-1d':d===7?'cost-7d':'cost-30d';
  $(id).classList.add('active');
  renderCost();
}

function renderCost(){
  if(!tasks.length)return;
  // Filter tasks with cost
  let costed=tasks.filter(t=>(t.cost_usd||0)>0);
  if(_costDays>0){
    const cutoff=Date.now()-_costDays*86400000;
    costed=costed.filter(t=>new Date(t.created_at).getTime()>cutoff);
  }

  // Total
  const total=costed.reduce((s,t)=>s+(t.cost_usd||0),0);
  $('cost-total').textContent='$'+total.toFixed(4);
  const label=_costDays===0?'ALL TIME':_costDays===1?'TODAY':'LAST '+_costDays+' DAYS';
  $('cost-period').textContent=label+' / '+costed.length+' TASKS';

  // Group by day
  const byDay={};
  costed.forEach(t=>{
    const d=t.created_at?t.created_at.slice(0,10):'?';
    if(!byDay[d])byDay[d]={cost:0,tasks:0};
    byDay[d].cost+=(t.cost_usd||0);
    byDay[d].tasks++;
  });
  const days=Object.entries(byDay).sort((a,b)=>a[0].localeCompare(b[0]));
  const maxCost=Math.max(...days.map(([,v])=>v.cost),0.01);

  // Render bars
  $('cost-graph').innerHTML=days.map(([day,v])=>{
    const pct=Math.max(4,Math.round(v.cost/maxCost*100));
    const short=day.slice(5); // MM-DD
    return`<div class="cost-bar-wrap">
      <div class="cost-bar-value">$${v.cost.toFixed(2)}</div>
      <div class="cost-bar" style="height:${pct}%"></div>
      <div class="cost-bar-label">${short}</div>
    </div>`;
  }).join('')||'<div style="color:var(--text3);font-size:11px;padding:20px">No cost data in this period</div>';

  // By agent
  const byAgent={};
  costed.forEach(t=>{
    const a=t.to_agent||'?';
    if(!byAgent[a])byAgent[a]={cost:0,tasks:0};
    byAgent[a].cost+=(t.cost_usd||0);
    byAgent[a].tasks++;
  });
  $('cost-agents').innerHTML=Object.entries(byAgent)
    .sort((a,b)=>b[1].cost-a[1].cost)
    .map(([a,v])=>`<div class="cost-agent">${a}: <span>$${v.cost.toFixed(4)}</span> (${v.tasks})</div>`)
    .join('');
}
function setAgent(a){agentFilter=a;buildAgentFilters();render();}
function buildTimeFilters(){
  $("time-filters").innerHTML=TIME_FILTERS.map(f=>
    `<button class="filt-btn time-btn ${f.key===timeFilter?"active":""}" onclick="setTime('${f.key}')">${f.label}</button>`
  ).join("");
}
function setTime(k){timeFilter=k;buildTimeFilters();render();}

// ── Live clock ─────────────────────────────────────────────────────────────
function startClock(){
  clearInterval(clockTimer);
  clockTimer=setInterval(()=>{
    document.querySelectorAll(".wip-timer[data-taken]").forEach(el=>{
      const taken=el.dataset.taken;if(!taken)return;
      const elapsed=Date.now()-new Date(taken).getTime();
      el.textContent=formatDuration(elapsed);
      const pct=Math.min(99,Math.round(elapsed/TIMEOUT_MS*100));
      const bc=pct>80?"#ff3b6e":pct>50?"#ffaa00":"#b041ff";
      const card=el.closest(".wip-card");
      const bar=card?.querySelector(".wip-bar-fill");
      const lbl=card?.querySelector(".wip-bar-pct");
      if(bar){bar.style.width=pct+"%";bar.style.background=bc;bar.style.boxShadow=`0 0 8px ${bc}88`;}
      if(lbl){lbl.textContent=pct+"% LIMIT";lbl.style.color=pct>80?"#ff3b6e":"var(--text2)";}
    });
  },1000);
}

// ── Screen transitions ────────────────────────────────────────────────────
function showSetup(){if(channel){sbClient?.removeChannel(channel);channel=null;}hide("dashboard");show("setup-screen");}
async function showDashboard(url,key){
  hide("setup-screen");show("dashboard");buildAgentFilters();buildTimeFilters();startClock();
  try{await initSupabase(url,key);}
  catch(e){$("header-err").textContent="⚠ "+e.message;show("header-err");setLive("error","FAILED");}
}

$("connect-btn").addEventListener("click",async()=>{
  const url=$("inp-url").value.trim(),key=$("inp-key").value.trim();
  if(!url||!key)return;
  hide("setup-error");hide("setup-status");
  $("connect-btn").disabled=true;$("connect-btn").textContent="INITIATING…";
  try{
    $("setup-status").textContent="PROBING HIVE…";show("setup-status");
    const res=await fetch(`${url}/rest/v1/swarm_tasks?limit=1&select=id`,
      {headers:{apikey:key,Authorization:`Bearer ${key}`,Accept:"application/json"}});
    if(!res.ok){const b=await res.text();throw new Error(`HTTP ${res.status}: ${b.slice(0,200)}`);}
    saveCreds(url,key);$("setup-status").textContent="LINK ESTABLISHED ✓";
    setTimeout(()=>showDashboard(url,key),400);
  }catch(e){
    $("setup-error").textContent="⚠ "+e.message;show("setup-error");hide("setup-status");
    $("connect-btn").disabled=false;$("connect-btn").textContent="INITIATE LINK →";
  }
});
// Delegated handler for fullscreen buttons inside expanded rows
document.addEventListener("click", e => {
  const btn = e.target.closest(".fullscreen-btn[data-fskey]");
  if(!btn) return;
  e.stopPropagation();
  const d = _fsStore[btn.dataset.fskey];
  if(d) openFullscreen(d.label, d.value, d.taskName);
});
// ── Bookmark storage ──────────────────────────────────────────────────────
const BM_KEY = 'swarm-bookmarks-v1';
let _currentFsData = null; // what's currently open in fullscreen

function bmLoad(){
  try{ return JSON.parse(localStorage.getItem(BM_KEY)||'[]'); }catch{ return []; }
}
function bmSave(list){ localStorage.setItem(BM_KEY, JSON.stringify(list)); }
function bmAdd(label, value, taskName, folder){
  const list = bmLoad();
  const id = 'bm_' + Date.now() + '_' + Math.random().toString(36).slice(2,6);
  list.unshift({id, label, value, taskName: taskName||'', folder: (folder||'').trim()||'Default', savedAt: new Date().toISOString()});
  bmSave(list);
  return id;
}
function bmDelete(id){
  bmSave(bmLoad().filter(b=>b.id!==id));
}
function bmIsBookmarked(value){
  return bmLoad().some(b=>b.value===value);
}

// ── Bookmark panel render ─────────────────────────────────────────────────
function bmRenderPanel(){
  const list = bmLoad();
  const total = $('bm-total');
  total.textContent = list.length ? `${list.length} SAVED` : '';

  const body = $('bm-panel-body');
  if(!list.length){
    body.innerHTML='<div class="bm-empty">NO BOOKMARKS YET.<br>OPEN A RESULT IN FULLSCREEN AND CLICK ☆ BOOKMARK.</div>';
    return;
  }

  // Group by folder
  const folders = {};
  list.forEach(b=>{
    const f = b.folder||'Default';
    if(!folders[f]) folders[f]=[];
    folders[f].push(b);
  });

  // Sort: Default first, rest alphabetical
  const folderNames = Object.keys(folders).sort((a,b)=>{
    if(a==='Default') return -1;
    if(b==='Default') return 1;
    return a.localeCompare(b);
  });

  body.innerHTML = folderNames.map(fname => {
    const items = folders[fname];
    return `<div class="bm-folder">
      <div class="bm-folder-header">
        ▸ ${esc(fname)}
        <span class="bm-folder-count">${items.length} ITEM${items.length!==1?'S':''}</span>
      </div>
      ${items.map(b=>{
        const preview = b.value.replace(/[#*`>\-_\[\]]/g,'').trim().slice(0,100);
        return`<div class="bm-item" data-bmid="${esc(b.id)}">
          <div class="bm-item-left">
            <div class="bm-item-label">${esc(b.label.replace('// ',''))}</div>
            <div class="bm-item-name">${esc(b.taskName||'—')}</div>
            <div class="bm-item-preview">${esc(preview)}${b.value.length>100?'…':''}</div>
            <div class="bm-item-meta">${new Date(b.savedAt).toLocaleString()}</div>
          </div>
          <button class="bm-item-del" data-bmid="${esc(b.id)}" title="Remove bookmark">✕</button>
        </div>`;
      }).join('')}
    </div>`;
  }).join('');
}

function openBmPanel(){
  bmRenderPanel();
  $('bm-panel').classList.add('open');
  document.body.style.overflow='hidden';
}
function closeBmPanel(){
  $('bm-panel').classList.remove('open');
  document.body.style.overflow='';
}

// ── Fullscreen modal ──────────────────────────────────────────────────────
function openFullscreen(label, value, taskName){
  _currentFsData = {label, value, taskName};
  const isMarkdown = looksLikeMarkdown(value);
  $("fs-title").textContent = label.replace('// ','');
  $("fs-task-name").textContent = taskName || '';
  $("fs-body").innerHTML = isMarkdown
    ? `<div class="md-body">${renderMd(value)}</div>`
    : `<div class="fs-raw">${esc(value)}</div>`;
  // Update bookmark button state
  const alreadySaved = bmIsBookmarked(value);
  _updateBmBtn(alreadySaved);
  $("fs-folder-input").value = '';
  $("fs-modal").classList.add("open");
  document.body.style.overflow = "hidden";
}
function closeFullscreen(){
  $("fs-modal").classList.remove("open");
  document.body.style.overflow = "";
  _currentFsData = null;
}
function _updateBmBtn(saved){
  const btn=$("fs-bm-btn");
  if(saved){ btn.textContent='★ SAVED'; btn.classList.add('saved'); }
  else { btn.textContent='☆ BOOKMARK'; btn.classList.remove('saved'); }
}

$("fs-close").addEventListener("click", closeFullscreen);
$("fs-modal").addEventListener("click", e => { if(e.target===$("fs-modal")) closeFullscreen(); });

// Bookmark current fullscreen content
$("fs-bm-btn").addEventListener("click", ()=>{
  if(!_currentFsData) return;
  if(bmIsBookmarked(_currentFsData.value)){
    // Already saved — do nothing (prevent accidental double-save)
    return;
  }
  const folder = $("fs-folder-input").value.trim() || 'Default';
  bmAdd(_currentFsData.label, _currentFsData.value, _currentFsData.taskName, folder);
  bmUpdateHeaderBtn();
  _updateBmBtn(true);
  // Brief flash confirmation
  const btn=$("fs-bm-btn");
  btn.textContent='★ SAVED!';
  setTimeout(()=>{ btn.textContent='★ SAVED'; }, 1200);
});

// Open bookmarks panel from header
$("bm-open-btn").addEventListener("click", openBmPanel);
$("bm-panel-close").addEventListener("click", closeBmPanel);
$("bm-panel").addEventListener("click", e => { if(e.target===$("bm-panel")) closeBmPanel(); });

// Delegated clicks inside bookmark panel: open item or delete
$("bm-panel-body").addEventListener("click", e=>{
  // Delete button
  const delBtn = e.target.closest(".bm-item-del");
  if(delBtn){ e.stopPropagation(); bmDelete(delBtn.dataset.bmid); bmRenderPanel(); bmUpdateHeaderBtn(); return; }
  // Open bookmark in fullscreen
  const item = e.target.closest(".bm-item");
  if(item){
    const id = item.dataset.bmid;
    const bm = bmLoad().find(b=>b.id===id);
    if(bm){ closeBmPanel(); openFullscreen(bm.label, bm.value, bm.taskName); }
  }
});

// ── Confirm disconnect ────────────────────────────────────────────────────
function openConfirm(){
  $("confirm-overlay").classList.add("open");
}
function closeConfirm(){
  $("confirm-overlay").classList.remove("open");
}
$("confirm-cancel").addEventListener("click", closeConfirm);
$("confirm-overlay").addEventListener("click", e => { if(e.target===$("confirm-overlay")) closeConfirm(); });
$("confirm-ok").addEventListener("click", ()=>{
  closeConfirm();
  clearCredsStorage();
  clearInterval(clockTimer);
  showSetup();
});

// ── Global keyboard handler ───────────────────────────────────────────────
document.addEventListener("keydown", e => {
  if(e.key === "Escape"){
    if($("backlog-overlay").classList.contains("open")){ closeBacklogForm(); return; }
    if($("fs-modal").classList.contains("open")){ closeFullscreen(); return; }
    if($("bm-panel").classList.contains("open")){ closeBmPanel(); return; }
    if($("confirm-overlay").classList.contains("open")){ closeConfirm(); return; }
  }
});
$("disconnect-btn").addEventListener("click", openConfirm);

const saved=loadCreds();
setupMarked();
bmUpdateHeaderBtn();
if(saved)showDashboard(saved.url,saved.key);else showSetup();

// ── PWA Install Prompt ────────────────────────────────────────────────────
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const banner = $('pwa-install-banner');
  if(banner) banner.classList.remove('hidden');
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  const banner = $('pwa-install-banner');
  if(banner) banner.classList.add('hidden');
});

// ── PWA Service Worker ──────────────────────────────────────────────────────
if('serviceWorker' in navigator){
  navigator.serviceWorker.register('./sw.js').then(reg=>{
    // Check for updates on open and every hour
    reg.update();
    setInterval(()=>reg.update(),3600000);
    document.addEventListener('visibilitychange',()=>{
      if(!document.hidden) reg.update();
    });
    reg.addEventListener('updatefound',()=>{
      const nw=reg.installing;
      nw.addEventListener('statechange',()=>{
        if(nw.state==='activated'){
          // New version activated — reload for fresh content
          window.location.reload();
        }
      });
    });
  }).catch(err=>console.warn('SW registration failed:',err));
}
