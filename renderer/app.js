'use strict';

const $ = (id) => document.getElementById(id);
const card = $('card');
const scroll = $('scroll');
const todosEl = $('todos');
const chatEl = $('chat');
const input = $('input');
const sendBtn = $('btn-send');

let S = null;
let chat = [];
let busy = false;
let speakToken = 0;
let currentAudio = null;
let expanded = false;
let toastTimer = null;
let viewDay = '';          // 正在看哪一天（YYYY-MM-DD）
let weekOffset = 0;        // 周条的翻页偏移，0 = 本周

const PRIO_LABEL = { high: '高', mid: '中', low: '低' };
const PRIO_NEXT = { high: 'mid', mid: 'low', low: 'high' };
const PRIO_RANK = { high: 0, mid: 1, low: 2 };
const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const MODELS = [
  { id: 'deepseek-chat', label: '快 · 日常记录（deepseek-chat）' },
  { id: 'deepseek-reasoner', label: '会思考 · 排期权衡（deepseek-reasoner）' },
];
const MODEL_CUSTOM = '__custom__';

const API_STYLE_PRESETS = {
  openai: { base: 'https://api.deepseek.com', keyLabel: 'API Key', keyTip: '只保存在本机，用 Windows 加密后写入配置文件。' },
  anthropic: { base: 'https://api.anthropic.com', keyLabel: 'Anthropic API Key', keyTip: '填 sk-ant-… 开头的那串；只保存在本机。' },
  ollama: { base: 'http://127.0.0.1:11434', keyLabel: 'API Key（本地一般不用填）', keyTip: 'Ollama 默认不校验 Key，留空即可。' },
};

// 首次向导里的服务商预设（选完把地址/风格/模型一起填好，用户只要粘 Key）
const WELCOME_PROVIDERS = {
  deepseek: {
    label: 'DeepSeek', style: 'openai', base: 'https://api.deepseek.com', model: 'deepseek-chat',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    tip: '国内直连、便宜；注册后在「API keys」里建一个。',
  },
  siliconflow: {
    label: '硅基流动', style: 'openai', base: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    tip: '国内可直连，一个 Key 能调很多开源模型。',
  },
  openai: {
    label: 'OpenAI', style: 'openai', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
    tip: '需要能访问 api.openai.com。',
  },
  claude: {
    label: 'Claude', style: 'anthropic', base: 'https://api.anthropic.com', model: 'claude-sonnet-4-5',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    tip: '需要能访问 api.anthropic.com。',
  },
  ollama: {
    label: 'Ollama', style: 'ollama', base: 'http://127.0.0.1:11434', model: 'qwen2.5:7b',
    keyUrl: 'https://ollama.com/download', noKey: true,
    tip: '先在本机装 Ollama 并拉一个模型，完全离线、不花钱。',
  },
};

/* ───────────────── 工具 ───────────────── */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function pad(n) { return String(n).padStart(2, '0'); }

function dayKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

function parseDay(k) {
  const [y, m, d] = String(k).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function nowHM() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function minutesOf(hm, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || ''));
  if (!m) return fallback;
  return Number(m[1]) * 60 + Number(m[2]);
}

function toast(msg, ok = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (ok ? ' ok' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 2800);
}

function scrollBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

function assistantName() {
  const n = (S && S.settings && S.settings.name ? String(S.settings.name) : '').trim();
  return n || (S && S.name) || '桌边';
}

function todoDayOf(t) {
  if (t.day) return t.day;
  if (t.created) return String(t.created).slice(0, 10);
  return '';
}

/* ───────────────── 主题 ───────────────── */

function effectiveTheme() {
  const s = (S && S.settings) || {};
  if (s.theme === 'light' || s.theme === 'dark') return s.theme;
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const d = minutesOf(s.dayStart, 7 * 60);
  const n = minutesOf(s.nightStart, 19 * 60);
  const light = d <= n ? (mins >= d && mins < n) : (mins >= d || mins < n);
  return light ? 'light' : 'dark';
}

/* ───────────────── 界面透明度 ───────────────── */

function applyOpacity(v) {
  const a = Math.min(1, Math.max(0.55, Number(v) || 0.92));
  document.documentElement.style.setProperty('--card-a', String(a));
  card.classList.toggle('translucent', a < 0.995);
  const t = $('opacity-val');
  if (t) t.textContent = Math.round(a * 100) + '%';
  return a;
}

function applyTheme() {
  const t = effectiveTheme();
  if (document.documentElement.dataset.theme !== t) {
    document.documentElement.dataset.theme = t;
  }
  const btn = $('btn-theme');
  btn.textContent = t === 'dark' ? '☀' : '☾';
  btn.title = t === 'dark' ? '现在是夜间，点一下切到白天' : '现在是白天，点一下切到夜间';
}

/* ───────────────── 时钟 ───────────────── */

function tickClock() {
  const d = new Date();
  $('c-h').textContent = pad(d.getHours());
  $('c-m').textContent = pad(d.getMinutes());
  $('c-s').textContent = pad(d.getSeconds());
  applyTheme();
}

/* ───────────────── 一天里的待办 ───────────────── */

function todosForDay(day) {
  const today = S.today;
  const out = S.todos.filter((t) => {
    const d = todoDayOf(t);
    if (t.done) {
      if (d === day) return true;
      return day === today && String(t.doneAt || '').slice(0, 10) === today;
    }
    if (d === day) return true;
    return day === today && d && d < today;
  });
  out.sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const r = (PRIO_RANK[a.prio] ?? 1) - (PRIO_RANK[b.prio] ?? 1);
    if (r) return r;
    return String(a.created || '').localeCompare(String(b.created || ''));
  });
  return out;
}

function weekStart(offset) {
  const base = viewDay ? parseDay(viewDay) : new Date();
  const d = new Date(base);
  const wd = (d.getDay() + 6) % 7; // 周一=0
  d.setDate(d.getDate() - wd + offset * 7);
  d.setHours(0, 0, 0, 0);
  return d;
}

let weekExpanded = false;

function applyWeekExpanded() {
  const wk = $('week');
  if (!wk) return;
  wk.classList.toggle('expanded', weekExpanded);
  const btn = $('btn-week-toggle');
  if (btn) {
    btn.textContent = weekExpanded ? '⇱ 收起周条' : '⤢ 展开整月';
    btn.title = weekExpanded ? '收起，回到一周' : '展开显示整月日期';
    btn.classList.toggle('on', weekExpanded);
    btn.setAttribute('aria-pressed', weekExpanded ? 'true' : 'false');
  }
}

function shiftMonth(delta) {
  const base = parseDay(viewDay || S.today);
  const d = new Date(base.getFullYear(), base.getMonth() + delta, 1);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(base.getDate(), last));
  viewDay = dayKey(d);
  renderAll();
}

function toggleWeek() {
  weekExpanded = !weekExpanded;
  applyWeekExpanded();
  renderWeek();
}

function dayCell(key, d, opts) {
  const cls = opts && opts.cellClass ? opts.cellClass : 'wk-day';
  const b = el('button', cls);
  if (key === S.today) b.classList.add('today');
  if (key === viewDay) b.classList.add('sel');
  if (!opts || opts.weekdayHead !== false) {          // 默认显示星期几
    b.appendChild(el('span', 'wd', opts && opts.wd ? opts.wd : WD[d.getDay()]));
  }
  b.appendChild(el('span', 'dn', String(d.getDate())));
  const items = todosForDay(key);
  const openCnt = items.filter((t) => !t.done).length;
  const dot = el('span', 'dot');
  if (items.length) dot.classList.add(items.every((t) => t.done) ? 'all' : 'on');
  b.appendChild(dot);
  const cnt = el('span', 'cnt', openCnt ? String(openCnt) : '');
  if (openCnt) cnt.classList.add('has');
  b.appendChild(cnt);
  b.title = `${key} ${WD[d.getDay()]}${items.length ? ` · ${items.length} 件` : ''}`;
  b.addEventListener('click', () => {
    viewDay = key;
    renderAll();
  });
  return b;
}

function renderWeek() {
  const box = $('wk-days');
  box.innerHTML = '';
  box.classList.toggle('month', weekExpanded);

  if (weekExpanded) {
    // ── 整月：表头 + 6 行 7 列 ──
    const anchor = parseDay(viewDay || S.today);
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const lead = (first.getDay() + 6) % 7;          // 周一为第一列
    const daysInMonth = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate();
    for (let i = 0; i < 7; i += 1) {
      box.appendChild(el('span', 'mhead', WD[(i + 1) % 7]));
    }
    for (let i = 0; i < lead; i += 1) box.appendChild(el('span', 'mblank'));
    for (let d = 1; d <= daysInMonth; d += 1) {
      const dt = new Date(anchor.getFullYear(), anchor.getMonth(), d);
      const key = dayKey(dt);
      const cell = dayCell(key, dt, { cellClass: 'mday' });
      box.appendChild(cell);
    }
    const lbl = $('wk-label');
    if (lbl) lbl.textContent = `${anchor.getFullYear()} 年 ${anchor.getMonth() + 1} 月`;
    $('week').classList.add('month-mode');
    $('wk-prev').disabled = true;
    $('wk-next').disabled = true;
    return;
  }

  // ── 一周细条 ──
  $('week').classList.remove('month-mode');
  const lbl = $('wk-label');
  if (lbl) lbl.textContent = '';
  const start = weekStart(weekOffset);
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    box.appendChild(dayCell(dayKey(d), d));
  }
  $('wk-prev').title = '上一周';
  $('wk-next').title = '下一周';
  $('wk-prev').disabled = weekOffset <= -8;
  $('wk-next').disabled = weekOffset >= 12;
}

/* ───────────────── 渲染：待办 ───────────────── */

function renderDate() {
  const d = parseDay(viewDay || S.today);
  const isToday = (viewDay || S.today) === S.today;
  $('date').textContent = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${WD[d.getDay()]}${isToday ? ' · 今天' : ''}`;
  const list = todosForDay(viewDay || S.today);
  const total = list.length;
  const done = list.filter((t) => t.done).length;
  $('progress').textContent = total ? `${done}/${total} 完成` : '';

  $('dayhead-label').textContent = isToday ? '今天的清单' : `这天的清单`;
  const back = $('btn-today');
  back.hidden = isToday;
}

function makeBadge(t) {
  const b = el('span', `badge ${t.prio || 'mid'}`);
  const parts = [PRIO_LABEL[t.prio] || '中'];
  if (t.est) parts.push(t.est >= 60 ? `${(t.est / 60).toFixed(t.est % 60 ? 1 : 0)}h` : `${t.est}m`);
  if (t.due && !t.done && t.due < S.today) {
    b.classList.add('overdue');
    parts.push('逾期');
  }
  b.textContent = parts.join(' · ');
  b.title = '点击切换优先级';
  b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const next = PRIO_NEXT[t.prio || 'mid'];
    S = await window.fish.updateTodo(t.id, { prio: next });
    renderAll();
  });
  return b;
}

function renderSubs(t, wrap) {
  for (const s of t.subs) {
    const row = el('div', 'sub' + (s.done ? ' done' : ''));
    row.dataset.subId = s.id;
    row.draggable = true;
    row.appendChild(el('span', 'sq'));
    const txt = el('span', 'st', s.title);
    row.appendChild(txt);
    txt.title = '双击改这一步；按住可以拖到别的待办下面';
    txt.addEventListener('dblclick', (e) => { e.stopPropagation(); startSubEdit(t, s, txt); });
    const del = el('button', 'sub-del', '×');
    del.title = '删掉这一步';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      S = await window.fish.removeSub(t.id, s.id);
      renderAll();
    });
    row.appendChild(del);
    row.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (e.target === del) return;
      S = await window.fish.toggleSub(t.id, s.id);
      renderAll();
    });
    row.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      e.dataTransfer.setData('application/x-deskside-sub', JSON.stringify({ fromId: t.id, subId: s.id }));
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    wrap.appendChild(row);
  }
  const add = el('div', 'sub sub-add');
  add.appendChild(el('span', 'sq'));
  add.appendChild(el('span', 'st', '＋ 加一步'));
  add.addEventListener('click', (e) => { e.stopPropagation(); startSubNew(t, add); });
  wrap.appendChild(add);
}

function startSubEdit(t, s, txtNode) {
  const box = el('input', 'add-input');
  box.value = s.title;
  txtNode.replaceWith(box);
  box.focus();
  box.select();
  let finished = false;
  const commit = async (save) => {
    if (finished) return;
    finished = true;
    const v = box.value.trim();
    if (save && v && v !== s.title) S = await window.fish.updateSub(t.id, s.id, v);
    if (save && v === '') S = await window.fish.removeSub(t.id, s.id);
    renderAll();
  };
  box.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  box.addEventListener('blur', () => commit(true));
}

function startSubNew(t, addRow) {
  const box = el('input', 'add-input');
  box.placeholder = '这一步做什么？';
  addRow.replaceWith(box);
  box.focus();
  let finished = false;
  const commit = async (save) => {
    if (finished) return;
    finished = true;
    const v = box.value.trim();
    if (save && v) S = await window.fish.addSub(t.id, v);
    renderAll();
  };
  box.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  box.addEventListener('blur', () => commit(true));
}

const REPEAT_LABEL = { daily: '每天', weekly: '每周', monthly: '每月' };

function openRepeatMenu(anchor, t) {
  const menu = $('repeatMenu');
  const r = anchor.getBoundingClientRect();
  menu.hidden = false;
  const w = menu.offsetWidth || 96;
  menu.style.left = Math.max(6, Math.min(window.innerWidth - w - 6, r.left - 20)) + 'px';
  menu.style.top = Math.min(window.innerHeight - 120, r.bottom + 4) + 'px';
  menu.onclick = async (ev) => {
    const btn = ev.target.closest('button[data-repeat]');
    if (!btn) return;
    ev.stopPropagation();
    menu.hidden = true;
    S = await window.fish.setRepeat(t.id, btn.dataset.repeat || '');
    renderAll();
  };
  setTimeout(() => {
    const off = (ev) => {
      if (!menu.contains(ev.target)) { menu.hidden = true; document.removeEventListener('mousedown', off); }
    };
    document.addEventListener('mousedown', off);
  }, 0);
}

function renderTodo(t) {
  const row = el('div', 'todo' + (t.done ? ' done' : ''));
  row.dataset.id = t.id;

  const check = el('button', 'check');
  check.title = t.done ? '标记为未完成' : '标记为完成';
  check.addEventListener('click', async (e) => {
    e.stopPropagation();
    S = await window.fish.toggleTodo(t.id);
    renderAll();
  });
  row.appendChild(check);

  const body = el('div', 'body');
  const titleRow = el('div', 'title-row');
  const title = el('span', 'title', t.title);
  title.addEventListener('dblclick', (e) => { e.stopPropagation(); startEdit(t, title); });
  titleRow.appendChild(title);
  titleRow.appendChild(makeBadge(t));
  if (t.repeat) {
    const chip = el('span', 'repeat-chip', '↻ ' + (REPEAT_LABEL[t.repeat] || t.repeat));
    chip.title = '周期待办，点一下改';
    chip.addEventListener('click', (e) => { e.stopPropagation(); openRepeatMenu(chip, t); });
    titleRow.appendChild(chip);
  }
  body.appendChild(titleRow);

  if (t.note) body.appendChild(el('div', 'note', t.note));
  if (t.subs.length) {
    const subs = el('div', 'subs');
    renderSubs(t, subs);
    body.appendChild(subs);
  }
  row.appendChild(body);

  const tools = el('div', 'row-tools');
  const edit = el('button', 'mini', '✎');
  edit.title = '改标题';
  edit.addEventListener('click', (e) => { e.stopPropagation(); startEdit(t, title); });
  const del = el('button', 'mini del', '×');
  del.title = '删除';
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    S = await window.fish.removeTodo(t.id);
    renderAll();
  });
  const rep = el('button', 'mini', '↻');
  rep.title = '设成周期待办（每天/每周/每月）';
  rep.addEventListener('click', (e) => { e.stopPropagation(); openRepeatMenu(rep, t); });
  tools.appendChild(rep);
  tools.appendChild(edit);
  tools.appendChild(del);
  row.appendChild(tools);

  // 子任务可以拖进来
  row.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('application/x-deskside-sub')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    row.classList.add('drop-target');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
  row.addEventListener('drop', async (e) => {
    row.classList.remove('drop-target');
    const raw = e.dataTransfer.getData('application/x-deskside-sub');
    if (!raw) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      const { fromId, subId } = JSON.parse(raw);
      if (fromId === t.id) return;
      S = await window.fish.moveSub(fromId, subId, t.id);
      renderAll();
    } catch { /* ignore */ }
  });

  return row;
}

function startEdit(t, titleNode) {
  const box = el('input', 'add-input');
  box.value = t.title;
  titleNode.replaceWith(box);
  box.focus();
  box.select();
  let finished = false;
  const commit = async (save) => {
    if (finished) return;
    finished = true;
    const v = box.value.trim();
    if (save && v && v !== t.title) {
      S = await window.fish.updateTodo(t.id, { title: v });
    }
    renderAll();
  };
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    if (e.key === 'Escape') { e.preventDefault(); commit(false); }
    e.stopPropagation();
  });
  box.addEventListener('blur', () => commit(true));
}

function renderAddRow() {
  const row = el('div', 'add-row');
  row.appendChild(el('span', 'plus', '＋'));
  row.appendChild(el('span', '', viewDay && viewDay !== S.today ? '给这天加一条' : '自己加一条'));
  row.addEventListener('click', () => {
    const box = el('input', 'add-input');
    box.placeholder = '要做什么？';
    row.replaceWith(box);
    box.focus();
    let finished = false;
    const done = async (save) => {
      if (finished) return;
      finished = true;
      const v = box.value.trim();
      if (save && v) S = await window.fish.addTodo({ title: v, day: viewDay || S.today });
      renderAll();
    };
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); done(true); }
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
      e.stopPropagation();
    });
    box.addEventListener('blur', () => done(true));
  });
  return row;
}

// 清单还能往下滚时，底部加一层淡出，避免半行被生硬切断
function updateTodoFade() {
  if (!todosEl) return;
  const more = todosEl.scrollHeight - todosEl.scrollTop - todosEl.clientHeight > 4;
  todosEl.classList.toggle('more', more);
}

function renderTodos() {
  todosEl.innerHTML = '';
  requestAnimationFrame(updateTodoFade);
  const day = viewDay || S.today;
  const list = todosForDay(day);
  if (!list.length) {
    const empty = el('div', 'empty');
    empty.innerHTML = day === S.today
      ? '今天还是空的。<br />跟我说一句「今天要写周报、下午三点开评审会」，我来排。'
      : '这天还没有安排。<br />点下面「给这天加一条」，或者告诉我那天要干什么。';
    todosEl.appendChild(empty);
  } else {
    for (const t of list) todosEl.appendChild(renderTodo(t));
  }
  todosEl.appendChild(renderAddRow());
}

/* ───────────────── 渲染：对话 ───────────────── */

function pushChat(msg) {
  chat.push(msg);
  renderChat();
}

function renderChat(stick = true) {
  chatEl.innerHTML = '';
  const name = assistantName();
  for (const m of chat) {
    const b = el('div', 'bubble ' + (m.role === 'me' ? 'me' : 'ai') + (m.brief ? ' brief' : ''));
    if (m.role !== 'me') {
      const who = el('div', 'who');
      who.appendChild(el('span', '', m.brief === 'morning' ? '早间播报' : m.brief === 'evening' ? '晚间播报' : name));
      who.appendChild(el('span', '', m.time || ''));
      b.appendChild(who);
    }
    b.appendChild(el('div', 'txt', m.text));

    // 收音机里念的和屏幕上写的不一样：点一下气泡就能展开「口语稿」
    const sayText = String(m.say || '').trim();
    const hasSay = m.role !== 'me' && sayText && sayText !== String(m.text || '').trim();
    if (hasSay) {
      const box = el('div', 'saybox');
      const lab = el('div', 'saylab', '喇叭里念的');
      const tx = el('div', 'saytext', sayText);
      box.appendChild(lab);
      box.appendChild(tx);
      b.appendChild(box);
      b.classList.add('has-say');
      b.title = '点一下看/收起口语稿';
      b.addEventListener('click', (ev) => {
        if (ev.target.closest('button')) return;
        const sel = window.getSelection();
        if (sel && String(sel).trim()) return;   // 正在选文字就别折叠了
        b.classList.toggle('show-say');
        if (b.classList.contains('show-say')) b.scrollIntoView({ block: 'nearest' });
      });
    }

    if (m.applied && m.applied.length) {
      const box = el('div', 'applied');
      for (const a of m.applied) box.appendChild(el('span', 'chip-done', a));
      b.appendChild(box);
    }

    if (m.ask && m.ask.length) {
      const box = el('div', 'asks');
      for (const a of m.ask) {
        b.appendChild(el('div', 'note', a.q));
        for (const opt of a.options || []) {
          const btn = el('button', 'ask-btn', opt);
          btn.addEventListener('click', () => { expand(); send(opt); });
          box.appendChild(btn);
        }
      }
      b.appendChild(box);
    }

    if (m.role !== 'me' && !m.brief) {
      const row = el('div', 'bubble-foot');
      const sp = el('button', 'speak-btn', '🔊 重读');
      sp.addEventListener('click', () => speak(m.say || m.text));
      row.appendChild(sp);
      if (hasSay) {
        const hint = el('span', 'sayhint', '▾ 口语稿');
        hint.addEventListener('click', (ev) => {
          ev.stopPropagation();
          b.classList.toggle('show-say');
          if (b.classList.contains('show-say')) b.scrollIntoView({ block: 'nearest' });
        });
        row.appendChild(hint);
      }
      b.appendChild(row);
    }
    chatEl.appendChild(b);
  }

  if (busy) {
    const b = el('div', 'bubble ai');
    const th = el('div', 'thinking');
    th.innerHTML = '<i></i><i></i><i></i>';
    b.appendChild(th);
    chatEl.appendChild(b);
  }
  if (stick) scrollBottom();
  if (!expanded) updatePlaceholderHint();
}

/* ───────────────── 语音 ───────────────── */

function stopAudio() {
  speakToken += 1;
  if (currentAudio) {
    try { currentAudio.pause(); } catch { /* ignore */ }
    currentAudio = null;
  }
  try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
}

function splitSpeech(text, limit = 300) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  if (t.length <= limit) return [t];
  const out = [];
  let rest = t;
  while (rest.length > limit) {
    const win = rest.slice(0, limit);
    let cut = -1;
    for (const mark of ['。', '！', '？', '；', '\n', '，']) {
      const at = win.lastIndexOf(mark);
      if (at > limit * 0.3) { cut = at + 1; break; }
    }
    if (cut <= 0) cut = limit;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

// ---- 播放：音量 + 「柔和一点」滤波 ----
// 云端音色（Fish）偶尔齿音重、听着刺耳，这里统一过一遍：
// 3.2kHz 以上压 4dB、11kHz 以上低通，再乘一个全局音量。
let audioCtx = null;

function getAudioCtx() {
  if (audioCtx) return audioCtx;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  } catch { audioCtx = null; }
  return audioCtx;
}

function voiceGain() {
  const v = Number(S.settings && S.settings.voiceVolume);
  return Number.isFinite(v) && v > 0 ? Math.min(1, Math.max(0.15, v)) : 0.9;
}

function voiceWarmOn() {
  const v = S.settings && S.settings.voiceWarm;
  return v === undefined ? true : !!v;
}

// 返回接在 audio element 后面的入口节点；不可用时返回 null（退化成纯播放）
function buildVoiceChain(ctx) {
  try {
    const shelf = ctx.createBiquadFilter();
    shelf.type = 'highshelf';
    shelf.frequency.value = 3200;
    shelf.gain.value = voiceWarmOn() ? -4 : 0;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = voiceWarmOn() ? 11000 : 20000;
    lp.Q.value = 0.6;

    const gain = ctx.createGain();
    gain.gain.value = voiceGain();

    shelf.connect(lp);
    lp.connect(gain);
    gain.connect(ctx.destination);
    return { input: shelf, gain };
  } catch {
    return null;
  }
}

function playUrl(url) {
  return new Promise((resolve) => {
    try {
      const audio = new Audio(url);
      currentAudio = audio;
      const finish = () => { if (currentAudio === audio) currentAudio = null; resolve(); };
      audio.addEventListener('ended', finish);
      audio.addEventListener('error', finish);

      const ctx = getAudioCtx();
      const chain = ctx ? buildVoiceChain(ctx) : null;
      if (chain) {
        try {
          const src = ctx.createMediaElementSource(audio);
          src.connect(chain.input);
          if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        } catch {
          audio.volume = voiceGain();
        }
      } else {
        audio.volume = voiceGain();
      }

      audio.play().catch(finish);
    } catch {
      resolve();
    }
  });
}

function browserSpeak(text) {
  return new Promise((resolve) => {
    try {
      const synth = window.speechSynthesis;
      if (!synth) { resolve(); return; }
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.rate = 1.05;
      const voices = synth.getVoices().filter((v) => /zh|Chinese/i.test(v.lang));
      if (voices.length) u.voice = voices[0];
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      u.onend = done;
      u.onerror = done;
      setTimeout(done, Math.min(30000, 2500 + text.length * 220));
      synth.speak(u);
    } catch {
      resolve();
    }
  });
}

/** 按句子切分（合并过短的句子、长句只在逗号处切），一句一句合成、边合成边播。
 *  原则：**绝不把一句话从中间劈开**，切开的位置一定要落在标点上，不然念出来像机器人。 */
const SENT_RE = /[^。！？!?；;\n]+[。！？!?；;]*/g;
const CLAUSE_MAX = 34;   // 一句话超过这么长，才在逗号/顿号处切成两段
const TAIL_MIN = 6;      // 切出来的后半段太短就并回去（避免"它。"这种半句）

function splitForSpeech(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const raw = (t.match(SENT_RE) || [t]).map((s) => s.trim()).filter(Boolean);

  const merged = [];
  for (const p of raw) {
    const last = merged[merged.length - 1];
    // 粘连过短的句子（"知道了。"这种），但别把长句拼太长
    if (last && (last.length < 10 || p.length < 10) && last.length + p.length <= 60) {
      merged[merged.length - 1] = last + p;
    } else {
      merged.push(p);
    }
  }

  const out = [];
  for (const p of merged) {
    if (p.length <= CLAUSE_MAX) {
      out.push(p);
      continue;
    }
    // 太长：找最靠后、且在 CLAUSE_MAX 之前的逗号/顿号切开，标点留在前半段
    let cut = 0;
    for (let i = 0; i < Math.min(p.length - TAIL_MIN, CLAUSE_MAX); i++) {
      if ('，,、；;：:'.includes(p[i])) cut = i + 1;
    }
    if (cut >= 6) {
      out.push(p.slice(0, cut).trim());
      out.push(p.slice(cut).trim());
    } else {
      // 一整句没有标点又特别长：只在实在离谱时才硬切，切在 CLAUSE_MAX
      if (p.length > CLAUSE_MAX * 2) {
        out.push(p.slice(0, CLAUSE_MAX).trim());
        out.push(p.slice(CLAUSE_MAX).trim());
      } else {
        out.push(p);
      }
    }
  }

  const cleaned = out.map((x) => x.trim()).filter(Boolean);
  return cleaned.length ? cleaned : [t];
}

async function speak(text, opts) {
  const clean = String(text || '').trim();
  if (!clean) return;
  stopAudio();
  const token = speakToken;
  const parts = splitForSpeech(clean);
  const synth = (p) => window.fish.speak(p, opts).catch((err) => ({ ok: false, error: String(err) }));

  // 始终只保持两句在飞：当前这句在播时，下一句已经在合成
  let pending = synth(parts[0]);
  let lookahead = parts.length > 1 ? synth(parts[1]) : null;
  let failed = false;

  for (let i = 0; i < parts.length; i++) {
    const cur = pending;
    pending = lookahead;
    lookahead = i + 2 < parts.length ? synth(parts[i + 2]) : null;

    const r = await cur;
    if (token !== speakToken) return;
    if (r && r.ok) {
      await playUrl(r.dataUrl);
    } else {
      failed = true;
      await browserSpeak(parts[i]);
    }
  }
  if (failed) toast('在线语音没成功，先用系统语音顶上了');
}

/* ───────────────── 发送 ───────────────── */

function applyState(r) {
  if (!r) return;
  if (Array.isArray(r.todos)) {
    S = r;
    renderAll();
    if (r.settings) applyOpacity(r.settings.uiOpacity);
  }
}

let pendingConfirm = null;   // { msg, threshold, count }

function askConfirm({ msg, threshold, count }) {
  pendingConfirm = { msg, threshold, count };
  const t = $('confirm-text');
  if (t) {
    t.textContent = `这个窗口里已经有 ${count} 条对话要一起发给模型（超过 ${threshold} 条这一档）。`
      + '继续会让每次请求更慢、更费 token；也可以去「设置 → 助手 → 上下文读取」把窗口或模式调小。';
  }
  const mask = $('confirmMask');
  if (mask) mask.hidden = false;
}

function closeConfirm() {
  const mask = $('confirmMask');
  if (mask) mask.hidden = true;
}

async function send(text, ack) {
  const msg = String(text || '').trim();
  if (!msg || busy) return;
  busy = true;
  if (!ack) {
    pushChat({ role: 'me', text: msg });
    input.value = '';
    updateSendState();
    renderChat();
  }

  let r = null;
  try {
    r = await window.fish.sendChat(msg, ack);
  } catch (err) {
    r = { error: String(err && err.message ? err.message : err) };
  }
  busy = false;

  if (r && r.needConfirm) {
    askConfirm({ msg, threshold: r.threshold, count: r.count });
    updateSendState();
    return;
  }

  if (!r) r = { error: '没有回应' };
  if (r.error) {
    pushChat({ role: 'ai', text: '出了点问题：' + r.error, time: nowHM() });
    toast(r.error);
  } else {
    pushChat({
      role: 'ai',
      text: r.reply || '（没有回复）',
      say: r.say,
      ask: r.ask,
      applied: r.applied,
      time: nowHM(),
    });
    applyState(r);
    if (S && S.settings && S.settings.autoSpeak) {
      speak(S.settings.speakFull ? r.reply : (r.say || r.reply));
    }
  }
  updateSendState();
  renderChat();
  // 回复留在展开态让人读完；点待办区或按 Esc 收起
  if (r.error) input.focus();
  else if (Array.isArray(r.ask) && r.ask.length) input.focus();
}

function updateSendState() {
  sendBtn.disabled = busy || !input.value.trim();
  $('btn-undo').disabled = !(S && S.canUndo);
}

/* ───────────────── 输入框 / 对话区展开 ───────────────── */

function openChat() {
  card.classList.add('chat-open');
  requestAnimationFrame(() => scrollBottom());
}

function closeChat() {
  card.classList.remove('chat-open');
}

function expand(andFocus = true) {
  expanded = true;
  card.classList.add('expanded');
  openChat();
  if (andFocus) setTimeout(() => input.focus(), 30);
}

function collapse() {
  expanded = false;
  card.classList.remove('expanded');
  input.style.height = '';          // 下次展开从最小高度开始长
  input.blur();
  closeChat();
  updatePlaceholderHint();
}

// 收起时用最后一条回复的摘要提示"有新内容可看"
function updatePlaceholderHint() {
  const ph = $('ph-text');
  if (!ph) return;
  const last = chatEl && chatEl.lastElementChild;
  if (last && !expanded) {
    const body = last.querySelector('.txt');
    const txt = body ? body.textContent.trim().replace(/\s+/g, ' ') : '';
    if (txt) {
      ph.textContent = txt.length > 22 ? txt.slice(0, 22) + '…' : txt;
      return;
    }
  }
  ph.textContent = '今天要做什么？点这里跟我说…';
}

/* ───────────────── 设置 ───────────────── */

function fillModels(selected) {
  const sel = $('f-model');
  sel.innerHTML = '';
  const list = MODELS.slice();
  const known = selected && list.some((m) => m.id === selected);
  if (selected && !known) {
    list.push({ id: selected, label: selected });
  }
  for (const m of list) {
    const o = el('option', '', m.label);
    o.value = m.id;
    sel.appendChild(o);
  }
  const custom = el('option', '', '自定义…');
  custom.value = MODEL_CUSTOM;
  sel.appendChild(custom);
  sel.value = selected || 'deepseek-chat';
  $('f-model-custom').value = selected && !known ? selected : '';
  syncModelUi();
}

// 选了「自定义…」才露出输入框
function syncModelUi() {
  const sel = $('f-model');
  const box = $('f-model-custom');
  const custom = sel.value === MODEL_CUSTOM;
  box.hidden = !custom;
  if (custom) {
    box.focus();
  } else {
    const presets = MODELS.map((m) => m.id);
    if (presets.includes(sel.value)) box.value = '';
  }
}

// 换接口风格时更新地址占位和 Key 文案
function syncStyleUi() {
  const style = $('f-style').value || 'openai';
  const pre = API_STYLE_PRESETS[style] || API_STYLE_PRESETS.openai;
  const base = $('f-base');
  base.placeholder = pre.base;
  if (!base.value.trim()) base.placeholder = pre.base;
  $('key-label').textContent = pre.keyLabel;
  $('key-hint').textContent = pre.keyTip;
}

function fillSettings() {
  const s = S.settings;
  $('f-key').value = '';
  $('f-style').value = s.apiStyle || 'openai';
  $('f-name').value = s.name || '';
  $('f-name').placeholder = S.name || '桌边';
  $('f-persona').value = s.persona || '';
  $('f-base').value = s.baseUrl || '';
  fillModels(s.model || 'deepseek-chat');
  $('f-theme').value = s.theme || 'auto';
  $('f-daystart').value = s.dayStart || '07:00';
  $('f-nightstart').value = s.nightStart || '19:00';
  fillVoiceSelect();
  $('f-localurl').value = s.localUrl || 'http://127.0.0.1:8756';
  $('f-local-enabled').checked = s.localEnabled !== false;
  $('f-fishkey').value = '';
  $('f-fishkey').placeholder = s.hasFishKey ? `已保存（${s.fishKeyHint}），留空则不修改` : '没填的话云端音色用不了';
  $('fishkey-hint').textContent = s.hasFishKey ? '已保存' : '未设置';
  $('f-rate').value = String(Number(s.rate) || 0);
  $('rate-label').textContent = rateLabel(Number(s.rate) || 0);
  const vol = Math.round((Number(s.voiceVolume) || 0.9) * 100);
  $('f-volume').value = String(vol);
  $('volume-label').textContent = vol + '%';
  $('f-warm').checked = s.voiceWarm === undefined ? true : Boolean(s.voiceWarm);
  $('f-autospeak').checked = Boolean(s.autoSpeak);
  $('f-speakfull').checked = Boolean(s.speakFull);
  $('f-briefon').checked = Boolean(s.briefOn);
  $('f-morning').value = s.briefMorning || '09:00';
  $('f-evening').value = s.briefEvening || '21:00';
  $('f-autostart').checked = Boolean(s.autoStart);
  const op = Math.round(Math.min(1, Math.max(0.55, Number(s.uiOpacity) || 0.92)) * 100);
  $('f-opacity').value = String(op);
  applyOpacity(op / 100);
  if (s.hasKey) {
    $('key-hint').textContent = `已保存（${s.keyHint}）。留空则不修改。`;
  }
  syncStyleUi();
  $('f-retention').value = s.chatRetention || '1m';
  $('f-ctxwindow').value = s.ctxWindow || '1w';
  $('f-ctxmode').value = s.ctxMode || 'mixed';
  $('f-ai-subtasks').checked = s.aiSubtasks !== false;
  $('f-care-on').checked = s.careOn !== false;
  $('f-care-speak').checked = s.careSpeak !== false;
  const ce = Math.max(15, Math.min(180, Number(s.careEvery) || 50));
  $('f-care-every').value = String(ce);
  $('care-every-label').textContent = ce + ' 分钟';
  $('f-quiet-start').value = s.quietStart || '22:30';
  $('f-quiet-end').value = s.quietEnd || '08:00';
  fillPersonaSelect();
  fillCtxTip();
  renderReminders();
  closeVoiceForm();
}

/* ── 提醒 ── */

function remindWhen(r) {
  if (r.kind === 'daily') return '每天 ' + (r.times || []).join(' / ');
  return '每 ' + r.everyMin + ' 分钟';
}

function renderReminders() {
  const box = $('reminder-list');
  if (!box) return;
  box.innerHTML = '';
  const list = S.reminders || [];
  if (!list.length) {
    box.appendChild(el('div', 'mini-note', '还没有提醒。加一条「每隔 45 分钟提醒喝水」试试。'));
    return;
  }
  for (const r of list) {
    const row = el('div', 'rem-item' + (r.on === false ? ' off' : ''));
    const txt = el('div', 'rem-txt');
    txt.appendChild(el('div', '', r.title));
    txt.appendChild(el('div', 'rem-when', remindWhen(r)));
    row.appendChild(txt);
    const tg = el('button', 'rem-btn', r.on === false ? '开' : '关');
    tg.title = r.on === false ? '启用这条提醒' : '先关掉，不删除';
    tg.addEventListener('click', async () => {
      await window.fish.saveReminder({ ...r, on: r.on === false });
      S = await window.fish.getState();
      renderReminders();
      toast(r.on === false ? '已启用' : '已关闭');
    });
    row.appendChild(tg);
    const tst = el('button', 'rem-btn', '试');
    tst.title = '立刻弹一次';
    tst.addEventListener('click', () => window.fish.testReminder(r.id));
    row.appendChild(tst);
    const del = el('button', 'rem-btn del', '×');
    del.title = '删除';
    del.addEventListener('click', async () => {
      await window.fish.removeReminder(r.id);
      S = await window.fish.getState();
      renderReminders();
    });
    row.appendChild(del);
    box.appendChild(row);
  }
}

function openRemindForm() {
  $('reminder-form').classList.remove('hidden');
  $('rf-title').value = '';
  $('rf-kind').value = 'every';
  $('rf-every').value = '45';
  $('rf-times').value = '09:00';
  syncRemindForm();
  $('rf-title').focus();
}

function closeRemindForm() { $('reminder-form').classList.add('hidden'); }

function syncRemindForm() {
  const daily = $('rf-kind').value === 'daily';
  $('rf-every-wrap').classList.toggle('hidden', daily);
  $('rf-times-wrap').classList.toggle('hidden', !daily);
}

async function saveRemindForm() {
  const title = $('rf-title').value.trim();
  if (!title) { toast('先写提醒什么'); return; }
  const kind = $('rf-kind').value;
  const payload = { title, kind, on: true };
  if (kind === 'every') payload.everyMin = Number($('rf-every').value) || 45;
  else payload.times = $('rf-times').value.split(/[,，\s]+/).filter(Boolean);
  const r = await window.fish.saveReminder(payload);
  S.reminders = r.reminders;
  renderReminders();
  closeRemindForm();
  toast('提醒已加');
}

/* ── 人设 ── */

function fillPersonaSelect() {
  const sel = $('f-persona-sel');
  if (!sel) return;
  sel.innerHTML = '';
  for (const p of S.personas || []) {
    const o = el('option', '', `${p.name}（${p.turns} 条记录）`);
    o.value = p.id;
    sel.appendChild(o);
  }
  if (S.activePersonaId) sel.value = S.activePersonaId;
  const n = (S.personas || []).length;
  $('persona-count').textContent = `${n} 个人设，待办共用`;
}

function fillCtxTip() {
  const tip = $('ctx-tip');
  if (!tip || !S.ctx) return;
  const mode = S.ctx.mode === 'full' ? '全量原文' : '精简（近 3 天原文 + 更早摘要）';
  tip.textContent = `这次会读 ${S.ctx.count} 条（存了 ${S.ctx.total} 条）· ${mode}`;
}

async function switchPersona(id) {
  if (!id || id === S.activePersonaId) return;
  const r = await window.fish.switchPersona(id);
  if (!r || r.error) { toast(r && r.error ? r.error : '切换失败'); return; }
  applyState(r);
  fillSettings();
  rebuildChatFromState();
  renderChat(false);
  renderAll();
  toast(`已切到「${(S.personas.find((p) => p.id === id) || {}).name || id}」`);
}

/* ── 应用内输入/确认框（Electron 不支持 window.prompt） ── */

let askResolver = null;

function askModal({ title = '输入', label = '', value = '', okLabel = '确定', withInput = true } = {}) {
  return new Promise((resolve) => {
    askResolver = resolve;
    $('ask-title').textContent = title;
    const lab = $('ask-label');
    lab.textContent = label;
    lab.style.display = label ? '' : 'none';
    const inp = $('ask-input');
    inp.style.display = withInput ? '' : 'none';
    inp.value = String(value || '');
    $('btn-ask-ok').textContent = okLabel;
    $('askMask').hidden = false;
    setTimeout(() => {
      if (withInput) { inp.focus(); inp.select(); } else $('btn-ask-ok').focus();
    }, 30);
  });
}

function closeAsk(value) {
  const mask = $('askMask');
  if (mask) mask.hidden = true;
  const r = askResolver;
  askResolver = null;
  if (r) r(value);
}

async function newPersona() {
  const name = await askModal({
    title: '新建人设',
    label: '给它起个名字（之后也能在「名字」里改）。聊天记录从空白开始，待办共用。',
    value: `人设 ${(S.personas || []).length + 1}`,
    okLabel: '创建',
  });
  if (name === null) return;
  const r = await window.fish.newPersona(String(name || '').trim());
  if (!r || r.ok === false) { toast(r && r.error ? r.error : '新建失败'); return; }
  applyState(r);
  fillSettings();
  rebuildChatFromState();
  renderChat(false);
  renderAll();
  toast('新人设建好了，聊天记录从空白开始');
  $('f-name').focus();
}

async function removePersona() {
  const cur = (S.personas || []).find((p) => p.id === S.activePersonaId);
  const nm = cur ? cur.name : '当前人设';
  const ok = await askModal({
    title: '删除人设',
    label: `删掉「${nm}」和它的 ${cur ? cur.turns : 0} 条聊天记录？待办不受影响。`,
    okLabel: '删除',
    withInput: false,
  });
  if (ok === null) return;
  const r = await window.fish.removePersona(S.activePersonaId);
  if (!r || r.ok === false) { toast(r && r.error ? r.error : '删除失败'); return; }
  applyState(r);
  fillSettings();
  rebuildChatFromState();
  renderChat(false);
  renderAll();
  toast('已删除');
}

/* ── 音色库 ── */

const ENGINE_LABEL = { edge: '微软', local: '本地', fish: '云端' };

function fillVoiceSelect() {
  const sel = $('f-active-voice');
  sel.innerHTML = '';
  const s = S.settings;
  const builtin = el('option', '', `内置 · ${edgeName(s.voice)}`);
  builtin.value = '__builtin_edge__';
  sel.appendChild(builtin);
  for (const v of S.voices || []) {
    const o = el('option', '', `${v.name}（${ENGINE_LABEL[v.engine] || v.engine}）`);
    o.value = v.id;
    sel.appendChild(o);
  }
  const active = (S.activeVoice && S.activeVoice.id) || '__builtin_edge__';
  sel.value = active;
  if (sel.value !== active) sel.value = '__builtin_edge__';
  const eng = (S.activeVoice && S.activeVoice.engine) || 'edge';
  $('voice-engine').textContent = ENGINE_LABEL[eng] || eng;
}

function edgeName(id) {
  const map = {
    'zh-CN-XiaoxiaoNeural': '晓晓',
    'zh-CN-XiaoyiNeural': '晓伊',
    'zh-CN-YunxiNeural': '云希',
    'zh-CN-YunjianNeural': '云健',
    'zh-CN-liaoning-XiaobeiNeural': '晓北',
    'zh-CN-shaanxi-XiaoniNeural': '晓妮',
  };
  return map[id] || '晓晓';
}

function openVoiceForm() {
  $('voice-form').classList.remove('hidden');
  $('vf-name').value = '';
  $('vf-reftext').value = '';
  $('vf-remote').value = '';
  $('vf-engine').value = 'local';
  $('vf-audio-name').textContent = '还没选（5~30 秒、一个人说话、无背景音乐）';
  $('vf-audio-name').dataset.path = '';
  syncVoiceForm();
  $('vf-name').focus();
}

function closeVoiceForm() {
  $('voice-form').classList.add('hidden');
}

function syncVoiceForm() {
  const eng = $('vf-engine').value;
  $('vf-audio-field').classList.toggle('hidden', eng === 'edge');
  $('vf-reftext-field').classList.toggle('hidden', eng !== 'local');
  $('vf-remote-field').classList.toggle('hidden', eng !== 'fish');
  $('vf-edge-field').classList.toggle('hidden', eng !== 'edge');
}

async function pickVoiceAudio() {
  const r = await window.fish.pickVoiceAudio();
  if (!r || !r.ok) {
    if (r && !r.canceled) toast('选不了：' + (r.error || '未知原因'));
    return;
  }
  $('vf-audio-name').textContent = `${r.name}（${(r.size / 1024 / 1024).toFixed(1)}MB）`;
  $('vf-audio-name').dataset.path = r.path;
}

async function saveVoice() {
  const name = $('vf-name').value.trim();
  if (!name) {
    toast('先给它起个名字');
    return;
  }
  const payload = {
    name,
    engine: $('vf-engine').value,
    refText: $('vf-reftext').value.trim(),
    remoteVoiceId: $('vf-remote').value.trim(),
    edgeVoice: $('vf-edge').value,
    audioPath: $('vf-audio-name').dataset.path || '',
  };
  const r = await window.fish.addVoice(payload);
  if (!r || !r.ok) {
    toast(r && r.error ? r.error : '保存失败');
    return;
  }
  applyState(r);
  fillVoiceSelect();
  closeVoiceForm();
  toast('音色已保存', true);
}

async function removeActiveVoice() {
  const id = $('f-active-voice').value;
  if (!id || id === '__builtin_edge__') {
    toast('内置音色删不掉');
    return;
  }
  const r = await window.fish.removeVoice(id);
  if (!r || !r.ok) {
    toast(r && r.error ? r.error : '删除失败');
    return;
  }
  applyState(r);
  fillVoiceSelect();
  toast('已删除', true);
}

async function activateVoice(id) {
  const r = await window.fish.activateVoice(id === '__builtin_edge__' ? '' : id);
  if (!r || !r.ok) {
    toast(r && r.error ? r.error : '切换失败');
    return;
  }
  applyState(r);
  fillVoiceSelect();
}

async function testActiveVoice() {
  const btn = $('btn-voice-test');
  btn.disabled = true;
  btn.textContent = '合成中…';
  const id = $('f-active-voice').value;
  const r = await window.fish.testVoice(id === '__builtin_edge__' ? '' : id);
  btn.disabled = false;
  btn.textContent = '试听';
  if (!r || !r.ok) {
    toast('试听失败：' + ((r && r.error) || '未知原因'));
    return;
  }
  playUrl(r.dataUrl);
  if (r.fallback) toast('本地/云端没成功，已用微软音色代替');
}

async function checkLocal() {
  const st = $('local-state');
  const note = $('voice-note');
  st.textContent = '检测中…';
  st.classList.remove('ok');
  const r = await window.fish.voiceStatus();
  const loc = (r && r.local) || {};
  if (loc.ready) {
    st.textContent = '已就绪';
    st.classList.add('ok');
    note.textContent = loc.device ? `本地引擎在跑：${loc.device}` : '本地引擎已就绪';
  } else if (loc.up) {
    st.textContent = loc.error ? '启动失败' : '加载中…';
    note.textContent = loc.error || '本地模型正在加载，稍等一会儿再点检测';
  } else {
    st.textContent = '没启动';
    const p = (r && r.paths) || {};
    if (!p.repoExists) note.textContent = '没找到 index-tts 目录（默认找 %USERPROFILE%\\index-tts）';
    else if (!p.pythonExists) note.textContent = '没找到环境里的 python（.venv\\Scripts\\python.exe）';
    else if (!p.modelExists) note.textContent = '没找到模型目录 checkpoints';
    else note.textContent = '点「启用本地」会拉起服务，模型加载约 30 秒';
  }
}

/** 手动启用本地音色：拉起 Python 服务并等模型加载完 */
async function startLocal() {
  const st = $('local-state');
  const note = $('voice-note');
  if ($('f-local-enabled') && !$('f-local-enabled').checked) {
    $('f-local-enabled').checked = true;
    await window.fish.setLocalEnabled(true).catch(() => {});
  }
  st.classList.remove('ok');
  st.textContent = '启动中…';
  note.textContent = '正在拉起本地语音服务，第一次要加载模型，约 30 秒，别关窗口';
  const r = await window.fish.startLocalVoice();
  if (r && r.ok) {
    st.textContent = '已就绪';
    st.classList.add('ok');
    note.textContent = r.device ? `本地引擎就绪：${r.device}` : '本地引擎就绪';
    toast('本地音色可以用了');
  } else {
    st.textContent = '启动失败';
    note.textContent = (r && r.error) || '本地服务没起来，看 tts-server.log';
    toast('本地语音没起来');
  }
}

/** 设置里的「本地语音模型」总开关 */
async function toggleLocalEnabled(on) {
  const st = $('local-state');
  const note = $('voice-note');
  if (!on) {
    st.classList.remove('ok');
    st.textContent = '已关闭';
    note.textContent = '本地模型已关闭，显存已释放；用本地音色时会自动换成微软晓晓';
    await window.fish.setLocalEnabled(false).catch(() => {});
    toast('本地语音已关闭，显存释放了');
    return;
  }
  st.classList.remove('ok');
  st.textContent = '启动中…';
  note.textContent = '正在加载本地模型，约 30 秒…';
  const r = await window.fish.setLocalEnabled(true).catch((e) => ({ ok: false, error: String(e) }));
  if (r && r.ok) {
    st.textContent = '已就绪';
    st.classList.add('ok');
    note.textContent = '本地语音已开启';
    toast('本地语音已开启');
  } else {
    st.textContent = '启动失败';
    note.textContent = (r && r.error) || '本地服务没起来，看 tts-server.log';
    toast('本地语音没起来');
  }
}


function rateLabel(v) {
  if (v === 0) return '正常';
  return (v > 0 ? '+' : '') + v + '%';
}

/* ───────────────── 首次向导 ───────────────── */

function welcomeProvider() {
  return WELCOME_PROVIDERS[$('w-provider').value] || WELCOME_PROVIDERS.deepseek;
}

function syncWelcome() {
  const p = welcomeProvider();
  $('w-provider-tip').textContent = p.tip;
  $('w-key-label').textContent = p.noKey ? '本机模型不用填 Key' : '把 API Key 粘在这里';
  const key = $('w-key');
  key.disabled = !!p.noKey;
  key.value = p.noKey ? '' : key.value;
  key.placeholder = p.noKey ? '走 localhost，不需要密钥' : 'sk-…';
  $('w-key-tip').textContent = p.noKey
    ? `装好 Ollama 后执行 ollama pull ${p.model}，地址默认 ${p.base}`
    : `在哪申请：${p.keyUrl}　（只存在本机，用 Windows 加密保存）`;
}

function showWelcome() {
  $('welcome').hidden = false;
  $('w-provider').value = 'deepseek';
  $('w-key').value = '';
  syncWelcome();
  setTimeout(() => { try { $('w-key').focus(); } catch (e) {} }, 60);
}

async function finishWelcome(skip) {
  const p = welcomeProvider();
  const key = skip ? '' : $('w-key').value.trim();
  const patch = { onboarded: true };
  if (!skip) {
    patch.apiStyle = p.style;
    patch.baseUrl = p.base;
    patch.model = p.model;
    if (key) patch.apiKey = key;
  }
  try {
    const st = await window.fish.saveSettings(patch);
    if (st && st.settings) S = st;
  } catch (err) {
    toast('保存失败：' + err);
  }
  $('welcome').hidden = true;
  applyName();
  applyTheme();
  renderAll();
  renderChat(false);
  updatePlaceholderHint();
  if (skip) toast('随时点右上角 ⚙ 填 Key', true);
  else if (p.noKey) toast(`本地模型：记得先 ollama pull ${p.model}`, true);
  else if (!key) toast('先记待办也行，聊天要等填了 Key', true);
  else toast('配好了，跟我说今天要做什么吧', true);
}

async function openSettings() {
  fillSettings();
  $('mask').hidden = false;
}

function closeSettings() {
  $('mask').hidden = true;
  applyTheme();
}

async function saveSettings() {
  const name = $('f-name').value.trim();
  const patch = {
    name: name || (S.name || '桌边'),
    persona: $('f-persona').value.trim(),
    baseUrl: $('f-base').value.trim() || (API_STYLE_PRESETS[$('f-style').value] || API_STYLE_PRESETS.openai).base,
    apiStyle: $('f-style').value || 'openai',
    model: ($('f-model').value === MODEL_CUSTOM ? $('f-model-custom').value.trim() : $('f-model').value) || 'deepseek-chat',
    theme: $('f-theme').value || 'auto',
    dayStart: $('f-daystart').value || '07:00',
    nightStart: $('f-nightstart').value || '19:00',
    voice: $('f-active-voice').value === '__builtin_edge__'
      ? (S.settings.voice || 'zh-CN-XiaoxiaoNeural')
      : (S.voices.find((v) => v.id === $('f-active-voice').value) || {}).edgeVoice || S.settings.voice || 'zh-CN-XiaoxiaoNeural',
    rate: Number($('f-rate').value) || 0,
    voiceVolume: Math.min(1, Math.max(0.15, Number($('f-volume').value) / 100 || 0.9)),
    voiceWarm: $('f-warm').checked,
    localUrl: $('f-localurl').value.trim() || 'http://127.0.0.1:8756',
    localEnabled: $('f-local-enabled').checked,
    autoSpeak: $('f-autospeak').checked,
    speakFull: $('f-speakfull').checked,
    briefOn: $('f-briefon').checked,
    briefMorning: $('f-morning').value || '09:00',
    briefEvening: $('f-evening').value || '21:00',
    autoStart: $('f-autostart').checked,
    uiOpacity: Number($('f-opacity').value) / 100,
    chatRetention: $('f-retention').value || '1m',
    ctxWindow: $('f-ctxwindow').value || '1w',
    ctxMode: $('f-ctxmode').value || 'mixed',
    aiSubtasks: $('f-ai-subtasks').checked,
    careOn: $('f-care-on').checked,
    careSpeak: $('f-care-speak') ? $('f-care-speak').checked : (S.settings.careSpeak !== false),
    careEvery: Math.max(15, Math.min(180, Number($('f-care-every').value) || 50)),
    quietStart: $('f-quiet-start').value || '22:30',
    quietEnd: $('f-quiet-end').value || '08:00',
  };
  const key = $('f-key').value.trim();
  if (key) patch.apiKey = key;
  const fish = $('f-fishkey').value.trim();
  if (fish) patch.fishKey = fish;
  const r = await window.fish.saveSettings(patch);
  applyState(r);
  fillPersonaSelect();
  fillCtxTip();
  closeSettings();
  toast('已保存', true);
}

/* ───────────────── 性格设定：导入文件 ───────────────── */

const PERSONA_MAX = 8000;

function setPersonaTip(msg) {
  const tip = $('persona-tip');
  if (!tip) return;
  if (!tip.dataset.def) tip.dataset.def = tip.textContent;
  tip.textContent = msg;
  clearTimeout(setPersonaTip._t);
  setPersonaTip._t = setTimeout(() => {
    tip.textContent = tip.dataset.def;
  }, 8000);
}

function applyPersonaText(text, meta = {}) {
  const box = $('f-persona');
  box.value = text;
  box.scrollTop = 0;
  const who = meta.name ? `「${meta.name}」` : '';
  const cut = meta.truncated ? '，超出 8000 字的部分已截断' : '';
  setPersonaTip(`已导入${who}（${text.length} 字${cut}）。点「保存」生效。`);
}

async function importPersona() {
  const r = await window.fish.pickPersonaFile();
  if (!r || !r.ok) {
    if (r && !r.canceled) toast('导入失败：' + (r.error || '未知原因'));
    return;
  }
  applyPersonaText(r.text, r);
}

/* ───────────────── 名字同步 ───────────────── */

function applyName() {
  const name = assistantName();
  $('brand-name').textContent = name;
  document.title = name;
  $('ph-text').textContent = '今天要做什么？点这里跟我说…';
  renderChat(false);
}

/* ───────────────── 渲染总入口 ───────────────── */

function renderAll() {
  if (!S) return;
  if (!viewDay) viewDay = S.today;
  renderDate();
  renderTodos();
  renderWeek();
  applyWeekExpanded();
  updateSendState();
  const btn = $('btn-mode');
  const desk = S.settings.mode === 'desk';
  btn.classList.toggle('desk', desk);
  btn.title = desk ? '当前：贴在桌面（点一下浮到最前）' : '当前：浮在所有窗口最前（点一下贴桌面）';
  applyTheme();
  applyLock();
}

/* ───────────────── 固定（锁位置 + 锁大小） ───────────────── */

function isLocked() {
  return !!(S && S.settings && S.settings.uiLocked);
}

// 锁住时：标题栏不再能拖、右下角抓手隐藏、主进程也拒绝改尺寸
function applyLock() {
  const on = isLocked();
  document.body.classList.toggle('locked', on);
  const card = $('card');
  if (card) card.classList.toggle('locked', on);
  const btn = $('btn-lock');
  if (btn) {
    btn.classList.toggle('on', on);
    btn.title = on ? '已固定（点一下解锁，可以拖动和调整大小）' : '固定：锁住位置和大小';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

/* ───────────────── 启动 ───────────────── */

// 右下角抓手：无边框透明窗口在 Windows 上不能拖边框，自己算尺寸
function setupGrip() {
  const grip = $('grip');
  if (!grip || !window.fish || !window.fish.resizeWindow) return;
  let base = null;
  let startPt = null;
  let raf = 0;
  let pending = null;

  const apply = () => {
    raf = 0;
    if (!pending) return;
    window.fish.resizeWindow(pending.w, pending.h);
    pending = null;
  };

  const onMove = (e) => {
    if (isLocked()) return;
    if (!base || !startPt) return;
    const w = Math.round(base.w + (e.screenX - startPt.x));
    const h = Math.round(base.h + (e.screenY - startPt.y));
    pending = { w, h };
    if (!raf) raf = requestAnimationFrame(apply);
  };

  const stop = () => {
    if (raf) { cancelAnimationFrame(raf); raf = 0; if (pending) { apply(); } }
    base = null;
    startPt = null;
    pending = null;
    document.body.classList.remove('resizing');
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', stop, true);
    window.removeEventListener('pointercancel', stop, true);
    window.removeEventListener('blur', stop, true);
  };

  grip.addEventListener('pointerdown', (e) => {
    if (isLocked()) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    base = {
      w: window.outerWidth || window.innerWidth || 392,
      h: window.outerHeight || window.innerHeight || 640,
    };
    startPt = { x: Math.round(e.screenX), y: Math.round(e.screenY) };
    document.body.classList.add('resizing');
    // 不用 setPointerCapture：合成指针会抛错，直接挂 window 更稳
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', stop, true);
    window.addEventListener('pointercancel', stop, true);
    window.addEventListener('blur', stop, true);
  });

  grip.addEventListener('dblclick', () => {
    window.fish.resizeWindow(392, 640);
  });
}

/* ───────────────── 关怀 / 提醒气泡 ───────────────── */

let careTimer = null;

function showCare(text, kind) {
  const box = $('careBubble');
  if (!box || !text) return;
  box.innerHTML = '';
  box.appendChild(el('span', 'cb-kind', kind === 'reminder' ? '提醒' : S.name || '关怀'));
  box.appendChild(el('span', '', text));
  box.hidden = false;
  clearTimeout(careTimer);
  careTimer = setTimeout(() => { box.hidden = true; }, 15000);
}

function bindCare() {
  const box = $('careBubble');
  if (box) {
    box.addEventListener('click', () => { box.hidden = true; expand(); });
  }
  window.fish.onCare(({ text, kind, speak: speakIt }) => {
    showCare(text, kind);
    if (speakIt !== false) {
      // 关怀/提醒也用当前音色念出来；失败静默（不打断用户）
      Promise.resolve(speak(text, { quick: true })).catch((e) => { window.__careErr = String((e && e.message) || e); });
    }
  });
}


/* ─────────────── 聊天记录管理 ─────────────── */

const LOG_RANGE_LABEL = { all: '全部时间', today: '今天', '7d': '近 7 天', '30d': '近 30 天', '90d': '近 90 天' };
let logState = { range: 'all', q: '', items: [], offset: 0, total: 0, hasMore: false, loading: false };
let logSearchTimer = null;

function logMaskEl() {
  return document.getElementById('logMask');
}

function logsOpen() {
  const m = logMaskEl();
  return !!m && !m.hidden;
}

function logDayLabel(day, today) {
  if (!day) return '未知日期';
  const d = parseDay(day);
  if (!d) return day;
  const md = day.slice(5).replace('-', '-');
  const wd = WD[(d.getDay() + 6) % 7];
  const head = `${md} ${wd}`;
  return day === today ? `${head} · 今天` : head;
}

function logClock(at) {
  const d = new Date(at);
  if (!Number.isFinite(d.getTime())) return '--:--';
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

async function openLogs() {
  const m = logMaskEl();
  if (!m) return;
  m.hidden = false;
  $('log-range').value = 'all';
  $('log-q').value = '';
  logState = { range: 'all', q: '', items: [], offset: 0, total: 0, hasMore: false, loading: false };
  renderLogs();
  await loadLogs(true);
}

function closeLogs() {
  const m = logMaskEl();
  if (m) m.hidden = true;
}

async function loadLogs(reset) {
  if (logState.loading) return;
  logState.loading = true;
  try {
    const r = await window.fish.listLog({
      range: logState.range,
      q: logState.q,
      limit: 200,
      offset: reset ? 0 : logState.offset,
    });
    if (!r || r.ok === false) {
      toast('读不到聊天记录');
      return;
    }
    logState.items = reset ? r.items || [] : logState.items.concat(r.items || []);
    logState.offset = logState.items.length;
    logState.total = r.total || 0;
    logState.hasMore = !!r.hasMore;
    renderLogs(r);
  } catch (err) {
    toast('读不到聊天记录：' + String((err && err.message) || err));
  } finally {
    logState.loading = false;
  }
}

function renderLogs(meta) {
  const box = $('log-list');
  if (!box) return;
  const total = meta ? meta.total : logState.total;
  $('log-count').textContent = total ? `${total} 条` : '';
  $('log-hint').textContent = total
    ? `${LOG_RANGE_LABEL[logState.range] || ''}${logState.q ? ' · 含「' + logState.q + '」' : ''} · 共 ${total} 条`
    : '';
  $('btn-log-more').hidden = !logState.hasMore;

  if (!logState.items.length) {
    box.innerHTML = '<div class="log-empty">这个范围里没有聊天记录。</div>';
    return;
  }

  const today = S.today || dayKey(new Date());
  const frag = document.createDocumentFragment();
  let lastDay = '';
  for (const m of logState.items) {
    if (m.day !== lastDay) {
      lastDay = m.day;
      const head = document.createElement('div');
      head.className = 'log-day';
      const label = document.createElement('span');
      label.textContent = logDayLabel(m.day, today);
      const del = document.createElement('button');
      del.className = 'ghost mini day-del';
      del.type = 'button';
      del.textContent = '删这天';
      del.dataset.day = m.day;
      const line = document.createElement('span');
      line.className = 'ln';
      head.append(label, line, del);
      frag.append(head);
    }
    const row = document.createElement('div');
    row.className = 'log-item' + (m.role === 'user' ? ' me' : '');
    row.dataset.id = m.id;

    const time = document.createElement('div');
    time.className = 'log-time';
    time.textContent = logClock(m.at);

    const main = document.createElement('div');
    main.className = 'log-main';
    const txt = document.createElement('div');
    txt.className = 'log-text';
    txt.textContent = m.brief ? `〔播报〕${m.text}` : m.text;
    main.append(txt);
    if (m.say && m.say !== m.text) {
      const say = document.createElement('div');
      say.className = 'log-say has';
      say.textContent = '喇叭里念的：' + m.say;
      main.append(say);
    }

    const del = document.createElement('button');
    del.className = 'log-del';
    del.type = 'button';
    del.title = '删除这条';
    del.textContent = '✕';

    row.append(time, main, del);
    frag.append(row);
  }

  box.innerHTML = '';
  box.append(frag);
}

async function deleteLogItem(id) {
  if (!id) return;
  const r = await window.fish.deleteLogs([id]);
  if (!r || r.ok === false) {
    toast(r && r.error ? r.error : '没删掉');
    return;
  }
  applyState(r);
  await loadLogs(true);
  toast('删掉了 1 条', true);
}

async function deleteLogDay(day) {
  if (!day) return;
  const label = logDayLabel(day, S.today || dayKey(new Date()));
  const yes = await askModal({
    title: '删除这一天的记录',
    label: `${label} 的全部聊天记录都会删掉，删了就找不回来。`,
    okLabel: '删除',
    withInput: false,
  });
  if (yes === null) return;
  const r = await window.fish.deleteLogDay(day);
  if (!r || r.ok === false) {
    toast(r && r.error ? r.error : '没删掉');
    return;
  }
  applyState(r);
  await loadLogs(true);
  toast(`删掉了 ${r.removed} 条`, true);
}

async function clearLogs() {
  const total = logState.total || (logState.items || []).length;
  if (!total) {
    toast('已经是空的了');
    return;
  }
  const yes = await askModal({
    title: '清空聊天记录',
    label: `当前人设的 ${total} 条聊天记录会全部删掉（保留期不会帮你留备份）。待办不受影响。`,
    okLabel: '全部删除',
    withInput: false,
  });
  if (yes === null) return;
  const r = await window.fish.clearLog();
  if (!r || r.ok === false) {
    toast('没删掉');
    return;
  }
  applyState(r);
  await loadLogs(true);
  toast(`清空了 ${r.removed} 条`, true);
}

function bindLogs() {
  const open = $('btn-open-logs');
  if (open) open.addEventListener('click', () => { void openLogs(); });
  const close = $('btn-close-logs');
  if (close) close.addEventListener('click', closeLogs);
  const range = $('log-range');
  if (range) {
    range.addEventListener('change', () => {
      logState.range = range.value;
      void loadLogs(true);
    });
  }
  const q = $('log-q');
  if (q) {
    q.addEventListener('input', () => {
      clearTimeout(logSearchTimer);
      logSearchTimer = setTimeout(() => {
        logState.q = q.value.trim();
        void loadLogs(true);
      }, 260);
    });
  }
  const more = $('btn-log-more');
  if (more) more.addEventListener('click', () => { void loadLogs(false); });
  const clear = $('btn-log-clear');
  if (clear) clear.addEventListener('click', () => { void clearLogs(); });
  const exp = $('btn-log-export');
  if (exp) {
    exp.addEventListener('click', async () => {
      exp.disabled = true;
      try {
        const r = await window.fish.exportLog({ range: logState.range || 'all', q: logState.q || '' });
        if (r && r.ok) toast(`已导出 ${r.count} 条：${r.path}`, true);
        else if (r && r.canceled) { /* 用户取消，不提示 */ }
        else toast((r && r.error) || '导出失败');
      } catch (err) {
        toast('导出失败：' + String(err && err.message ? err.message : err));
      } finally {
        exp.disabled = false;
      }
    });
  }

  const list = $('log-list');
  if (list) {
    // 事件委托：点行展开全文 / 点 ✕ 删这条 / 点「删这天」
    list.addEventListener('click', (ev) => {
      const del = ev.target.closest('.log-del');
      if (del) {
        ev.stopPropagation();
        const row = del.closest('.log-item');
        if (row) void deleteLogItem(row.dataset.id);
        return;
      }
      const dayDel = ev.target.closest('.day-del');
      if (dayDel) {
        ev.stopPropagation();
        void deleteLogDay(dayDel.dataset.day);
        return;
      }
      const row = ev.target.closest('.log-item');
      if (row) row.classList.toggle('open');
    });
  }
}

function bindJump() {
  const bar = $('jump-bar');
  if (!bar) return;
  bar.addEventListener('click', (ev) => {
    const b = ev.target.closest('.jump');
    if (!b) return;
    const target = document.getElementById(b.dataset.jump);
    const body = document.querySelector('.panel-body');
    if (target && body) body.scrollTo({ top: Math.max(0, target.offsetTop - 8), behavior: 'smooth' });
  });
}

function bindEvents() {
  bindLogs();
  if (todosEl) todosEl.addEventListener('scroll', updateTodoFade);
  $('btn-week-toggle').addEventListener('click', toggleWeek);
  bindJump();
  $('placeholder').addEventListener('click', () => expand());
  $('btn-chat-close').addEventListener('click', () => collapse());

  const opSlider = $('f-opacity');
  const opLive = () => applyOpacity(Number(opSlider.value) / 100);
  opSlider.addEventListener('input', opLive);
  opSlider.addEventListener('change', opLive);
  opSlider.addEventListener('wheel', (e) => {
    e.preventDefault();
    const step = (e.deltaY > 0 ? -1 : 1);
    opSlider.value = String(Math.min(100, Math.max(55, Number(opSlider.value) + step)));
    opLive();
  }, { passive: false });
  // 点待办区（含勾选、日期条）时把对话收起来，把空间还给清单
  scroll.addEventListener('click', () => {
    if (expanded) collapse();
  });

  input.addEventListener('focus', () => expand(false));
  input.addEventListener('input', () => {
    updateSendState();
    input.style.height = 'auto';
    input.style.height = Math.min(150, input.scrollHeight) + 'px';
  });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!busy) send(input.value);
    }
    if (e.key === 'Escape') { e.preventDefault(); collapse(); }
  });

  sendBtn.addEventListener('click', () => send(input.value));

  $('btn-undo').addEventListener('click', async () => {
    S = await window.fish.undo();
    renderAll();
    toast('已撤销', true);
  });

  $('f-model').addEventListener('change', syncModelUi);
  $('f-style').addEventListener('change', syncStyleUi);

  $('w-provider').addEventListener('change', syncWelcome);
  $('btn-welcome-ok').addEventListener('click', () => finishWelcome(false));
  $('btn-welcome-skip').addEventListener('click', () => finishWelcome(true));

  $('btn-mode').addEventListener('click', async () => {
    const next = S.settings.mode === 'desk' ? 'float' : 'desk';
    S = await window.fish.setMode(next);
    renderAll();
  });

  const lockBtn = $('btn-lock');
  if (lockBtn) {
    lockBtn.addEventListener('click', async () => {
      const next = !isLocked();
      S = await window.fish.saveSettings({ uiLocked: next });
      applyLock();
      toast(next ? '已固定：位置和大小都锁住了' : '已解锁：可以拖动和调整大小', true);
    });
  }

  $('btn-theme').addEventListener('click', async () => {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    S = await window.fish.saveSettings({ theme: next });
    applyTheme();
    renderAll();
    toast(next === 'light' ? '切到白天' : '切到夜间', true);
  });

  $('btn-hide').addEventListener('click', () => window.fish.hide());
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-close-settings').addEventListener('click', closeSettings);
  $('btn-save').addEventListener('click', () => saveSettings().catch((e) => toast(String(e))));

  $('btn-clear-key').addEventListener('click', async () => {
    S = await window.fish.saveSettings({ clearKey: true });
    fillSettings();
    toast('Key 已清除', true);
  });

  $('btn-test').addEventListener('click', () => {
    speak('今天有三件事要做，我建议先从成本分析表开始，大概四十分钟能弄完。');
  });

  // ── 音色库 ──
  $('f-active-voice').addEventListener('change', (e) => {
    activateVoice(e.target.value).catch((err) => toast(String(err)));
  });
  $('btn-voice-add').addEventListener('click', openVoiceForm);
  $('btn-voice-cancel').addEventListener('click', closeVoiceForm);
  $('btn-voice-pick').addEventListener('click', () => pickVoiceAudio().catch((e) => toast(String(e))));
  $('btn-voice-save').addEventListener('click', () => saveVoice().catch((e) => toast(String(e))));
  $('btn-voice-remove').addEventListener('click', () => removeActiveVoice().catch((e) => toast(String(e))));
  $('btn-voice-test').addEventListener('click', () => testActiveVoice().catch((e) => toast(String(e))));
  $('btn-local-check').addEventListener('click', () => checkLocal().catch((e) => toast(String(e))));
  $('btn-local-start').addEventListener('click', () => startLocal().catch((e) => toast(String(e))));
  $('f-local-enabled').addEventListener('change', () => {
    toggleLocalEnabled($('f-local-enabled').checked).catch((e) => toast(String(e)));
  });
  $('vf-engine').addEventListener('change', syncVoiceForm);

  $('btn-theme-swap').addEventListener('click', () => {
    $('f-theme').value = effectiveTheme() === 'dark' ? 'light' : 'dark';
    $('f-theme').dispatchEvent(new Event('change'));
  });

  // 应用内输入框
  $('btn-ask-ok').addEventListener('click', () => {
    const inp = $('ask-input');
    const visible = inp.style.display !== 'none';
    closeAsk(visible ? (inp.value.trim() || null) : true);
  });
  $('btn-ask-cancel').addEventListener('click', () => closeAsk(null));
  $('ask-input').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      closeAsk($('ask-input').value.trim() || null);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      closeAsk(null);
    }
  });

  // 关怀
  $('f-care-every').addEventListener('input', () => {
    $('care-every-label').textContent = $('f-care-every').value + ' 分钟';
  });
  $('btn-care-test').addEventListener('click', async () => {
    const r = await window.fish.testCare();
    if (r && r.ok === false) toast('没说出话：' + (r.error || '未知原因'));
  });

  // 提醒
  $('btn-remind-add').addEventListener('click', openRemindForm);
  $('btn-remind-cancel').addEventListener('click', closeRemindForm);
  $('btn-remind-save').addEventListener('click', saveRemindForm);
  $('rf-kind').addEventListener('change', syncRemindForm);
  $('btn-remind-preset').addEventListener('click', async () => {
    const r = await window.fish.saveReminder({ title: '起来走两步，别一直坐着', kind: 'every', everyMin: 60, on: true });
    S.reminders = r.reminders;
    renderReminders();
    toast('加好了：每小时提醒一次');
  });

  $('f-persona-sel').addEventListener('change', () => { switchPersona($('f-persona-sel').value); });
  $('btn-persona-new').addEventListener('click', () => { newPersona(); });
  $('btn-persona-del').addEventListener('click', () => { removePersona(); });
  for (const id of ['f-retention', 'f-ctxwindow', 'f-ctxmode']) {
    $(id).addEventListener('change', async () => {
      const patch = {
        chatRetention: $('f-retention').value,
        ctxWindow: $('f-ctxwindow').value,
        ctxMode: $('f-ctxmode').value,
      };
      const res = await window.fish.saveSettings(patch);
      applyState(res);
      fillCtxTip();
      toast('已保存', true);
    });
  }
  $('btn-confirm-once').addEventListener('click', () => {
    const p = pendingConfirm;
    pendingConfirm = null;
    closeConfirm();
    if (p) send(p.msg, true);
  });
  $('btn-confirm-silent').addEventListener('click', () => {
    const p = pendingConfirm;
    pendingConfirm = null;
    closeConfirm();
    if (p) send(p.msg, 'silent');
  });
  $('btn-confirm-cancel').addEventListener('click', () => {
    pendingConfirm = null;
    closeConfirm();
  });

  $('f-theme').addEventListener('change', async () => {
    S = await window.fish.saveSettings({ theme: $('f-theme').value });
    applyTheme();
  });

  $('f-rate').addEventListener('input', (e) => {
    $('rate-label').textContent = rateLabel(Number(e.target.value) || 0);
  });

  $('f-volume').addEventListener('input', (e) => {
    $('volume-label').textContent = (Number(e.target.value) || 0) + '%';
  });
  // 音量和「柔和」都立刻生效，试听时能马上听出来
  $('f-volume').addEventListener('change', async () => {
    S = await window.fish.saveSettings({ voiceVolume: Math.min(1, Math.max(0.15, Number($('f-volume').value) / 100 || 0.9)) });
  });
  $('f-warm').addEventListener('change', async () => {
    S = await window.fish.saveSettings({ voiceWarm: $('f-warm').checked });
  });

  $('btn-persona-import').addEventListener('click', () => {
    importPersona().catch((e) => toast(String(e)));
  });

  $('btn-persona-clear').addEventListener('click', () => {
    $('f-persona').value = '';
    setPersonaTip('已清空，点「保存」生效。');
  });

  // 直接把 .md / .txt 拖进性格框
  const personaBox = $('f-persona');
  personaBox.addEventListener('dragover', (e) => {
    e.preventDefault();
    personaBox.classList.add('dragover');
  });
  personaBox.addEventListener('dragleave', () => personaBox.classList.remove('dragover'));
  personaBox.addEventListener('drop', async (e) => {
    e.preventDefault();
    personaBox.classList.remove('dragover');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    try {
      const raw = (await f.text()).replace(/\r\n?/g, '\n').trim();
      if (!raw) { toast('这个文件是空的'); return; }
      const truncated = raw.length > PERSONA_MAX;
      applyPersonaText(truncated ? raw.slice(0, PERSONA_MAX) : raw, { name: f.name, truncated });
    } catch (err) {
      toast('读取失败：' + String(err && err.message || err));
    }
  });

  $('wk-prev').addEventListener('click', () => {
    if (weekExpanded) shiftMonth(-1); else { weekOffset -= 1; renderWeek(); }
  });
  $('wk-next').addEventListener('click', () => {
    if (weekExpanded) shiftMonth(1); else { weekOffset += 1; renderWeek(); }
  });

  $('btn-today').addEventListener('click', () => {
    viewDay = S.today;
    weekOffset = 0;
    renderAll();
  });

  let wheelLock = 0;
  $('week').addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaX) < 8 && Math.abs(e.deltaY) < 8) return;
    e.preventDefault();
    const now = Date.now();
    if (now - wheelLock < 260) return;
    wheelLock = now;
    const dir = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) > 0 ? 1 : -1;
    if (weekExpanded) shiftMonth(dir); else { weekOffset += dir; renderWeek(); }
  }, { passive: false });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('askMask').hidden) closeAsk(null);
      else if (logsOpen()) closeLogs();
      else if (!$('mask').hidden) closeSettings();
      else if (expanded) collapse();
    }
    if (e.key === 'r' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      window.fish.runBrief('morning');
    }
  });

  window.fish.onFocusInput(() => expand());
  window.fish.onMode(() => renderAll());
  window.fish.onOpenSettings(() => openSettings());
  window.fish.onIdentity((p) => {
    if (p && p.name) {
      S.name = p.name;
      applyName();
    }
  });

  window.fish.onSpeak((text) => speak(text));

  window.fish.onBrief((brief) => {
    pushChat({
      role: 'ai',
      text: brief.reply || brief.say,
      say: brief.say,
      brief: brief.kind,
      time: nowHM(),
    });
    if (S && S.settings && S.settings.autoSpeak) speak(brief.say);
    toast(brief.kind === 'morning' ? '早间播报' : '晚间播报', true);
  });
}

// 切人设后重新铺对话：每个人设只显示自己的记录
function rebuildChatFromState() {
  chat = [];
  for (const m of (S.log || []).slice(-2)) {
    chat.push({
      role: m.role === 'user' ? 'me' : 'ai',
      text: m.text,
      say: m.say,
      sum: m.sum,
      time: m.at ? new Date(m.at).toTimeString().slice(0, 5) : '',
    });
  }
}

async function boot() {
  bindEvents();
  bindCare();
  try {
    S = await window.fish.getState();
  } catch (err) {
    toast('初始化失败：' + err);
    return;
  }

  viewDay = S.today;
  rebuildChatFromState();

  applyName();
  if (S && S.settings) applyOpacity(S.settings.uiOpacity);
  renderAll();
  renderChat(false);
  if (todosEl) todosEl.scrollTop = 0;
  updatePlaceholderHint();
  tickClock();
  setInterval(tickClock, 1000);
  setInterval(() => { applyTheme(); if (S && viewDay === S.today) renderWeek(); }, 30000);

  const styleNow = S.settings.apiStyle || 'openai';
  if (S.settings.onboarded !== true) {
    // 第一次用：先给向导，里面就能选服务商、填 Key
    showWelcome();
  } else if (!S.settings.hasKey && styleNow !== 'ollama') {
    pushChat({
      role: 'ai',
      text: `我是${assistantName()}。先在右上角 ⚙ 里填一个 DeepSeek API Key，我就能帮你排今天的活了。`,
      time: nowHM(),
    });
    setTimeout(openSettings, 400);
  } else if (!chat.length) {
    pushChat({ role: 'ai', text: `${assistantName()}在。今天想干点什么？`, time: nowHM() });
  }

  setupGrip();

  window.fish.version().then((v) => {
    $('ver').textContent = `v${v.version} · Electron ${v.electron}`;
  }).catch(() => {});
}

boot();
