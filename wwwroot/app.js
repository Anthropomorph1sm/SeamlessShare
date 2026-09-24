const root = document.querySelector('#app');
const toastEl = document.querySelector('#toast');
const s = {
  session: null, devices: [], items: [], counts: { public: 0, inbox: 0, sent: 0 },
  view: 'public', query: '', layout: matchMedia('(max-width: 650px)').matches ? 'list' : 'canvas',
  zoom: 1, tx: 0, ty: 0, modal: null, audience: 'public', files: [], selectedRecipients: [],
  draftText: '', draftTitle: '', admin: null, adminDevices: [], adminItems: [], adminAudit: [], storage: null,
  uploads: 0, online: navigator.onLine, older: [], more: false, pageKey: '',
  selectedId: null, selectedIds: new Set(), contextMenu: null, composePosition: null
};
const date = value => value ? new Date(value).toLocaleString(undefined, {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
const bytes = value => value >= 1e9 ? (value/1e9).toFixed(2)+' GB' : value >= 1e6 ? (value/1e6).toFixed(1)+' MB' : value >= 1e3 ? (value/1e3).toFixed(1)+' KB' : value+' B';
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const selfId = () => s.session?.device?.id;
const isApproved = () => s.session?.device?.status === 'approved';
let toastTimer, refreshTimer, socket, socketRetry;

function toast(message, error = false) {
  toastEl.textContent = message;
  toastEl.className = `visible${error ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.className = '', 3600);
}
async function api(path, options = {}) {
  const headers = {...options.headers};
  if (options.body && !(options.body instanceof Blob) && typeof options.body !== 'string') {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  if (options.method && options.method !== 'GET') headers['X-Share-Request'] = '1';
  const response = await fetch('/api/v1' + path, {...options, headers, credentials:'same-origin'});
  const raw = await response.text();
  let data = null;
  if (raw) {
    try { data = JSON.parse(raw); }
    catch { if (response.ok) throw new Error('The server returned an invalid response.'); }
  }
  if (!response.ok) {
    throw new Error(data?.error || data?.detail || data?.title || `Request failed (${response.status})`);
  }
  return data;
}
async function session() {
  s.session = await api('/session');
  render();
  if (isApproved()) { await refresh(); connect(); }
}
async function refresh() {
  if (!isApproved()) return;
  if (drag || savingPositions) { scheduleRefresh(); return; }
  try {
    const key=s.view+'|'+s.query;
    if(key!==s.pageKey){s.pageKey=key;s.older=[];s.more=false;}
    const [items, devices, publicItems, inboxItems, sentItems] = await Promise.all([
      api('/items/?scope='+s.view+'&q='+encodeURIComponent(s.query)),
      api('/devices/'), api('/items/?scope=public'), api('/items/?scope=inbox'), api('/items/?scope=sent')
    ]);
    const freshIds=new Set(items.map(x=>x.id));
    s.items = [...items,...s.older.filter(x=>!freshIds.has(x.id))]; s.devices = devices;
    const visibleIds=new Set(s.items.map(x=>x.id));
    s.selectedIds=new Set([...s.selectedIds].filter(id=>visibleIds.has(id)));
    if(!s.selectedIds.has(s.selectedId))s.selectedId=[...s.selectedIds][0]||null;
    if(!s.older.length)s.more=items.length===200;
    s.counts = {public: publicItems.length, inbox: inboxItems.length, sent: sentItems.length};
    render();
    for (const item of inboxItems) {
      const mine = item.recipients?.find(x => x.deviceId === selfId());
      if (mine && !mine.availableAt) api(`/items/${item.id}/ack?state=available`, {method:'POST'}).catch(()=>{});
    }
  } catch (error) { toast(error.message, true); }
}
function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 250); }
async function connect() {
  if (!isApproved() || (socket && (socket.readyState === 0 || socket.readyState === 1))) return;
  try {
    const response = await fetch('/hubs/updates/negotiate?negotiateVersion=1', {method:'POST', headers:{'X-Share-Request':'1'}, credentials:'same-origin'});
    if (!response.ok) return;
    const data = await response.json();
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${location.host}/hubs/updates?id=${encodeURIComponent(data.connectionToken)}`);
    socket.onopen = () => socket.send('{"protocol":"json","version":1}\u001e');
    socket.onmessage = event => {
      for (const frame of String(event.data).split('\u001e').filter(Boolean)) {
        try {
          const message = JSON.parse(frame);
          if (message.target === 'changed' || message.target === 'presenceChanged') scheduleRefresh();
          if (message.target === 'statusChanged') checkStatus();
        } catch {}
      }
    };
    socket.onclose = () => { socket = null; clearTimeout(socketRetry); socketRetry = setTimeout(async () => { await checkStatus(); if (isApproved()) connect(); }, 5000); };
  } catch { clearTimeout(socketRetry); socketRetry = setTimeout(connect, 5000); }
}
async function checkStatus() {
  try {
    const latest = await api('/session');
    const previous = s.session?.device?.status;
    s.session = latest;
    if (!isApproved()) { socket?.close(); render(); }
    else if (previous !== 'approved') { render(); await refresh(); connect(); }
  } catch {}
}

function render() {
  if (!s.session) { root.innerHTML = '<div class="full-page"><div class="full-content">CONNECTING TO SEAMLESSSHARE...</div></div>'; return; }
  if (s.modal === 'compose') rememberComposer();
  if (!isApproved()) { renderGate(); return; }
  root.innerHTML = renderShell() + renderModal();
  syncCanvas();
}
function syncCanvas() {
  const grid = root.querySelector('.canvas-grid');
  if (grid) grid.style.transform = `translate(${s.tx}px,${s.ty}px) scale(${s.zoom})`;
  const axis = root.querySelector('.canvas-axis');
  if (axis) axis.textContent = `X ${Math.round(s.tx)} / Y ${Math.round(s.ty)}`;
}
function renderGate() {
  const device = s.session.device;
  const pending = device?.status === 'pending';
  root.innerHTML = `<div class="full-page">
    <div class="full-header"><div class="brand"><span class="brand-mark">▦</span> SEAMLESS/SHARE</div><span class="caps muted">LOCAL NETWORK / SECURE ACCESS</span></div>
    <div class="full-content"><div class="caps mint">// DEVICE ACCESS</div>
      <h1>${pending ? 'Approval pending.' : device ? 'Access unavailable.' : 'Share without friction.'}</h1>
      <p>${pending ? 'Compare this code with the request in the admin dashboard. This page will open automatically once the administrator approves your device.' : device ? 'This browser is no longer approved. Request access again to continue.' : 'Send notes, images and files across your own devices. Your administrator must approve this browser before it can view or share anything.'}</p>
      <div class="form-card">${pending ? `<div class="caps muted">VERIFICATION CODE</div><div class="code-box">${esc(device.code)}</div><div class="subtle">DEVICE: ${esc(device.name)} · ID ${esc(device.id.slice(0,8))}</div><button class="tool-btn" data-action="check-status" style="margin-top:18px">CHECK STATUS ↗</button>` : `<form id="enroll-form"><div class="field"><label for="device-name">Name this device</label><input id="device-name" name="name" autocomplete="off" placeholder="e.g. Living room laptop" required minlength="2" maxlength="60"></div><button class="primary" type="submit">REQUEST ACCESS ↗</button></form>`}</div>
      <p class="subtle" style="margin-top:20px">ADMINISTRATOR? <a href="#" data-action="admin">OPEN DASHBOARD →</a></p>
    </div></div>${renderModal()}`;
}
function renderShell() {
  const online = s.online;
  const total = s.counts[s.view] || 0;
  const title = {public:'PUBLIC BOARD',inbox:'PRIVATE INBOX',sent:'SENT ITEMS'}[s.view];
  const subtitle = {public:'VISIBLE TO ALL APPROVED DEVICES',inbox:'SENT DIRECTLY TO THIS DEVICE',sent:'SHARED FROM THIS DEVICE'}[s.view];
  const layout = s.layout === 'canvas' && !matchMedia('(max-width: 650px)').matches ? 'canvas' : 'list';
  return `<div class="app-shell">
    <header class="topbar"><div class="brand"><span class="brand-mark">▦</span> SEAMLESS/SHARE</div><div class="top-sep"></div><div class="top-desc caps">LOCAL NETWORK / SHARED SPACE</div><div class="top-spacer"></div><div class="top-status caps"><span class="status-dot ${online?'':'offline'}"></span>${online?'CONNECTED':'OFFLINE'}</div><div class="top-device caps">${esc(s.session.device.name)} ▾</div></header>
    <aside class="sidebar"><div class="side-section">WORKSPACE</div>
      ${nav('public','◫','Public board')}${nav('inbox','↓','Private inbox')}${nav('sent','↑','Sent items')}
      <div class="side-rule"></div><div class="side-section">APPROVED DEVICES / ${s.devices.length}</div>
      ${s.devices.map(device => `<div class="device-row"><span class="device-led ${device.connected?'online':''}" title="${device.connected?'Connected':'Offline'}" aria-label="${device.connected?'Connected':'Offline'}"></span>${esc(device.name)}${device.id===selfId()?' / YOU':''}</div>`).join('')}
      <div class="side-bottom"><span class="caps muted">PRIVATE NETWORK ONLY</span><button data-action="admin">ADMIN DASHBOARD ↗</button></div></aside>
    <main class="main"><div class="toolbar"><div class="title-block"><div class="view-title">${title}</div><div class="view-sub caps">${subtitle}</div></div>
      <input class="tool-search" id="search" type="search" value="${esc(s.query)}" placeholder="Search ${s.view}..." aria-label="Search items">
      <div class="spacer"></div><button class="tool-btn view-toggle ${layout==='list'?'active':''}" data-action="layout" data-layout="list" title="List view">≡</button><button class="tool-btn view-toggle ${layout==='canvas'?'active':''}" data-action="layout" data-layout="canvas" title="Canvas view">▦</button>
      <button class="tool-btn primary" data-action="compose">+ NEW SHARE</button></div>
      ${layout==='canvas' ? `<div class="canvas-viewport" id="viewport"><div class="canvas-grid"><div class="canvas-guide caps">+ · · · SEAMLESS SPACE / ${String(total).padStart(3,'0')} ITEMS · · · +</div>${s.items.map((item,index) => note(item,index)).join('')}</div>${s.items.length===0?empty():''}<div class="canvas-axis caps">X ${Math.round(s.tx)} / Y ${Math.round(s.ty)}</div><div class="canvas-actions">${s.more?'<button data-action="older">LOAD OLDER</button>':''}<button data-action="zoom-out" aria-label="Zoom out">−</button><button data-action="zoom-reset">${Math.round(s.zoom*100)}%</button><button data-action="zoom-in" aria-label="Zoom in">+</button></div>${s.contextMenu ? `<div class="canvas-context-menu" role="menu" style="left:${s.contextMenu.x}px;top:${s.contextMenu.y}px"><button role="menuitem" data-action="compose-here">+ ADD SHARE HERE</button></div>` : ''}</div>` : `<div class="list-view">${s.items.length?`<div class="list-grid">${s.items.map((item,index)=>note(item,index)).join('')}</div>${s.more?'<button class="tool-btn" data-action="older" style="margin-top:16px">LOAD OLDER ↓</button>':''}`:empty()}</div>`}
    </main><footer class="statusbar"><span>◉ &nbsp; ${online?'SYSTEM ONLINE':'WAITING FOR NETWORK'}</span><span>${total} ITEMS</span><span id="selection-count">${s.selectedIds.size?`${s.selectedIds.size} SELECTED · DELETE TO REMOVE`:''}</span><span class="right">HTTPS / APPROVED DEVICES ONLY</span></footer>
  </div>`;
}
function nav(view,symbol,label) { return `<button class="nav ${s.view===view?'active':''}" data-action="view" data-view="${view}" title="${label}"><span><span class="nav-symbol">${symbol}</span> &nbsp; ${label}</span><span class="nav-count">${s.counts[view]||0}</span></button>`; }
function empty() { return `<div class="empty"><div class="empty-index">+ · · · 001 / EMPTY SPACE</div><h2>${s.view==='public'?'Nothing on the board yet.':s.view==='inbox'?'No private deliveries yet.':'You haven’t sent anything yet.'}</h2><p>${s.view==='inbox'?'When another approved device shares directly with this one, it will appear here.':'Add a note, image, or file. Choose the public board or specific approved devices.'}</p><button class="primary" data-action="compose">+ CREATE A SHARE</button></div>`; }
function note(item,index) {
  const mine = item.senderId === selfId();
  const text = item.kind === 'text' ? esc(item.text) : '';
  const body = item.kind === 'image' ? `<img src="/api/v1/items/${item.id}/content" loading="lazy" alt="${esc(item.fileName || 'Shared image')}">`
    : item.kind === 'file' ? `<div class="file-glyph">↧</div><div class="file-name">${esc(item.fileName)}</div><div class="file-size">${bytes(item.size)} · CLICK TO DOWNLOAD</div>` : text;
  const foot = item.audience === 'private' ? `<span class="tag private">PRIVATE</span>` : `<span class="tag">PUBLIC</span>`;
  return `<article class="note ${item.audience==='private'?'private-note':''} ${s.selectedIds.has(item.id)?'selected':''}" data-id="${item.id}" tabindex="0" style="left:${item.x}px;top:${item.y}px;width:${item.width}px;height:${item.height}px;z-index:${s.selectedId===item.id?20000:s.selectedIds.has(item.id)?10000+s.items.length-index:s.items.length-index}">
    <div class="note-head" data-drag="${item.id}"><span class="note-kind">${item.kind==='text'?'TXT':item.kind==='image'?'IMG':'FILE'}</span><span class="note-title">${esc(item.title)}</span>${item.pinned?'<span class="note-pin amber" aria-label="Pinned" title="Pinned">✦</span>':''}<button class="note-menu" data-action="detail" data-id="${item.id}" aria-label="Item details">•••</button></div>
    <div class="note-body ${item.kind==='text'?'text-body':item.kind==='image'?'image-body':''}" data-action="copy-item" data-id="${item.id}" title="${item.kind==='text'?'Click to copy':item.kind==='image'?'Click to copy image':'Click to download'}">${body}</div>
    <div class="note-foot">${foot}<span>${esc(item.senderName)}</span><span class="grow"></span><span>${date(item.createdAt)}</span>${item.kind==='image'?`<button class="note-download" data-action="download" data-id="${item.id}" aria-label="Download image" title="Download image">↓</button>`:''}${mine?'<span class="mint">●</span>':''}</div><div class="resize-handle" data-resize="${item.id}"></div>
  </article>`;
}
function renderModal() {
  if (!s.modal) return '';
  if (s.modal === 'compose') return composeModal();
  if (s.modal === 'admin') return adminModal();
  if (s.modal.startsWith('detail:')) return detailModal(s.items.find(x => x.id === s.modal.slice(7)));
  if (s.modal.startsWith('edit:')) return editModal(s.items.find(x => x.id === s.modal.slice(5)));
  return '';
}
function frame(title, body, footer='', wide=false) { return `<div class="overlay" data-overlay="1"><section class="dialog ${wide?'wide':''}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="dialog-head"><h2>${esc(title)}</h2><button data-action="close-modal" aria-label="Close">×</button></div><div class="dialog-body">${body}</div>${footer?`<div class="dialog-foot">${footer}</div>`:''}</section></div>`; }
function composeModal() {
  const targets = s.audience === 'private' ? `<div class="field"><label>Send to approved devices</label><div class="recipient-list">${s.devices.filter(x=>x.id!==selfId()).map(x=>`<label class="recipient-choice"><input type="checkbox" name="recipient" value="${x.id}" ${s.selectedRecipients.includes(x.id)?'checked':''}>${esc(x.name)}</label>`).join('')||'<span class="muted">Approve another device first.</span>'}</div></div>` : '';
  const uploads = s.files.length ? s.files.map(file=>`<div>↥ ${esc(file.name)} · ${bytes(file.size)}</div>`).join('') : 'DROP FILES HERE OR CHOOSE FROM THIS DEVICE';
  const body = `<form id="compose-form"><div class="caps mint" style="margin-bottom:14px">// NEW TRANSMISSION</div><div class="toggle-row"><button type="button" class="${s.audience==='public'?'active':''}" data-action="audience" data-audience="public">◫ PUBLIC BOARD</button><button type="button" class="${s.audience==='private'?'active':''}" data-action="audience" data-audience="private">↗ PRIVATE DELIVERY</button></div>${targets}
    <div class="field"><label for="share-title">Title / optional</label><input id="share-title" name="title" maxlength="120" value="${esc(s.draftTitle)}" placeholder="A short label for this share"></div>
    <div class="field"><label for="share-text">Text or link</label><textarea id="share-text" name="text" placeholder="Write something, paste a link, or leave blank to share files...">${esc(s.draftText)}</textarea></div>
    <div class="field"><label for="share-files">Images and files</label><input id="share-files" name="files" type="file" multiple><div class="upload-list" id="upload-list">${uploads}</div><div id="upload-progress-label" class="subtle"></div><div class="upload-progress"><span id="upload-progress"></span></div></div>
    <div class="subtle">Items expire after 7 days unless pinned. Files are stored on your home server.</div></form>`;
  return frame('Create share',body,`<button data-action="close-modal">CANCEL</button><button class="primary" type="submit" form="compose-form" ${s.uploads?'disabled':''}>${s.uploads?'UPLOADING...':'SHARE NOW ↗'}</button>`);
}
function detailModal(item) {
  if (!item) return frame('Item unavailable','<p>This item has been removed or expired.</p>');
  const mine = item.senderId===selfId();
  const delivery = item.audience==='private' ? `<div class="field"><label>Delivery</label>${item.recipients.map(r=>`<div class="admin-row"><span class="grow">${esc(s.devices.find(d=>d.id===r.deviceId)?.name||r.deviceId.slice(0,8))}</span><span class="${r.openedAt?'mint':r.availableAt?'amber':'muted'}">${r.openedAt?'OPENED':r.availableAt?'AVAILABLE':'QUEUED'}</span></div>`).join('')}</div>` : '';
  const content = item.kind==='text'?`<div class="detail-text">${esc(item.text)}</div>`:item.kind==='image'?`<img style="width:100%;max-height:40vh;object-fit:contain;background:#0b0d0c" src="/api/v1/items/${item.id}/content" alt="${esc(item.fileName)}">`:`<div class="detail-text">${esc(item.fileName)} · ${bytes(item.size)}</div>`;
  return frame(item.title,`<div class="subtle" style="margin-bottom:13px">${esc(item.kind.toUpperCase())} · FROM ${esc(item.senderName)} · ${date(item.createdAt)} · ${item.pinned?'PINNED':'EXPIRES '+date(item.expiresAt)}</div>${content}${delivery}`,`<button data-action="close-modal">CLOSE</button>${item.kind==='text'?`<button data-action="copy-item" data-id="${item.id}">COPY TEXT</button>`:`<button data-action="download" data-id="${item.id}">DOWNLOAD ↧</button>`}${mine?`<button data-action="pin" data-id="${item.id}">${item.pinned?'UNPIN':'PIN'}</button>${item.kind==='text'?`<button data-action="edit" data-id="${item.id}">EDIT</button>`:''}<button class="red" data-action="delete" data-id="${item.id}">DELETE</button>`:''}`);
}
function editModal(item) {
  if (!item) return '';
  return frame('Edit text note',`<form id="edit-form" data-id="${item.id}" data-revision="${item.revision}"><div class="field"><label>Title</label><input name="title" maxlength="120" value="${esc(item.title)}"></div><div class="field"><label>Text</label><textarea name="text" required maxlength="100000">${esc(item.text)}</textarea></div></form>`,`<button data-action="close-modal">CANCEL</button><button class="primary" type="submit" form="edit-form">SAVE CHANGES</button>`);
}
function adminModal() {
  const auth = s.admin;
  if (!auth?.authenticated) {
    const setup = auth?.setupRequired;
    return frame(setup?'Initial admin setup':'Admin login',`<p class="subtle">${setup?'Get the one-time setup token from the server console or data/setup-token file.':'Enter the administrator password.'}</p><form id="admin-auth-form">${setup?'<div class="field"><label>Setup token</label><input name="token" autocomplete="off" required></div>':''}<div class="field"><label>Admin password ${setup?'(12+ characters)':''}</label><input name="password" type="password" autocomplete="current-password" minlength="${setup?12:1}" required></div></form>`,`<button data-action="close-modal">CANCEL</button><button type="submit" form="admin-auth-form" class="primary">${setup?'COMPLETE SETUP':'SIGN IN'}</button>`);
  }
  const pending = s.adminDevices.filter(x=>x.status==='pending');
  const approved = s.adminDevices.filter(x=>x.status==='approved');
  const other = s.adminDevices.filter(x=>x.status==='rejected'||x.status==='revoked');
  const deviceRow = d => `<div class="admin-row"><span class="grow"><strong>${esc(d.name)}</strong><small>${d.status.toUpperCase()} · ${esc(d.id.slice(0,8))} · ${d.lastSeenAt?'SEEN '+date(d.lastSeenAt):'NEVER SEEN'}</small></span>${d.status==='pending'?`<span class="admin-code">${esc(d.code)}</span><button class="mint" data-action="decide" data-id="${d.id}" data-status="approved">APPROVE</button><button data-action="decide" data-id="${d.id}" data-status="rejected">REJECT</button>`:d.status==='approved'?`<button data-action="rename" data-id="${d.id}">RENAME</button><button class="red" data-action="decide" data-id="${d.id}" data-status="revoked">REVOKE</button>`:`<button data-action="decide" data-id="${d.id}" data-status="approved">APPROVE</button>`}</div>`;
  const used = s.storage?.usedBytes||0, max=s.storage?.maxTotalBytes||1;
  return frame('Admin dashboard',`<div class="admin-grid">
    <div><div class="admin-panel"><h3>PENDING REQUESTS / ${pending.length}</h3>${pending.map(deviceRow).join('')||'<div class="subtle">No pending devices.</div>'}</div><div class="admin-panel" style="margin-top:16px"><h3>APPROVED DEVICES / ${approved.length}</h3>${approved.map(deviceRow).join('')||'<div class="subtle">No approved devices.</div>'}</div>${other.length?`<div class="admin-panel" style="margin-top:16px"><h3>REJECTED / REVOKED</h3>${other.map(deviceRow).join('')}</div>`:''}</div>
    <div><div class="admin-panel"><h3>SERVER STORAGE</h3><div class="admin-stat">${bytes(used)}</div><div class="subtle">${bytes(max)} LIMIT · ${Math.round(100*used/max)}% USED</div><div class="upload-progress"><span style="width:${Math.min(100,100*used/max)}%"></span></div><form id="settings-form" style="margin-top:14px"><div class="field"><label>Max file size / MB · up to 1000</label><input name="maxFileMb" type="number" min="10" max="1000" value="${Math.round((s.storage?.maxFileBytes||1e9)/1e6)}"></div><div class="field"><label>Total storage / GB · up to 1000</label><input name="maxTotalGb" type="number" min="1" max="1000" value="${Math.round((s.storage?.maxTotalBytes||20e9)/1e9)}"></div><div class="field"><label>Retention / days</label><input name="retentionDays" type="number" min="1" max="365" value="${s.storage?.retentionDays||7}"></div><button type="submit">SAVE SETTINGS</button></form></div>
      <div class="admin-panel" style="margin-top:16px"><h3>RECENT ITEMS / STORAGE MANAGEMENT</h3>${s.adminItems.slice(0,12).map(item=>`<div class="admin-row"><span class="grow"><strong>${esc(item.title)}</strong><small>${item.audience.toUpperCase()} · ${bytes(item.size)} · ${date(item.createdAt)}</small></span><button class="red" data-action="admin-delete" data-id="${item.id}">REMOVE</button></div>`).join('')||'<div class="subtle">No items.</div>'}</div><div class="admin-panel" style="margin-top:16px"><h3>ADMINISTRATIVE AUDIT</h3>${s.adminAudit.slice(0,12).map(entry=>`<div class="admin-row"><span class="grow"><strong>${esc(entry.action.replaceAll('_',' ').toUpperCase())}</strong><small>${esc(entry.detail)} · ${date(entry.at)}</small></span></div>`).join('')||'<div class="subtle">No activity.</div>'}</div></div></div>`,`<button data-action="admin-logout">LOG OUT</button><button data-action="close-modal" class="primary">DONE</button>`,true);
}

async function openAdmin() {
  s.admin = await api('/admin/session');
  s.modal = 'admin';
  if (s.admin.authenticated) await loadAdmin();
  render();
}
async function loadAdmin() {
  const [devices, items, storage, audit] = await Promise.all([api('/admin/devices'),api('/admin/items'),api('/admin/storage'),api('/admin/audit')]);
  s.adminDevices=devices;s.adminItems=items;s.storage=storage;s.adminAudit=audit;
}
function closeModal() { s.modal=null; s.files=[]; s.draftText=''; s.draftTitle=''; s.composePosition=null; render(); }

async function placeCreated(item,index=0) {
  if (!item?.id) return;
  focusNote(item.id);
  if (!s.composePosition) return;
  const x = Math.max(-20000,Math.min(20000,Math.round(s.composePosition.x + index*26)));
  const y = Math.max(-20000,Math.min(20000,Math.round(s.composePosition.y + index*26)));
  await api(`/items/${item.id}/position`,{method:'PUT',body:{x,y,width:item.width||310,height:item.height||220}});
}

function setSelection(ids,activeId=null) {
  s.selectedIds = ids;
  s.selectedId = activeId && ids.has(activeId) ? activeId : [...ids][0] || null;
  const order = new Map(s.items.map((item,index) => [item.id,s.items.length-index]));
  for (const note of root.querySelectorAll('.note')) {
    const selected = ids.has(note.dataset.id);
    note.classList.toggle('selected',selected);
    note.style.zIndex = String(note.dataset.id === s.selectedId ? 20000 : selected ? 10000+(order.get(note.dataset.id)||1) : order.get(note.dataset.id)||1);
  }
  const count = root.querySelector('#selection-count');
  if (count) count.textContent = ids.size ? `${ids.size} SELECTED · DELETE TO REMOVE` : '';
}
function focusNote(id,additive=false) {
  const ids = additive ? new Set(s.selectedIds) : new Set();
  if (id) { if (additive && ids.has(id)) ids.delete(id); else ids.add(id); }
  setSelection(ids, id);
}
async function deleteSelected() {
  const selected=s.items.filter(item=>s.selectedIds.has(item.id));
  const owned=selected.filter(item=>item.senderId===selfId());
  if (!owned.length) { toast('Only shares sent from this device can be deleted.',true); return; }
  const prompt=owned.length===1 ? `Delete "${owned[0].title}" for everyone?` : `Delete ${owned.length} selected shares for everyone?`;
  if (!confirm(prompt)) return;
  let deleted=0;
  for (const item of owned) {
    try { await api(`/items/${item.id}`,{method:'DELETE'});deleted++; }
    catch(error) { handleError(error); }
  }
  setSelection(new Set());
  await refresh();
  if (deleted) toast(`Deleted ${deleted} ${deleted===1?'share':'shares'}.${selected.length>owned.length?' Shares from other devices were skipped.':''}`);
}

async function imageAsPng(item) {
  const response = await fetch(`/api/v1/items/${item.id}/content`,{credentials:'same-origin',cache:'no-store'});
  if (!response.ok) throw new Error('Image could not be loaded.');
  const blob = await response.blob();
  if (blob.type === 'image/png') return blob;
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext('2d').drawImage(image,0,0);
    return await new Promise((resolve,reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Image conversion failed.')),'image/png'));
  } finally { URL.revokeObjectURL(url); }
}

async function copyItem(item) {
  if (item.kind === 'text') {
    try { await navigator.clipboard.writeText(item.text); toast('Text copied to clipboard.'); }
    catch { s.modal='detail:'+item.id; render(); toast('Select and copy the text in the detail view.',true); }
    return;
  }
  if (item.kind === 'image') {
    try {
      if (!window.ClipboardItem || !navigator.clipboard?.write) throw new Error();
      await navigator.clipboard.write([new ClipboardItem({'image/png':imageAsPng(item)})]);
      toast('Image copied to clipboard.'); return;
    } catch { toast('Image copy is unavailable here. Use the download button.',true); }
    return;
  }
  download(item);
}
function download(item) {
  const a=document.createElement('a');a.href=`/api/v1/items/${item.id}/content?download=true`;a.download=item.fileName||'download';document.body.append(a);a.click();a.remove();
}
function rememberComposer() {
  if(s.modal!=='compose')return;
  s.draftTitle=document.querySelector('#share-title')?.value||'';
  s.draftText=document.querySelector('#share-text')?.value||'';
  s.selectedRecipients=[...document.querySelectorAll('input[name="recipient"]:checked')].map(x=>x.value);
}
async function uploadFile(file,audience,recipients) {
  if(file.size>1e9)throw new Error(`${file.name} exceeds 1 GB.`);
  const query=new URLSearchParams({audience});recipients.forEach(id=>query.append('recipient',id));
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();
    xhr.open('POST','/api/v1/items/upload?'+query);
    xhr.withCredentials=true;
    xhr.setRequestHeader('X-Share-Request','1');
    xhr.setRequestHeader('X-File-Name',encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type',file.type||'application/octet-stream');
    xhr.upload.onprogress=e=>{
      const percentage=e.lengthComputable?Math.round(100*e.loaded/e.total):0;
      const bar=document.querySelector('#upload-progress');if(bar)bar.style.width=percentage+'%';
      const label=document.querySelector('#upload-progress-label');if(label)label.textContent=`UPLOADING ${file.name} · ${percentage}%`;
    };
    xhr.onload=()=>{
      if(xhr.status>=200&&xhr.status<300){try{resolve(xhr.responseText?JSON.parse(xhr.responseText):null)}catch{resolve(null)}}
      else {let message=`Upload failed (${xhr.status})`;try{let data=JSON.parse(xhr.responseText);message=data.error||data.detail||message}catch{}reject(new Error(message));}
    };
    xhr.onerror=()=>reject(new Error('Upload connection failed. Retry from the beginning.'));
    xhr.send(file);
  });
}
function handleError(error) { toast(error.message||String(error),true); }

document.addEventListener('click', async event => {
  const trigger=event.target.closest('[data-action]');
  if(!trigger)return;
  event.preventDefault();
  const action=trigger.dataset.action,id=trigger.dataset.id;
  try {
    if(action==='close-modal'){closeModal();return;}
    if(action==='check-status'){await checkStatus();return;}
    if(action==='admin'){await openAdmin();return;}
    if(action==='compose'||action==='compose-here'){
      s.composePosition=action==='compose-here'&&s.contextMenu?{x:s.contextMenu.boardX,y:s.contextMenu.boardY}:null;
      s.contextMenu=null;s.modal='compose';s.audience='public';s.selectedRecipients=[];render();return;
    }
    if(action==='audience'){rememberComposer();s.audience=trigger.dataset.audience;if(s.audience==='public')s.selectedRecipients=[];render();return;}
    if(action==='view'){s.view=trigger.dataset.view;s.query='';setSelection(new Set());s.contextMenu=null;await refresh();return;}
    if(action==='older'){
      const oldest=s.items.at(-1);if(!oldest)return;
      const page=await api('/items/?scope='+s.view+'&q='+encodeURIComponent(s.query)+'&before='+encodeURIComponent(oldest.createdAt));
      const seen=new Set(s.items.map(x=>x.id));s.older.push(...page.filter(x=>!seen.has(x.id)));
      s.items.push(...page.filter(x=>!seen.has(x.id)));s.more=page.length===200;render();return;
    }
    if(action==='layout'){s.layout=trigger.dataset.layout;render();return;}
    if(action==='zoom-in'||action==='zoom-out'||action==='zoom-reset'){s.zoom=action==='zoom-reset'?1:Math.max(.5,Math.min(1.7,s.zoom+(action==='zoom-in'?.1:-.1)));render();return;}
    if(action==='detail'){const item=s.items.find(x=>x.id===id);if(item?.audience==='private'&&item.senderId!==selfId())api(`/items/${id}/ack?state=opened`,{method:'POST'}).catch(()=>{});s.modal='detail:'+id;render();return;}
    if(action==='edit'){s.modal='edit:'+id;render();return;}
    if(action==='copy-item'){if(event.ctrlKey||event.metaKey||event.shiftKey)return;const item=s.items.find(x=>x.id===id);if(item){focusNote(id);await copyItem(item)}return;}
    if(action==='download'){const item=s.items.find(x=>x.id===id);if(item)download(item);return;}
    if(action==='pin'){const item=s.items.find(x=>x.id===id);await api(`/items/${id}/pin`,{method:'PUT',body:{pinned:!item.pinned}});s.modal=null;await refresh();return;}
    if(action==='delete'){if(!confirm('Delete this item for everyone?'))return;await api(`/items/${id}`,{method:'DELETE'});s.modal=null;await refresh();toast('Item deleted.');return;}
    if(action==='decide'){await api(`/admin/devices/${id}/decision`,{method:'POST',body:{status:trigger.dataset.status}});await loadAdmin();render();toast('Device status updated.');return;}
    if(action==='rename'){const device=s.adminDevices.find(x=>x.id===id),name=prompt('New device name',device?.name||'');if(!name)return;await api(`/admin/devices/${id}`,{method:'PATCH',body:{name}});await loadAdmin();render();return;}
    if(action==='admin-delete'){if(!confirm('Remove this item from the server?'))return;await api(`/admin/items/${id}`,{method:'DELETE'});await loadAdmin();render();return;}
    if(action==='admin-logout'){await api('/admin/logout',{method:'POST'});s.admin={authenticated:false,setupRequired:false};render();return;}
  } catch(error){handleError(error);}
});
document.addEventListener('submit', async event=>{
  const form=event.target;if(!['enroll-form','compose-form','edit-form','admin-auth-form','settings-form'].includes(form.id))return;
  event.preventDefault();
  const submit=form.querySelector('button[type=submit]')||document.querySelector(`button[form="${form.id}"]`);
  if(submit)submit.disabled=true;
  try {
    const data=new FormData(form);
    if(form.id==='enroll-form'){await api('/enroll',{method:'POST',body:{name:data.get('name')}});await session();toast('Request sent to the administrator.');}
    if(form.id==='admin-auth-form'){
      const setup=s.admin?.setupRequired;
      await api(setup?'/admin/setup':'/admin/login',{method:'POST',body:setup?{token:data.get('token'),password:data.get('password')}:{password:data.get('password')}});
      await openAdmin();toast('Administrator authenticated.');
    }
    if(form.id==='settings-form'){
      await api('/admin/storage',{method:'PUT',body:{maxFileBytes:Number(data.get('maxFileMb'))*1e6,maxTotalBytes:Number(data.get('maxTotalGb'))*1e9,retentionDays:Number(data.get('retentionDays'))}});
      await loadAdmin();render();toast('Storage settings saved.');
    }
    if(form.id==='edit-form'){
      await api(`/items/${form.dataset.id}/text`,{method:'PATCH',body:{title:data.get('title'),text:data.get('text'),revision:Number(form.dataset.revision)}});
      s.modal=null;await refresh();toast('Note saved.');
    }
    if(form.id==='compose-form'){
      rememberComposer();const text=s.draftText.trim(),files=[...s.files],recipients=[...s.selectedRecipients];
      if(!text&&!files.length)throw new Error('Write a note or choose a file.');
      if(s.audience==='private'&&!recipients.length)throw new Error('Choose a recipient device.');
      let created=0;
      if(text){const item=await api('/items/text',{method:'POST',body:{text,title:s.draftTitle,audience:s.audience,recipients}});await placeCreated(item,created++);}
      s.uploads=files.length;
      for(const file of files){const item=await uploadFile(file,s.audience,recipients);await placeCreated(item,created++);}
      s.uploads=0;closeModal();await refresh();toast('Shared successfully.');
    }
  }catch(error){s.uploads=0;handleError(error);if(submit)submit.disabled=false;}
});
document.addEventListener('change', event=>{
  if(event.target.id==='share-files'){
    rememberComposer();s.files=[...event.target.files];
    const list=document.querySelector('#upload-list');if(list)list.innerHTML=s.files.length?s.files.map(f=>`<div>↥ ${esc(f.name)} · ${bytes(f.size)}</div>`).join(''):'DROP FILES HERE OR CHOOSE FROM THIS DEVICE';
  }
});
document.addEventListener('input',event=>{
  if(event.target.id==='search'){
    s.query=event.target.value;
    clearTimeout(refreshTimer);
    refreshTimer=setTimeout(async()=>{const input=document.querySelector('#search');const start=input?.selectionStart;await refresh();const next=document.querySelector('#search');next?.focus();if(start!=null)next?.setSelectionRange(start,start);},350);
  }
});
let spaceHeld=false, lastPointerSelection=0;
document.addEventListener('keydown',event=>{
  const editing=event.target instanceof Element && !!event.target.closest('input,textarea,[contenteditable]');
  if(event.code==='Space'&&!editing&&!s.modal){spaceHeld=true;if(s.layout==='canvas')event.preventDefault();}
  if((event.key==='Delete'||event.key==='Backspace')&&!editing&&!s.modal&&isApproved()&&!event.repeat&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&s.selectedIds.size){
    event.preventDefault();deleteSelected().catch(handleError);return;
  }
  if(event.key!=='Escape')return;
  if(s.modal)closeModal();
  else if(s.contextMenu){s.contextMenu=null;root.querySelector('.canvas-context-menu')?.remove();}
  else if(s.selectedIds.size)setSelection(new Set());
});
document.addEventListener('keyup',event=>{if(event.code==='Space')spaceHeld=false;});
window.addEventListener('blur',()=>{spaceHeld=false;});
document.addEventListener('click',event=>{if(event.target.matches('[data-overlay]'))closeModal();});
document.addEventListener('focusin',event=>{const note=event.target.closest?.('.note');if(note&&performance.now()-lastPointerSelection>300)focusNote(note.dataset.id);});
document.addEventListener('contextmenu',event=>{
  if(!isApproved()||s.modal||s.view!=='public'||s.layout!=='canvas')return;
  const viewport=event.target.closest?.('#viewport');
  if(!viewport||event.target.closest('.note,.canvas-actions,.canvas-context-menu'))return;
  event.preventDefault();
  const rect=viewport.getBoundingClientRect();
  const px=event.clientX-rect.left,py=event.clientY-rect.top;
  s.contextMenu={
    x:Math.max(4,Math.min(px,rect.width-185)),
    y:Math.max(4,Math.min(py,rect.height-48)),
    boardX:(px-s.tx)/s.zoom,boardY:(py-s.ty)/s.zoom
  };
  render();
});

let drag=null,savingPositions=false;
let middlePastePending=false,middlePasteTimer;
document.addEventListener('pointerdown',event=>{
  if(event.button===1){middlePastePending=true;clearTimeout(middlePasteTimer);}
},true);
document.addEventListener('mousedown',event=>{if(event.button===1)event.preventDefault();},true);
document.addEventListener('pointerup',event=>{
  if(event.button===1){clearTimeout(middlePasteTimer);middlePasteTimer=setTimeout(()=>{middlePastePending=false;},0);}
},true);
document.addEventListener('auxclick',event=>{
  if(event.button===1){event.preventDefault();clearTimeout(middlePasteTimer);middlePasteTimer=setTimeout(()=>{middlePastePending=false;},0);}
},true);
document.addEventListener('paste',event=>{
  if(middlePastePending){event.preventDefault();event.stopImmediatePropagation();}
},true);
window.addEventListener('blur',()=>{middlePastePending=false;clearTimeout(middlePasteTimer);});
document.addEventListener('wheel',event=>{
  const viewport=event.target.closest?.('#viewport');
  if(!viewport||s.modal)return;
  event.preventDefault();
  const factor=event.deltaMode===1?20:event.deltaMode===2?viewport.clientHeight:1;
  if(event.shiftKey)s.tx-=(event.deltaX||event.deltaY)*factor;
  else{s.tx-=event.deltaX*factor;s.ty-=event.deltaY*factor;}
  syncCanvas();
},{passive:false});
document.addEventListener('pointerdown',event=>{
  if(s.contextMenu&&!event.target.closest('.canvas-context-menu')){
    s.contextMenu=null;root.querySelector('.canvas-context-menu')?.remove();
  }
  const selected=event.target.closest('.note');
  if(selected){
    lastPointerSelection=performance.now();
    const additive=event.ctrlKey||event.metaKey||event.shiftKey;
    const groupDrag=event.button===0&&!additive&&s.selectedIds.size>1&&s.selectedIds.has(selected.dataset.id)&&
      event.target.closest('[data-drag]')&&!event.target.closest('button');
    if(groupDrag)setSelection(new Set(s.selectedIds),selected.dataset.id);
    else focusNote(selected.dataset.id,additive);
  }
  else if(event.target.closest('#viewport')&&!event.target.closest('button')&&event.button===0&&!event.ctrlKey&&!event.metaKey&&!spaceHeld)focusNote(null);
  if(s.layout!=='canvas'||matchMedia('(max-width:650px)').matches)return;
  const resize=event.target.closest('[data-resize]'),head=event.target.closest('[data-drag]'),viewport=event.target.closest('#viewport');
  if((resize||head)&&!event.target.closest('button')&&event.button===0&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey){
    const note=event.target.closest('.note');if(!note)return;
    const members=resize?[note]:[...root.querySelectorAll('.canvas-grid .note')].filter(card=>s.selectedIds.has(card.dataset.id));
    drag={type:resize?'resize':'note',members:members.map(card=>({el:card,id:card.dataset.id,x:parseFloat(card.style.left),y:parseFloat(card.style.top),w:parseFloat(card.style.width),h:parseFloat(card.style.height)})),startX:event.clientX,startY:event.clientY,moved:false};
    event.target.setPointerCapture(event.pointerId);event.preventDefault();
  }else if(viewport&&!event.target.closest('.note')&&!event.target.closest('button')&&(event.button===0||event.button===1)){
    if(event.pointerType==='touch'||event.button===1||spaceHeld){
      drag={type:'pan',startX:event.clientX,startY:event.clientY,x:s.tx,y:s.ty};
    }else{
      const rect=viewport.getBoundingClientRect();
      const x=Math.max(0,Math.min(rect.width,event.clientX-rect.left));
      const y=Math.max(0,Math.min(rect.height,event.clientY-rect.top));
      const box=document.createElement('div');box.className='canvas-selection-box';
      viewport.append(box);
      drag={type:'select',viewport,box,startX:x,startY:y,base:event.ctrlKey||event.metaKey?new Set(s.selectedIds):new Set()};
    }
    viewport.setPointerCapture(event.pointerId);event.preventDefault();
  }
});
document.addEventListener('pointermove',event=>{
  if(!drag)return;
  if(drag.type==='select'){
    const rect=drag.viewport.getBoundingClientRect();
    const x=Math.max(0,Math.min(rect.width,event.clientX-rect.left));
    const y=Math.max(0,Math.min(rect.height,event.clientY-rect.top));
    const left=Math.min(drag.startX,x),top=Math.min(drag.startY,y),width=Math.abs(x-drag.startX),height=Math.abs(y-drag.startY);
    Object.assign(drag.box.style,{left:left+'px',top:top+'px',width:width+'px',height:height+'px'});
    if(width+height>4){
      const ids=new Set(drag.base);
      for(const note of drag.viewport.querySelectorAll('.note')){
        const card=note.getBoundingClientRect();
        if(card.right>rect.left+left&&card.left<rect.left+left+width&&card.bottom>rect.top+top&&card.top<rect.top+top+height)ids.add(note.dataset.id);
      }
      setSelection(ids,[...ids][0]);
    }
    return;
  }
  const dx=event.clientX-drag.startX,dy=event.clientY-drag.startY;
  if(Math.abs(dx)+Math.abs(dy)>2)drag.moved=true;
  if(drag.type==='pan'){s.tx=drag.x+dx;s.ty=drag.y+dy;syncCanvas();}
  else if(drag.type==='note')for(const member of drag.members){member.el.style.left=Math.round(member.x+dx/s.zoom)+'px';member.el.style.top=Math.round(member.y+dy/s.zoom)+'px';}
  else{const member=drag.members[0];member.el.style.width=Math.max(210,Math.min(800,member.w+dx/s.zoom))+'px';member.el.style.height=Math.max(150,Math.min(800,member.h+dy/s.zoom))+'px';}
});
document.addEventListener('pointerup',async()=>{
  if(!drag)return;
  const current=drag;drag=null;
  if(current.type==='select'){current.box.remove();return;}
  if(!current.moved||current.type==='pan')return;
  const positions=current.members.map(member=>({id:member.id,x:parseFloat(member.el.style.left),y:parseFloat(member.el.style.top),width:parseFloat(member.el.style.width),height:parseFloat(member.el.style.height)}));
  savingPositions=true;
  try{
    if(positions.length===1){const {id,...position}=positions[0];await api(`/items/${id}/position`,{method:'PUT',body:position});}
    else await api('/items/positions',{method:'PUT',body:{items:positions}});
    for(const position of positions){const item=s.items.find(x=>x.id===position.id);if(item)Object.assign(item,position);}
  }
  catch(error){handleError(error);}
  finally{savingPositions=false;await refresh();}
});
document.addEventListener('pointercancel',()=>{
  if(drag?.type==='select')drag.box.remove();
  else if(drag?.members)for(const member of drag.members)Object.assign(member.el.style,{left:member.x+'px',top:member.y+'px',width:member.w+'px',height:member.h+'px'});
  drag=null;
});
window.addEventListener('online',()=>{s.online=true;render();refresh();connect();});
window.addEventListener('offline',()=>{s.online=false;render();});
window.addEventListener('dragover',event=>{if(!isApproved())return;event.preventDefault();document.querySelector('.main')?.classList.add('drop-active');});
window.addEventListener('dragleave',event=>{if(event.relatedTarget===null)document.querySelector('.main')?.classList.remove('drop-active');});
window.addEventListener('drop',event=>{if(!isApproved())return;event.preventDefault();document.querySelector('.main')?.classList.remove('drop-active');if(event.dataTransfer.files.length){s.files=[...event.dataTransfer.files];s.modal='compose';render();}});
window.addEventListener('paste',async event=>{
  if(!isApproved()||s.modal||s.view!=='public'||!event.clipboardData)return;
  if(event.target instanceof Element && event.target.closest('input,textarea,[contenteditable]'))return;
  const files=[...event.clipboardData.files];
  if(!files.length)for(const entry of event.clipboardData.items)if(entry.kind==='file'){
    const file=entry.getAsFile();if(file)files.push(file);
  }
  const text=files.length?'':event.clipboardData.getData('text/plain').trim();
  if(!files.length&&!text)return;
  event.preventDefault();
  s.contextMenu=null;
  try{
    if(files.length){
      toast(`Sharing ${files.length} pasted ${files.length===1?'file':'files'}...`);
      for(const file of files){const item=await uploadFile(file,'public',[]);if(item?.id)focusNote(item.id);}
    }else{
      const item=await api('/items/text',{method:'POST',body:{text,audience:'public',recipients:[]}});
      if(item?.id)focusNote(item.id);
    }
    await refresh();
    toast(files.length?'Pasted files shared.':'Pasted text shared.');
  }catch(error){handleError(error);await refresh();}
});
async function incomingShare(){
  if(!location.search.includes('shared=1'))return;
  try{
    const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('seamless-drafts',1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    const draft=await new Promise((resolve,reject)=>{const tx=db.transaction('drafts','readwrite'),store=tx.objectStore('drafts'),get=store.get('incoming');get.onsuccess=()=>{const value=get.result;store.delete('incoming');resolve(value)};get.onerror=()=>reject(get.error)});
    db.close();
    if(draft){s.draftTitle=draft.title||'';s.draftText=[draft.text,draft.url].filter(Boolean).join('\n');s.files=draft.files||[];s.modal='compose';render();}
    history.replaceState(null,'','/');
  }catch{}
}
if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
session().then(incomingShare).catch(error=>{root.innerHTML=`<div class="full-page"><div class="full-content"><h1>Server unavailable.</h1><p>${esc(error.message)}</p><button class="primary" onclick="location.reload()">RETRY</button></div></div>`;});
setInterval(()=>{if(isApproved())refresh();else if(s.session?.device?.status==='pending')checkStatus();},20000);
