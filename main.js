'use strict';

/**
 * 桌边 Deskside — 常驻桌面的 AI 备忘录助理
 * 主进程：窗口 / 托盘 / 全局快捷键 / 存储 / DeepSeek 调用 / 语音合成 / 定时简报
 */

const {
  app, BrowserWindow, ipcMain, Tray, Menu, globalShortcut,
  nativeImage, safeStorage, screen, shell, Notification, dialog, nativeTheme,
} = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const { makeTts, DEFAULTS: TTS_DEFAULTS } = require('./tts');

const APP_NAME = '桌边';
const VOICE_DEFAULT = 'zh-CN-XiaoxiaoNeural';

app.setName(APP_NAME);
if (process.env.FISH_DATA_DIR) app.setPath('userData', process.env.FISH_DATA_DIR);

const DATA_DIR = () => app.getPath('userData');
const STORE_FILE = () => path.join(DATA_DIR(), 'store.json');
const TTS_DIR = () => path.join(DATA_DIR(), 'tts');
const VOICE_DIR = () => path.join(DATA_DIR(), 'voices');

const HOTKEY_MAIN = 'Control+Alt+Space';
const HOTKEY_ALT = 'Control+Alt+M';

// 启动日志：只记关键几步，方便事后排查（比如快捷键没抢到）
function logBoot(msg) {
  try {
    fs.appendFileSync(path.join(DATA_DIR(), 'boot.log'), `${new Date().toISOString()} ${msg}\n`);
  } catch { /* ignore */ }
}

const DEFAULT_SETTINGS = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiStyle: 'openai',      // openai | anthropic | ollama
  apiKeyEnc: '',
  name: APP_NAME,          // 助手名字，可自定义
  persona: '',             // 性格设定，自由文本
  theme: 'auto',           // auto | light | dark
  dayStart: '07:00',       // auto 模式下几点切白天
  nightStart: '19:00',     // auto 模式下几点切夜间
  voice: VOICE_DEFAULT,
  rate: 0,                 // 语速偏移，百分比
  voiceEngine: 'edge',     // edge | local | fish —— 没有角色音色时的默认引擎
  activeVoiceId: '',       // 当前使用的角色音色 id（空=用内置 edge 音色）
  fishKeyEnc: '',          // Fish Audio API Key（加密存储）
  localUrl: 'http://127.0.0.1:8756',
  localEnabled: true,      // 本地语音模型开关（关=不拉起、立刻释放显存，本地音色回落 edge）
  ttsSteps: 14,           // 本地模型的采样步数：14 快、25 最像（模型代码需支持 INDEXTTS_DIFFUSION_STEPS）
  localPython: '',         // 本地 TTS 的 python.exe（空=自动找 index-tts 下的 .venv）
  localRepo: '',           // index-tts 仓库目录（空=自动找）
  localScript: '',         // tts-server.py 路径（空=用程序目录里那份）
  autoSpeak: true,         // AI 回复后自动朗读
  speakFull: false,        // true 读全文，false 读 say 摘要
  mode: 'float',           // float=浮在最前  desk=贴桌面
  voiceVolume: 0.9,        // 朗读音量 0.15~1
  voiceWarm: true,         // 朗读时削一点高频（云端音色容易刺耳）
  uiOpacity: 0.92,         // 卡片不透明度 0.55~1（默认微透，低于 0.92 自动补对比度）
  uiLocked: false,         // 固定窗口：锁住位置和大小
  onboarded: false,        // 首次向导是否看过（只弹一次）
  opacity: 1,
  autoStart: true,
  briefOn: true,
  briefMorning: '09:00',
  briefEvening: '21:00',
  // 聊天记录保留期与上下文读取窗口：3d | 1w | 1m | 3m | 1y | forever
  chatRetention: '1m',
  ctxWindow: '1w',
  ctxMode: 'mixed',        // full=全原文；mixed=近 3 天原文 + 更早只发摘要
  ctxWarnAck: '',          // 已选「不再提醒」的档位，逗号分隔，如 '100,200'
  aiSubtasks: true,        // AI 是否自动把待办拆成子步骤
  careOn: true,            // 日常关怀（喝水/久坐/护眼…）
  careEvery: 50,           // 关怀间隔（分钟）
  careSpeak: true,         // 关怀是否念出来
  remindSpeak: true,       // 提醒是否念出来
  quietStart: '22:30',     // 静默开始（不朗读、不弹关怀）
  quietEnd: '08:00',       // 静默结束
};

let win = null;
let tray = null;
let quitting = false;
let store = null;
let saveTimer = null;
let undoStack = [];
let lastBriefKey = '';
let briefTimer = null;

/* ─────────────────────────── 存储 ─────────────────────────── */

function emptyStore() {
  return {
    todos: [], archive: [], voices: [],
    personas: [], logs: {}, activePersonaId: '',
    reminders: [],
    settings: { ...DEFAULT_SETTINGS }, meta: {},
  };
}

function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE(), 'utf8'));
    const s = { ...emptyStore(), ...raw };
    s.settings = { ...DEFAULT_SETTINGS, ...(raw.settings || {}) };
    s.todos = Array.isArray(s.todos) ? s.todos : [];
    s.archive = Array.isArray(s.archive) ? s.archive : [];
    s.log = Array.isArray(s.log) ? s.log : [];
    s.voices = Array.isArray(s.voices) ? s.voices : [];
    s.personas = Array.isArray(s.personas) ? s.personas : [];
    s.logs = (s.logs && typeof s.logs === 'object' && !Array.isArray(s.logs)) ? s.logs : {};
    s.reminders = Array.isArray(s.reminders) ? s.reminders : [];
    s.meta = s.meta || {};
    return s;
  } catch {
    return emptyStore();
  }
}

function saveNow() {
  if (!store) return;
  try {
    fs.mkdirSync(DATA_DIR(), { recursive: true });
    const tmp = STORE_FILE() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
    fs.renameSync(tmp, STORE_FILE());
  } catch (err) {
    console.error('[store] save failed', err);
  }
}

function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 250);
}

function snapshot() {
  undoStack.push(JSON.stringify({ todos: store.todos, logs: store.logs }));
  if (undoStack.length > 30) undoStack.shift();
}

/* ─────────────────────────── 时间 ─────────────────────────── */

const pad = (n) => String(n).padStart(2, '0');

function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function clockKey(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function weekdayCN(d = new Date()) {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
}

function daysBetween(a, b) {
  const ms = new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00');
  return Math.round(ms / 86400000);
}

/* ─────────────────────────── 待办 ─────────────────────────── */

let idSeq = 0;
function newId(prefix) {
  idSeq += 1;
  return `${prefix}${Date.now().toString(36).slice(-4)}${idSeq}`;
}

const PRIOS = new Set(['high', 'mid', 'low']);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

// 助手名字（用于标题、托盘、AI 自称），空则回退默认
function assistantName() {
  const n = String(store?.settings?.name || '').trim();
  return n || APP_NAME;
}

/* ─────────────────── 人设 / 聊天记录（按人设分开存） ─────────────────── */

const RETENTION_DAYS = { '3d': 3, '1w': 7, '1m': 30, '3m': 90, '1y': 365 };
const LOG_HARD_CAP = 20000;   // 纯保底，防止异常数据把文件撑爆

function retentionDays() {
  const k = String(store.settings.chatRetention || '1m');
  return k === 'forever' ? 0 : (RETENTION_DAYS[k] || 30);
}

function ctxDays() {
  const k = String(store.settings.ctxWindow || '1w');
  return k === 'forever' ? 0 : (RETENTION_DAYS[k] || 7);
}

function activePersona() {
  if (!Array.isArray(store.personas) || !store.personas.length) ensurePersona();
  return store.personas.find((p) => p.id === store.activePersonaId) || store.personas[0];
}

function logFor(id = store.activePersonaId) {
  if (!store.logs || typeof store.logs !== 'object') store.logs = {};
  if (!Array.isArray(store.logs[id])) store.logs[id] = [];
  return store.logs[id];
}

function newLogId() {
  return 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function pushLog(entry, id = store.activePersonaId) {
  const arr = logFor(id);
  if (!entry.id) entry.id = newLogId();
  arr.push(entry);
  if (arr.length > LOG_HARD_CAP) store.logs[id] = arr.slice(-LOG_HARD_CAP);
  return arr;
}

// 老数据迁移：单份 store.log → 当前人设的日志；保证至少有一个默认人设
function ensurePersona() {
  if (!Array.isArray(store.personas)) store.personas = [];
  if (!store.logs || typeof store.logs !== 'object' || Array.isArray(store.logs)) store.logs = {};

  if (!store.personas.length) {
    const p = {
      id: 'p1',
      name: String(store.settings.name || '').trim() || APP_NAME,
      persona: String(store.settings.persona || ''),
      voiceId: String(store.settings.activeVoiceId || ''),
      createdAt: new Date().toISOString(),
    };
    store.personas.push(p);
    store.activePersonaId = p.id;
  }
  if (!store.personas.some((p) => p.id === store.activePersonaId)) {
    store.activePersonaId = store.personas[0].id;
  }
  for (const p of store.personas) if (!Array.isArray(store.logs[p.id])) store.logs[p.id] = [];

  if (Array.isArray(store.log) && store.log.length) {
    const id = store.activePersonaId;
    store.logs[id] = store.logs[id].concat(store.log);
    delete store.log;
  }
}

// 按保留期清理每个人的聊天记录（待办不受影响，永久保留）
function pruneLogs() {
  const days = retentionDays();
  if (!days) return 0;
  const cut = Date.now() - days * 86400000;
  let removed = 0;
  for (const p of store.personas) {
    const arr = store.logs[p.id];
    if (!Array.isArray(arr) || !arr.length) continue;
    const keep = arr.filter((m) => {
      const t = Date.parse(m.at || '');
      return !Number.isFinite(t) || t >= cut;
    });
    removed += arr.length - keep.length;
    store.logs[p.id] = keep;
  }
  return removed;
}

// 把当前人设的设定写回 personas[]（名字 / 性格 / 音色都跟着人设走）
function syncActivePersona() {
  const p = activePersona();
  if (!p) return;
  p.name = String(store.settings.name || '').trim() || APP_NAME;
  p.persona = String(store.settings.persona || '');
  p.voiceId = String(store.settings.activeVoiceId || '');
}

function personaBrief(p) {
  return {
    id: p.id,
    name: p.name,
    voiceId: p.voiceId || '',
    turns: (store.logs[p.id] || []).length,
  };
}

function normalizePrio(p) {
  const v = String(p || '').toLowerCase();
  if (v === 'high' || v === '高' || v === 'p0') return 'high';
  if (v === 'low' || v === '低' || v === 'p2') return 'low';
  return 'mid';
}

function addTodo(o = {}) {
  const title = String(o.title || '').trim();
  if (!title) return null;
  const todo = {
    id: newId('t'),
    title: title.slice(0, 200),
    prio: normalizePrio(o.prio),
    est: Math.max(0, Math.min(600, Number(o.est) || 0)),
    day: isDate(o.day) ? o.day : isDate(o.due) ? o.due : dateKey(),
    due: isDate(o.due) ? o.due : '',
    note: String(o.note || '').slice(0, 500),
    subs: (Array.isArray(o.subs) ? o.subs : [])
      .map((t) => String(t || '').trim())
      .filter(Boolean)
      .slice(0, 12)
      .map((t) => ({ id: newId('s'), title: t.slice(0, 120), done: false })),
    repeat: normalizeRepeat(o.repeat),
    done: o.done === true,
    created: dateKey(),
    doneAt: o.done === true ? new Date().toISOString() : null,
  };
  store.todos.push(todo);
  return todo;
}

const REPEAT_KINDS = ['daily', 'weekly', 'monthly'];

function normalizeRepeat(v) {
  const k = String(v || '').trim().toLowerCase();
  return REPEAT_KINDS.includes(k) ? k : '';
}

/* 周期待办：算出下一次的日期（YYYY-MM-DD） */
function nextRepeatDay(day, kind) {
  const base = isDate(day) ? new Date(day + 'T00:00:00') : new Date();
  if (kind === 'daily') base.setDate(base.getDate() + 1);
  else if (kind === 'weekly') base.setDate(base.getDate() + 7);
  else if (kind === 'monthly') {
    const d = base.getDate();
    base.setDate(1);
    base.setMonth(base.getMonth() + 1);
    const last = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
    base.setDate(Math.min(d, last));
  }
  return dateKey(base);
}

/* 勾掉一条周期待办时，按周期排出下一次（子任务全部复位） */
function spawnNextRepeat(t) {
  if (!t || !t.repeat) return null;
  const nextDay = nextRepeatDay(t.doneAt ? dateKey(new Date(t.doneAt)) : todoDay(t), t.repeat);
  // 同一周期已经有未完成的实例就不重复造
  const exists = store.todos.find((x) => !x.done && x.title === t.title && x.repeat === t.repeat && todoDay(x) === nextDay);
  if (exists) return exists;
  const next = addTodo({
    title: t.title,
    prio: t.prio,
    est: t.est,
    day: nextDay,
    due: '',
    note: t.note,
    repeat: t.repeat,
    subs: (t.subs || []).map((s) => s.title),
  });
  return next;
}

function findTodo(id) {
  return store.todos.find((t) => t.id === id) || null;
}

function applyOps(ops) {
  const applied = [];
  for (const raw of Array.isArray(ops) ? ops : []) {
    const op = raw && raw.op;
    try {
      if (op === 'add') {
        const t = addTodo(raw);
        if (t) applied.push(`+${t.title}`);
      } else if (op === 'complete') {
        const t = findTodo(raw.id);
        if (t && !t.done) {
          t.done = true;
          t.doneAt = new Date().toISOString();
          const nx = spawnNextRepeat(t);
          applied.push(`✓${t.title}${nx ? ' · 下次 ' + todoDay(nx) : ''}`);
        }
      } else if (op === 'update') {
        const t = findTodo(raw.id);
        if (t) {
          if (raw.title) t.title = String(raw.title).slice(0, 200);
          if (raw.prio) t.prio = normalizePrio(raw.prio);
          if (raw.est !== undefined && raw.est !== null) {
            t.est = Math.max(0, Math.min(600, Number(raw.est) || 0));
          }
          if (raw.note !== undefined) t.note = String(raw.note || '').slice(0, 500);
          if (isDate(raw.day)) t.day = raw.day;
          if (raw.due) t.due = isDate(raw.due) ? raw.due : t.due;
          if (raw.repeat !== undefined) t.repeat = normalizeRepeat(raw.repeat);
          if (Array.isArray(raw.subs)) {
            const have = new Set(t.subs.map((s) => s.title));
            for (const s of raw.subs) {
              const title = String(s || '').trim();
              if (title && !have.has(title)) {
                t.subs.push({ id: newId('s'), title: title.slice(0, 120), done: false });
              }
            }
          }
          applied.push(`~${t.title}`);
        }
      } else if (op === 'remove') {
        const i = store.todos.findIndex((t) => t.id === raw.id);
        if (i >= 0) {
          applied.push(`-${store.todos[i].title}`);
          store.todos.splice(i, 1);
        }
      } else if (op === 'sub') {
        const t = findTodo(raw.id);
        if (t) {
          for (const s of Array.isArray(raw.add) ? raw.add : []) {
            const title = String(s || '').trim();
            if (title) t.subs.push({ id: newId('s'), title: title.slice(0, 120), done: false });
          }
          for (const s of Array.isArray(raw.done) ? raw.done : []) {
            const hit = t.subs.find((x) => x.title === String(s || '').trim() || x.id === s);
            if (hit) hit.done = true;
          }
          applied.push(`≡${t.title}`);
        }
      }
    } catch (err) {
      console.error('[ops] failed', op, err);
    }
  }
  return applied;
}

function rollover() {
  const today = dateKey();
  const meta = store.meta || (store.meta = {});
  // 老数据补 day 字段（按创建日算，历史上的待办会自然"顺延"到今天）
  for (const t of store.todos) {
    if (!isDate(t.day)) t.day = isDate(t.created) ? t.created : today;
  }
  if (meta.day === today) return;
  // 归档：今天之前完成的，收进 archive，清单只留未完成 + 今天完成的
  const keep = [];
  for (const t of store.todos) {
    if (t.done && t.doneAt && dateKey(new Date(t.doneAt)) !== today) {
      store.archive.push({ ...t, archivedAt: new Date().toISOString() });
    } else {
      keep.push(t);
    }
  }
  if (store.archive.length > 800) store.archive = store.archive.slice(-800);
  store.todos = keep;
  meta.day = today;
  saveStore();
}

function todayDoneCount() {
  const today = dateKey();
  return store.archive.filter((t) => t.doneAt && dateKey(new Date(t.doneAt)) === today).length +
    store.todos.filter((t) => t.done && t.doneAt && dateKey(new Date(t.doneAt)) === today).length;
}

// 一条待办"安排在哪天"；老数据没有 day 就用创建日
function todoDay(t) {
  return isDate(t && t.day) ? t.day : (t && isDate(t.created) ? t.created : '');
}

// 某一天的清单：当天安排的 + 今天完成但安排在其他天的 + 今天被顺延过来的
function visibleTodos(day = dateKey()) {
  const today = dateKey();
  return store.todos.filter((t) => {
    const d = todoDay(t);
    if (t.done) {
      if (d === day) return true;
      return day === today && t.doneAt && dateKey(new Date(t.doneAt)) === today;
    }
    if (d === day) return true;
    return day === today && d && d < today;
  });
}

// 顺延天数（安排日到今天过了几天）
function carryDays(t) {
  const d = todoDay(t);
  if (!d || !isDate(d)) return 0;
  return Math.max(0, daysBetween(d, dateKey()));
}

/* ─────────────────────────── 设置 ─────────────────────────── */

// 通用「加密存一个密钥」：能用 DPAPI 就用，用不了退化成 base64 明文前缀
function seal(plain) {
  const v = String(plain || '').trim();
  if (!v) return '';
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(v).toString('base64');
  }
  return 'plain:' + Buffer.from(v, 'utf8').toString('base64');
}

// 以前 safeStorage 不可用时存的是 'plain:'+base64；现在能加密了，启动时就地升级
function resealPlainKeys() {
  let dirty = false;
  for (const k of ['apiKeyEnc', 'fishKeyEnc']) {
    const v = String(store.settings[k] || '');
    if (v.startsWith('plain:') && safeStorage.isEncryptionAvailable()) {
      const plain = Buffer.from(v.slice(6), 'base64').toString('utf8');
      store.settings[k] = safeStorage.encryptString(plain).toString('base64');
      dirty = true;
    }
  }
  if (dirty) saveStore();
}

function unseal(enc) {
  const e = String(enc || '');
  if (!e) return '';
  try {
    if (e.startsWith('plain:')) return Buffer.from(e.slice(6), 'base64').toString('utf8');
    if (!safeStorage.isEncryptionAvailable()) return '';
    return safeStorage.decryptString(Buffer.from(e, 'base64'));
  } catch {
    return '';
  }
}

function getApiKey() {
  return unseal(store.settings.apiKeyEnc);
}

function setApiKey(plain) {
  store.settings.apiKeyEnc = seal(plain);
}

function plainApiKey() {
  return getApiKey();
}

// 读「性格设定」文件：去 BOM、GBK 兜底、限长
const PERSONA_MAX = 8000;

function readPersonaFile(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { ok: false, error: '这不是一个文件' };
    if (stat.size > 512 * 1024) return { ok: false, error: '文件太大（超过 512KB）' };
    const buf = fs.readFileSync(file);
    let text = buf.toString('utf8');
    if (text.includes('\uFFFD')) {
      try { text = new TextDecoder('gbk').decode(buf); } catch { /* 保持 utf8 */ }
    }
    text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
    if (!text) return { ok: false, error: '文件是空的' };
    const truncated = text.length > PERSONA_MAX;
    if (truncated) text = text.slice(0, PERSONA_MAX);
    return { ok: true, name: path.basename(file), text, truncated, chars: text.length };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

function publicSettings() {
  const key = plainApiKey();
  const s = { ...store.settings };
  delete s.apiKeyEnc;
  const fish = unseal(store.settings.fishKeyEnc);
  delete s.fishKeyEnc;
  s.hasKey = Boolean(key);
  s.keyHint = key ? key.slice(0, 6) + '…' + key.slice(-4) : '';
  s.hasFishKey = Boolean(fish);
  s.fishKeyHint = fish ? fish.slice(0, 4) + '…' + fish.slice(-4) : '';
  return s;
}

// Windows：给窗口补上 WS_EX_TOOLWINDOW，它就不会出现在 Alt+Tab / 任务视图里。
// Electron 没有暴露这个 API；这里把一个临时 .ps1 写到 temp 再执行（避免 -Command 的引号地狱）。
let toolWindowDone = false;
function hideFromTaskView() {
  if (process.platform !== 'win32' || !win || win.isDestroyed() || toolWindowDone) return;
  let hwnd = 0n;
  try {
    const buf = win.getNativeWindowHandle();
    hwnd = buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
  } catch (err) {
    logBoot(`toolwindow hwnd fail ${err.message}`);
    return;
  }
  if (!hwnd) return;
  toolWindowDone = true;

  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$sig = @'\n[DllImport(\"user32.dll\")] public static extern int GetWindowLong(IntPtr h, int i);\n" +
      "[DllImport(\"user32.dll\")] public static extern int SetWindowLong(IntPtr h, int i, int v);\n" +
      "[DllImport(\"user32.dll\")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f);\n'@",
    'Add-Type -Namespace Deskside -Name Win -MemberDefinition $sig',
    `$h = [IntPtr]${hwnd}`,
    '$e = [Deskside.Win]::GetWindowLong($h, -20)',
    '[void][Deskside.Win]::SetWindowLong($h, -20, ($e -bor 0x80))',
    '[void][Deskside.Win]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0, 0x37)',
  ].join('\n');

  const file = path.join(app.getPath('temp'), `deskside-tw-${process.pid}-${Date.now()}.ps1`);
  const outLog = path.join(DATA_DIR(), 'toolwindow.log');
  try {
    fs.writeFileSync(file, script, 'utf8');
    const fd = fs.openSync(outLog, 'a');
    fs.writeSync(fd, `\n--- ${new Date().toISOString()} hwnd=${hwnd}\n`);
    const child = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
      { windowsHide: true, stdio: ['ignore', fd, fd] });
    child.on('exit', (code, sig) => {
      try { fs.writeSync(fd, `exit code=${code} sig=${sig} ${new Date().toISOString()}\n`); fs.closeSync(fd); } catch { /* ignore */ }
      setTimeout(() => { try { fs.unlinkSync(file); } catch { /* ignore */ } }, 500);
      if (code === 0) {
        logBoot(`toolwindow done hwnd=${hwnd}`);
      } else {
        toolWindowDone = false;               // 下次 show 再试一次
        logBoot(`toolwindow child exit=${code}`);
      }
    });
    child.on('error', (err) => { toolWindowDone = false; logBoot(`toolwindow child error ${err.message}`); });
    logBoot(`toolwindow spawn hwnd=${hwnd}`);
  } catch (err) {
    logBoot(`toolwindow fail ${err.message}`);
  }
}

function applyWindowMode() {
  if (!win) return;
  const floating = store.settings.mode !== 'desk';
  win.setAlwaysOnTop(floating, 'floating');
  win.setSkipTaskbar(true);        // 两种形态都不进任务栏 / 任务视图
  win.webContents.send('mode', store.settings.mode);
}

function applyAutoStart(enabled) {
  // 开发态不写注册表，避免把 electron.exe + 项目路径塞进开机启动
  if (!app.isPackaged && !process.env.FISH_AUTOSTART_DEV) return;
  try {
    const opts = { openAtLogin: Boolean(enabled) };
    if (!app.isPackaged) {
      opts.path = process.execPath;
      opts.args = [path.resolve(__dirname), '--hidden'];
    } else {
      opts.args = ['--hidden'];
    }
    app.setLoginItemSettings(opts);
  } catch (err) {
    console.error('[autostart]', err);
  }
}

/* ─────────────────────────── AI ─────────────────────────── */

/* ─────────────────── 上下文：时间窗 + 全量/混合 ─────────────────── */

function ctxWarnAckList() {
  return String(store.settings.ctxWarnAck || '').split(',').map((x) => x.trim()).filter(Boolean);
}

function addCtxWarnAck(threshold) {
  const list = ctxWarnAckList();
  const t = String(threshold);
  if (!list.includes(t)) list.push(t);
  store.settings.ctxWarnAck = list.join(',');
  saveStore();
}

// 每 100 条一个档位；用户选了「不再提醒」的档直接跳过
function ctxWarnThreshold(count) {
  if (count < 100) return 0;
  const th = Math.floor(count / 100) * 100;
  return ctxWarnAckList().includes(String(th)) ? 0 : th;
}

function ctxMessages() {
  const arr = logFor();
  const days = ctxDays();
  if (!days) return arr.slice();
  const cut = Date.now() - days * 86400000;
  return arr.filter((m) => {
    const t = Date.parse(m.at || '');
    return !Number.isFinite(t) || t >= cut;
  });
}

// mixed 模式：近 3 天发原文，更早的只发助手那句 sum（用户原话不再发，省 token）
function contextBlock(name) {
  const arr = ctxMessages();
  const mode = store.settings.ctxMode === 'full' ? 'full' : 'mixed';
  const freshCut = Date.now() - 3 * 86400000;
  const lines = [];
  for (const m of arr) {
    const t = Date.parse(m.at || '');
    const fresh = !Number.isFinite(t) || t >= freshCut;
    const who = m.role === 'user' ? '用户' : name;
    if (mode === 'full' || fresh) {
      lines.push(`${who}：${m.text}`);
      continue;
    }
    if (m.role !== 'assistant') continue;
    const sum = String(m.sum || '').trim() || String(m.say || '').trim() || String(m.text || '').slice(0, 40);
    lines.push(`${who}（摘要）：${sum}`);
  }
  return { text: lines.join(String.fromCharCode(10)) || '（无）', count: arr.length, lines: lines.length };
}

function systemPrompt() {
  const now = new Date();
  const today = dateKey(now);
  const name = assistantName();
  const persona = String(store.settings.persona || '').trim();
  const dows = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const dayLabel = (d) => `${d} ${dows[new Date(d + 'T00:00:00').getDay()]}`;

  const fmt = (t) => {
    const d = todoDay(t);
    const when = d && d !== today ? `${d.slice(5)} ` : '';
    const c = !t.done ? carryDays(t) : 0;
    const carry = c > 0 ? ` · 顺延${c}天` : '';
    const subs = t.subs.length ? ` · 子任务:${t.subs.map((x) => (x.done ? '✓' : '') + x.title).join('/')}` : '';
    const prio = t.prio === 'high' ? '高' : t.prio === 'low' ? '低' : '中';
    return `- [${t.id}] ${when}${t.title} · ${prio}${t.est ? ' · ' + t.est + '分钟' : ''}${t.done ? ' · 已完成' : ''}${carry}${subs}${t.note ? ' · 备注:' + t.note : ''}`;
  };

  const list = visibleTodos(today);
  const listText = list.length ? list.map(fmt).join('\n') : '（空）';

  const later = store.todos
    .filter((t) => !t.done && todoDay(t) > today)
    .sort((a, b) => (todoDay(a) < todoDay(b) ? -1 : 1))
    .slice(0, 12);
  const laterText = later.length ? `\n以后几天的安排：\n${later.map(fmt).join('\n')}\n` : '';

  const recent = contextBlock(name).text;

  return `你的名字是「${name}」，住在用户 Windows 桌面一张备忘录卡片里的私人助理。用户会随口告诉你今天要做什么、已经做完了什么，也会跟你闲聊、吐槽、问问题。

今天是 ${dayLabel(today)}，现在 ${clockKey(now)}。

今天的清单：
${listText}
${laterText}
最近对话：
${recent}

你的工作：维护这份清单、给出简短具体的执行建议；被搭话时像朋友一样自然地聊天。

硬性规则：
1. 只输出一个 JSON 对象，不要 markdown 代码块，不要额外文字。
2. 结构：{"say":"","reply":"","sum":"","ops":[],"ask":[]}
3. say 是朗读用的口语，1~2 句，纯文字，不含列表/编号/括号/emoji；reply 是卡片上显示的文字，可以用短行。
3b. sum 是给以后的自己看的一句话回顾（不超过 24 字，例如"确认周六前交成本表"），聊天太长时用它替代原文。
4. 闲聊、吐槽、问问题、说心情、问你是谁：ops 必须是空数组，就当正常聊天回应 1~3 句。别硬塞建议，别每句话都往待办上扯，除非用户自己提到要做的事。
5. 明确交代的事（"今天要做X"、"X 已经做完了"）直接写进 ops；含糊、需要用户选择的事（"可能还得弄下那个表"、"要不要先做A"）不要写 ops，改为 ask 提问。ask 一次最多 1 条，选项 2~3 个。
6. 用户说某件事已经做完/提交了：清单里已有这条就 complete；清单里没有这条就 add 并带 "done":true（记为已完成），不要留成待办。
7. 说的和做的必须一致：文字里出现"已完成/已记完成"，就必须有对应的 complete 或 add(done:true)；ops 里没有完成动作，文字里就不要说已完成。
8. 安排日期：用户说"明天/后天/周三/下周"这类，就把它换算成具体日期填进 add 的 day 字段；不填 day 表示今天。只有用户明确说的是"截止、之前要交"才填 due。
9. ops 里的 id 必须来自上面的清单（新增待办用 add，不需要 id）。
10. 建议要落到具体：先做哪件、大概多久、卡在哪里。不要空话、不要复述用户原话。
11. 不要用"好的""收到""明白"开头。不要说"作为AI"。人称上用"我"，名字是「${name}」。
12. 用户说"每天/每周/每月"这类循环的事，把 add 的 repeat 填 daily / weekly / monthly（勾掉后会自动排下一次）；没提就不填。${store.settings.aiSubtasks === false ? "；另外现在关闭了「AI 细分步骤」，add 时 subs 留空、细节写进 note。" : ""}
${persona ? `\n性格与说话方式（优先遵守）：${persona}\n` : ''}
ops 可用类型：
{"op":"add","title":"...","prio":"high|mid|low","est":分钟数,"day":"YYYY-MM-DD或空(默认今天)","due":"YYYY-MM-DD或空","subs":["子任务"],"note":"","done":false,"repeat":"daily|weekly|monthly|空"}
{"op":"complete","id":"t1"}
{"op":"update","id":"t1","title":"","prio":"","est":0,"note":"","day":"","subs":["新子任务"],"repeat":""}
{"op":"remove","id":"t1"}
{"op":"sub","id":"t1","add":["子任务"],"done":["子任务文字"]}

ask 格式：[{"q":"问题","options":["选项A","选项B"]}]`;
}

const API_STYLES = ['openai', 'anthropic', 'ollama'];

function apiStyle() {
  const s = String(store.settings.apiStyle || 'openai');
  return API_STYLES.includes(s) ? s : 'openai';
}

// ollama / 本地服务通常不需要 key
function apiNeedsKey(style = apiStyle()) {
  return style !== 'ollama';
}

// 把用户填的地址补成真正的对话端点（用户填 https://api.deepseek.com 或 http://127.0.0.1:11434 都行）
function chatEndpoint(style, baseRaw) {
  let base = String(baseRaw || DEFAULT_SETTINGS.baseUrl).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
  const url = new URL(base);
  const pathname = url.pathname.replace(/\/+$/, '');
  const endsWith = (suffix) => pathname.toLowerCase().endsWith(suffix);
  if (style === 'anthropic') {
    if (endsWith('/messages')) return url;
    url.pathname = pathname + (endsWith('/v1') ? '/messages' : '/v1/messages');
    return url;
  }
  if (style === 'ollama') {
    if (endsWith('/api/chat')) return url;
    url.pathname = pathname + (endsWith('/api') ? '/chat' : '/api/chat');
    return url;
  }
  if (endsWith('/chat/completions')) return url;
  url.pathname = pathname + '/chat/completions';
  return url;
}

function buildChatBody(style, messages, json) {
  const model = store.settings.model || 'deepseek-chat';
  if (style === 'anthropic') {
    const system = messages.filter((m) => m.role === 'system').map((m) => String(m.content || '')).join('\n\n');
    const rest = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') }));
    const body = { model, max_tokens: 1600, temperature: 0.4, messages: rest };
    if (system) body.system = system;
    return body;
  }
  if (style === 'ollama') {
    const body = { model, messages, stream: false, options: { temperature: 0.4, num_predict: 1200 } };
    if (json) body.format = 'json';
    return body;
  }
  const body = { model, messages, temperature: 0.4, max_tokens: 1200 };
  if (json) body.response_format = { type: 'json_object' };
  return body;
}

function chatHeaders(style, key, bodyStr) {
  const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) };
  if (style === 'anthropic') {
    if (key) headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
  } else if (style === 'openai') {
    if (key) headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}

function parseChatReply(style, j) {
  if (style === 'anthropic') {
    if (Array.isArray(j.content)) {
      return j.content.map((c) => (typeof c === 'string' ? c : c && c.text ? c.text : '')).join('');
    }
    return '';
  }
  if (style === 'ollama') return String((j.message && j.message.content) || j.response || '');
  return String(((j.choices && j.choices[0] && j.choices[0].message) || {}).content || '');
}

// 底层 POST：http / https 自适应（本地 Ollama、LM Studio 都是 http）
function postChat(url, headers, bodyStr, timeout) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'http:' ? http : https;
    const req = mod.request(url, { method: 'POST', headers, timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', (e) => reject(e));
    req.write(bodyStr);
    req.end();
  });
}

async function aiJson(messages, { json = true, timeout = 60000 } = {}) {
  const style = apiStyle();
  const key = plainApiKey();
  if (!key && apiNeedsKey(style)) throw new Error('还没填 API Key，点右上角 ⚙ 填一下');
  let useJson = Boolean(json);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const url = chatEndpoint(style, store.settings.baseUrl);
    const bodyStr = JSON.stringify(buildChatBody(style, messages, useJson));
    const res = await postChat(url, chatHeaders(style, key, bodyStr), bodyStr, timeout);
    if (res.status >= 200 && res.status < 300) {
      let j;
      try {
        j = JSON.parse(res.text);
      } catch {
        throw new Error('接口返回不是合法 JSON');
      }
      return parseChatReply(style, j);
    }
    let msg = `接口返回 ${res.status}`;
    try {
      const ej = JSON.parse(res.text);
      msg = (ej.error && (ej.error.message || ej.error)) || ej.message || msg;
      if (typeof msg !== 'string') msg = JSON.stringify(msg);
    } catch { /* 保持默认文案 */ }
    // 有些网关不认 response_format，去掉再试一次
    if (attempt === 0 && useJson && /response_format|json_object|unsupported|not support/i.test(msg + res.text)) {
      useJson = false;
      continue;
    }
    throw new Error(msg);
  }
  throw new Error('接口调用失败');
}


function extractJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(t);
  } catch { /* fallthrough */ }
  const start = t.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i += 1) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(t.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// 模型偶尔把 ask 写成字符串或单个对象（deepseek-reasoner 尤其如此），统一成 [{q, options}]
function normalizeAsk(raw) {
  if (!raw) return [];
  const one = (a) => {
    if (!a) return null;
    if (typeof a === 'string') {
      const q = a.trim();
      return q ? { q, options: [] } : null;
    }
    if (typeof a === 'object') {
      const q = String(a.q || a.question || a.text || '').trim();
      if (!q) return null;
      const opts = Array.isArray(a.options) ? a.options : [];
      return { q, options: opts.map((o) => String(o)).filter(Boolean).slice(0, 4) };
    }
    return null;
  };
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map(one).filter(Boolean).slice(0, 2);
}

/* ─────────────────────────── 语音 ─────────────────────────── */

const tts = makeTts({
  msedge: { MsEdgeTTS, OUTPUT_FORMAT },
  cacheDir: TTS_DIR,
  getFishKey: () => unseal(store.settings.fishKeyEnc),
  log: logBoot,
});

// 当前该用哪个音色：优先用户选中的角色，否则退回内置 edge 音色
function activeVoice() {
  const id = store.settings.activeVoiceId;
  const found = (store.voices || []).find((v) => v.id === id);
  if (found) return found;
  return {
    id: '__builtin_edge__',
    name: '内置 · 晓晓',
    engine: 'edge',
    edgeVoice: store.settings.voice || VOICE_DEFAULT,
  };
}

function publicVoice(v) {
  return {
    id: v.id,
    name: v.name,
    engine: v.engine || 'edge',
    edgeVoice: v.edgeVoice || '',
    remoteVoiceId: v.remoteVoiceId || '',
    refText: v.refText || '',
    hasRefAudio: !!v.refAudio,
    emo: v.emo || '',
    speed: typeof v.speed === 'number' ? v.speed : 1,
    createdAt: v.createdAt || 0,
  };
}

/* ── 角色音色库 ── */

const AUDIO_EXTS = ['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac', 'opus', 'wma'];
const AUDIO_MAX = 40 * 1024 * 1024;

function voiceRefPath(v) {
  if (!v || !v.refAudio) return '';
  return path.isAbsolute(v.refAudio) ? v.refAudio : path.join(VOICE_DIR(), v.refAudio);
}

function addVoice({ name, engine, edgeVoice, remoteVoiceId, refText, emo, speed, audioPath }) {
  const list = store.voices || (store.voices = []);
  const cleanName = String(name || '').trim().slice(0, 24);
  if (!cleanName) return { ok: false, error: '给这个音色起个名字' };
  if (list.length >= 40) return { ok: false, error: '音色太多了（上限 40 个）' };

  const id = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const rec = {
    id,
    name: cleanName,
    engine: ['edge', 'local', 'fish'].includes(engine) ? engine : 'local',
    edgeVoice: String(edgeVoice || ''),
    remoteVoiceId: String(remoteVoiceId || '').trim(),
    refText: String(refText || '').slice(0, 600),
    emo: String(emo || '').slice(0, 24),
    speed: Math.min(2, Math.max(0.5, Number(speed) || 1)),
    refAudio: '',
    createdAt: Date.now(),
  };

  if (audioPath) {
    try {
      const stat = fs.statSync(audioPath);
      if (!stat.isFile()) return { ok: false, error: '这不是一个文件' };
      if (stat.size > AUDIO_MAX) return { ok: false, error: '音频太大了（超过 40MB）' };
      const ext = (path.extname(audioPath).slice(1) || 'wav').toLowerCase();
      if (!AUDIO_EXTS.includes(ext)) return { ok: false, error: `不支持的音频格式：.${ext}` };
      fs.mkdirSync(VOICE_DIR(), { recursive: true });
      const fileName = `${id}.${ext}`;
      fs.copyFileSync(audioPath, path.join(VOICE_DIR(), fileName));
      rec.refAudio = fileName;
    } catch (err) {
      return { ok: false, error: '读不了这个音频：' + String((err && err.message) || err) };
    }
  }

  if (rec.engine === 'local' && !rec.refAudio) {
    return { ok: false, error: '本地克隆需要一段参考音频（5~30 秒干净人声）' };
  }
  if (rec.engine === 'fish' && !rec.remoteVoiceId) {
    return { ok: false, error: '云端引擎需要填一个 Fish Audio 的音色 ID' };
  }
  if (rec.engine === 'edge' && !rec.edgeVoice) rec.edgeVoice = store.settings.voice || VOICE_DEFAULT;

  list.push(rec);
  if (!store.settings.activeVoiceId) store.settings.activeVoiceId = id;
  saveStore();
  return { ok: true, voice: publicVoice(rec) };
}

function updateVoice(id, patch = {}) {
  const v = (store.voices || []).find((x) => x.id === id);
  if (!v) return { ok: false, error: '找不到这个音色' };
  if (patch.name !== undefined) v.name = String(patch.name).trim().slice(0, 24) || v.name;
  if (patch.refText !== undefined) v.refText = String(patch.refText).slice(0, 600);
  if (patch.emo !== undefined) v.emo = String(patch.emo).slice(0, 24);
  if (patch.speed !== undefined) v.speed = Math.min(2, Math.max(0.5, Number(patch.speed) || 1));
  if (patch.remoteVoiceId !== undefined) v.remoteVoiceId = String(patch.remoteVoiceId).trim();
  if (patch.engine !== undefined && ['edge', 'local', 'fish'].includes(patch.engine)) v.engine = patch.engine;
  saveStore();
  return { ok: true, voice: publicVoice(v) };
}

function removeVoice(id) {
  const idx = (store.voices || []).findIndex((x) => x.id === id);
  if (idx < 0) return { ok: false, error: '找不到这个音色' };
  const [v] = store.voices.splice(idx, 1);
  const f = voiceRefPath(v);
  if (f) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
  if (store.settings.activeVoiceId === id) {
    store.settings.activeVoiceId = store.voices[0] ? store.voices[0].id : '';
  }
  saveStore();
  return { ok: true };
}

function setActiveVoice(id) {
  if (id && !(store.voices || []).some((v) => v.id === id)) {
    return { ok: false, error: '找不到这个音色' };
  }
  store.settings.activeVoiceId = id || '';
  saveStore();
  return { ok: true };
}

/* ───── 本地语音服务（IndexTTS sidecar，按需拉起，不常驻） ───── */

const LOCAL_CANDIDATES = [
  path.join(require('os').homedir(), 'index-tts'),
  path.join(require('os').homedir(), 'Documents', 'index-tts'),
  'C:\\index-tts',
];

function localPaths() {
  let repo = String(store.settings.localRepo || '').trim();
  if (!repo || !fs.existsSync(repo)) {
    repo = LOCAL_CANDIDATES.find((p) => fs.existsSync(p)) || String(store.settings.localRepo || '').trim();
  }
  let python = String(store.settings.localPython || '').trim();
  if (!python && repo) {
    const cand = path.join(repo, '.venv', 'Scripts', 'python.exe');
    if (fs.existsSync(cand)) python = cand;
  }
  let script = String(store.settings.localScript || '').trim();
  if (!script) {
    const cands = [
      path.join(__dirname, 'tts-server.py'),                       // 开发态
      path.join(process.resourcesPath || '', 'tts-server.py'),     // 打包后放在 resources 里
      repo ? path.join(repo, 'tts-server.py') : '',
    ].filter(Boolean);
    script = cands.find((p) => fs.existsSync(p)) || cands[0];
  }
  return {
    repo,
    python,
    script,
    modelDir: repo ? path.join(repo, 'checkpoints') : '',
    log: path.join(DATA_DIR(), 'tts-server.log'),
  };
}

let localProc = null;
let localBoot = null;

function localPort() {
  try {
    return Number(new URL(store.settings.localUrl).port) || 8756;
  } catch {
    return 8756;
  }
}

/** 需要本地音色时才拉起 Python 服务；已在跑就直接返回。 */
async function ensureLocalServer(timeoutMs = 150000) {
  const base = store.settings.localUrl;
  if (store.settings.localEnabled === false) {
    return { ok: false, error: '本地语音模型已关闭（设置 → 声音 里可以打开）' };
  }
  const first = await tts.localHealth(base, 1200);
  if (first.up && first.ready) return { ok: true, ...first };
  if (localBoot) return localBoot;

  localBoot = (async () => {
    const cfg = localPaths();
    if (!cfg.repo || !fs.existsSync(cfg.repo)) {
      return { ok: false, error: `没找到 index-tts 目录：可以放在 %USERPROFILE%\\index-tts，或在设置 → 声音 里指定路径` };
    }
    if (!cfg.python || !fs.existsSync(cfg.python)) {
      return { ok: false, error: `没找到本地语音环境的 python（期望 ${cfg.repo}\\.venv\\Scripts\\python.exe）` };
    }
    if (!fs.existsSync(cfg.script)) {
      return { ok: false, error: `没找到 tts-server.py（${cfg.script}）` };
    }
    if (!cfg.modelDir || !fs.existsSync(cfg.modelDir)) {
      return { ok: false, error: `没找到模型目录（${cfg.modelDir || '空'}）` };
    }

    try {
      const out = fs.openSync(cfg.log, 'a');
      localProc = spawn(
        cfg.python,
        [cfg.script, '--repo', cfg.repo, '--model-dir', cfg.modelDir, '--port', String(localPort())],
        {
          cwd: cfg.repo,
          windowsHide: true,
          stdio: ['ignore', out, out],
          // 采样步数：越少越快、越像度略降。默认 14（模型代码支持这个环境变量才算数）
          env: { ...process.env, INDEXTTS_DIFFUSION_STEPS: String(store.settings.ttsSteps || 14) },
        }
      );
      logBoot(`local tts spawn pid=${localProc.pid} steps=${store.settings.ttsSteps || 14}`);
      localProc.on('exit', (code) => {
        logBoot(`local tts exit ${code}`);
        localProc = null;
      });
    } catch (err) {
      return { ok: false, error: `启动本地语音服务失败：${err.message}` };
    }

    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await new Promise((r) => setTimeout(r, 1500));
      const h = await tts.localHealth(base, 1500);
      if (h.up && h.ready) return { ok: true, ...h, ms: Date.now() - t0 };
      if (h.up && h.error) return { ok: false, error: `本地模型加载失败：${h.error}` };
      if (!localProc) return { ok: false, error: '本地语音服务刚启动就退出了，看 tts-server.log' };
    }
    return { ok: false, error: '本地语音服务启动超时（模型加载通常要 30 秒左右）' };
  })();

  try {
    return await localBoot;
  } finally {
    localBoot = null;
  }
}

function stopLocalServer() {
  if (!localProc) return;
  try {
    localProc.kill();
  } catch { /* 已经没了 */ }
  localProc = null;
}

async function speak(text, voiceOverride, opts = {}) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return { ok: false, error: '没有要读的文字' };
  if (clean.length > 900) {
    // 长文本切句，避免一次请求过长
    return { ok: false, error: 'too_long' };
  }
  const voice = voiceOverride || activeVoice();
  const synthVoice = { ...voice, refAudio: voiceRefPath(voice), localUrl: store.settings.localUrl };
  let note = '';
  if (synthVoice.engine === 'local') {
    // quick：关怀/提醒这种说完就过去的话，不等模型加载，先让晓晓顶上
    const quick = opts.quick === true;
    let up = { ok: true };
    if (quick) {
      const h = await tts.localHealth(store.settings.localUrl, 700).catch(() => ({ ready: false }));
      if (!h || !h.ready) up = { ok: false, error: '本地模型还没热起来' };
    } else {
      up = await ensureLocalServer();
    }
    if (!up.ok) {
      note = up.error || '本地语音服务没起来';
      logBoot(`local tts unavailable: ${note}`);
      synthVoice.engine = 'edge';
      synthVoice.edgeVoice = synthVoice.edgeVoice || store.settings.voice || VOICE_DEFAULT;
    }
  }
  try {
    const out = await tts.synth({
      text: clean,
      voice: synthVoice,
      rate: Number(store.settings.rate) || 0,
    });
    const data = fs.readFileSync(out.file);
    return {
      ok: true,
      dataUrl: `data:${out.mime};base64,` + data.toString('base64'),
      engine: out.engine,
      fallback: Boolean(out.fallback || note),
      note,
      voice: voice.name,
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

function splitSpeech(text, limit = 220) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= limit) return [t];
  const out = [];
  let rest = t;
  while (rest.length > limit) {
    const w = rest.slice(0, limit);
    let cut = -1;
    for (const mark of ['。', '！', '？', '；', '\n', '，']) {
      const at = w.lastIndexOf(mark);
      if (at > limit * 0.35) { cut = at + 1; break; }
    }
    if (cut <= 0) cut = limit;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/* ─────────────────────────── 简报 ─────────────────────────── */

async function buildBrief(kind) {
  const today = new Date();
  const open = visibleTodos().filter((t) => !t.done);
  const doneToday = todayDoneCount();
  const local =
    kind === 'morning'
      ? `早上好。今天有 ${open.length} 件事${open.length ? '：' + open.slice(0, 3).map((t) => t.title).join('、') : ''}。`
      : `今天完成了 ${doneToday} 件${open.length ? `，还有 ${open.length} 件没做完。` : '，全部清空了。'}`;

  if (!plainApiKey()) {
    return { say: local, reply: local, kind };
  }
  try {
    const content = await aiJson([
      { role: 'system', content: systemPrompt() },
      {
        role: 'user',
        content:
          kind === 'morning'
            ? '现在生成早间播报：用两句话说我今天该先做什么、为什么，顺带提一下最可能会被拖住的那件事。ops 必须是空数组。'
            : '现在生成晚间播报：用两句话说我今天完成得怎么样、还剩什么，并问我要不要把没做完的留到明天。ops 必须是空数组。',
      },
    ]);
    const j = extractJson(content);
    if (j && (j.say || j.reply)) {
      return { say: String(j.say || j.reply || local), reply: String(j.reply || j.say || local), kind };
    }
  } catch (err) {
    console.error('[brief] ai failed', err.message);
  }
  return { say: local, reply: local, kind };
}

async function fireBrief(kind) {
  const brief = await buildBrief(kind);
  if (!win) return brief;
  pushLog({ role: 'assistant', text: brief.reply, say: brief.say, at: new Date().toISOString(), brief: kind });
  saveStore();
  win.webContents.send('brief', brief);
  if (store.settings.autoSpeak) win.webContents.send('speak', brief.say);
  if (Notification.isSupported()) {
    new Notification({ title: assistantName(), body: brief.say, silent: true }).show();
  }
  return brief;
}

function hmToMin(hm) {
  const [h, m] = String(hm || '').split(':').map((x) => Number(x) || 0);
  return h * 60 + m;
}

function briefTick() {
  if (!store.settings.briefOn) return;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const day = dateKey(now);
  const fired = store.meta.briefFired || (store.meta.briefFired = {});
  const items = [
    ['morning', store.settings.briefMorning],
    ['evening', store.settings.briefEvening],
  ];
  for (const [kind, at] of items) {
    const target = hmToMin(at);
    if (nowMin < target) continue;
    if (fired[kind] === day) continue;
    fired[kind] = day;
    saveStore();
    // 只补发 3 小时内的，隔太久（比如关机一夜）就不补了
    if (nowMin - target > 180) continue;
    fireBrief(kind).catch((e) => console.error('[brief]', e));
  }
}

/* ─────────────── 提醒（每 N 分钟 / 每天定点） ─────────────── */

const REMIND_KINDS = ['every', 'daily'];

function normalizeReminder(o = {}) {
  const kind = REMIND_KINDS.includes(String(o.kind)) ? String(o.kind) : 'every';
  const times = (Array.isArray(o.times) ? o.times : [])
    .map((t) => String(t || '').trim())
    .filter((t) => /^\d{1,2}:\d{2}$/.test(t))
    .map((t) => t.padStart(5, '0'))
    .slice(0, 8);
  return {
    id: o.id || newId('r'),
    title: String(o.title || '').trim().slice(0, 60) || '起来走两步',
    kind,
    everyMin: Math.max(5, Math.min(600, Number(o.everyMin) || 45)),
    times: times.length ? times : ['09:00'],
    on: o.on !== false,
    lastAt: o.lastAt || '',
    created: o.created || new Date().toISOString(),
  };
}

function publicReminder(r) {
  return { id: r.id, title: r.title, kind: r.kind, everyMin: r.everyMin, times: r.times, on: r.on !== false };
}

function inQuietHours(now = new Date()) {
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const a = hmToMin(store.settings.quietStart || '22:30');
  const b = hmToMin(store.settings.quietEnd || '08:00');
  if (a === b) return false;
  return a < b ? (nowMin >= a && nowMin < b) : (nowMin >= a || nowMin < b);
}

function pushCare(text, kind) {
  if (!text) return;
  const speakIt = kind === 'reminder' ? store.settings.remindSpeak : store.settings.careSpeak;
  try {
    // 音频交给渲染层播（那边才有播放链路和分句流式），主进程只负责弹气泡和系统通知
    if (win && !win.isDestroyed()) win.webContents.send('care', { text, kind, speak: speakIt !== false });
    new Notification({ title: assistantName(), body: text, silent: true }).show();
  } catch (err) {
    console.error('[care]', err);
  }
}

const REMIND_TEMPLATES = [
  '该{T}了，别拖到下一件事压上来。',
  '{T}——现在，就这一件。',
  '提醒你一下：{T}。',
  '到点了，{T}。站起来动一动也好。',
];

function remindTemplate(rem) {
  const t = String((rem && rem.title) || '').replace(/[。！!]+$/, '') || '歇一会儿';
  const one = REMIND_TEMPLATES[Math.floor(Math.random() * REMIND_TEMPLATES.length)];
  return one.replace('{T}', t);
}

// 让提醒也按当前人设的口吻说出来；失败/超时就退回模板
async function reminderLine(rem) {
  const title = String((rem && rem.title) || '').trim();
  if (!title) return remindTemplate(rem);
  const name = assistantName();
  const persona = String(store.settings.persona || '').slice(0, 300);
  const open = visibleTodos().filter((t) => !t.done);
  const prompt = `你是「${name}」，住在用户桌面备忘录里，现在 ${clockKey()}。
用户给自己设了一个提醒：「${title}」。${open.length ? '清单里还没做完的有：' + open.slice(0, 3).map((t) => t.title).join('、') + '。' : ''}
请用你自己的口吻提醒他做这件事。
要求：只回一句中文口语，10~26 字；要自然像人说话，不要"叮咚""提醒您"这种机器人腔，不要引号、不要列表、不要 emoji；可以带一点情绪或催促，但别重复原句的措辞。${persona ? '语气必须符合这个性格：' + persona : ''}`;
  try {
    const j = await aiJson([{ role: 'user', content: prompt }], { json: false, timeout: 20000 });
    const text = String(j || '').replace(/["“”]/g, '').trim().split('\n')[0].slice(0, 60);
    if (text && text.length >= 4) return text;
  } catch (err) {
    console.error('[reminder ai]', err && err.message);
  }
  return remindTemplate(rem);
}

function reminderTick() {
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const today = dateKey(now);
  const fired = store.meta.remindFired || (store.meta.remindFired = {});
  let changed = false;
  let due = null;
  for (const r of store.reminders || []) {
    if (!r.on) continue;
    if (r.kind === 'every') {
      if (!r.lastAt) { r.lastAt = now.toISOString(); changed = true; continue; }
      const gap = now.getTime() - new Date(r.lastAt).getTime();
      if (gap >= r.everyMin * 60000) {
        r.lastAt = now.toISOString();
        changed = true;
        due = r;
        break;
      }
    } else {
      for (const t of r.times) {
        const key = `${r.id}|${today}|${t}`;
        const target = hmToMin(t);
        if (fired[key]) continue;
        if (nowMin >= target && nowMin - target <= 20) {
          fired[key] = 1;
          changed = true;
          due = r;
          break;
        }
      }
      if (due) break;
    }
  }
  // 清掉太老的记录
  const keys = Object.keys(fired);
  if (keys.length > 300) { store.meta.remindFired = {}; store.meta.remindFired[`${'x'}|${today}|00:00`] = 1; changed = true; }
  if (changed) saveStore();
  if (due) {
    void reminderLine(due)
      .then((line) => pushCare(line, 'reminder'))
      .catch((err) => console.error('[reminder ai]', err && err.message));
  }
}

/* ─────────────── AI 日常关怀 ─────────────── */

const CARE_TEMPLATES = [
  '起来走两步吧，坐久了腰会先抗议。',
  '喝口水。你不是真的不渴，你只是忘了。',
  '眼睛歇十秒，看看窗外最远的那个点。',
  '肩膀是不是又耸起来了？放下来，慢慢转两圈脖子。',
  '手头的活儿还有多少？挑最烦的那件，先干十分钟。',
  '抬头，深呼吸三次。剩下的等会儿再说。',
];

function careTemplate() {
  const open = visibleTodos().filter((t) => !t.done).length;
  const hour = new Date().getHours();
  if (open >= 4) return `清单上还有 ${open} 件，挑一件最小的先破个口子？`;
  if (hour >= 12 && hour < 13) return '该吃饭了，别拿外卖凑合，站起来走走。';
  if (hour >= 23 || hour < 6) return '这个点了，眼睛和脑子都该关机了。明天再干。';
  if (hour >= 14 && hour < 16) return '下午最容易犯困，站起来接杯水，别硬撑。';
  return CARE_TEMPLATES[Math.floor(Math.random() * CARE_TEMPLATES.length)];
}

async function careLine() {
  const name = assistantName();
  const open = visibleTodos().filter((t) => !t.done);
  const doneCount = visibleTodos().filter((t) => t.done).length;
  const persona = String(store.settings.persona || '').slice(0, 300);
  const prompt = `你是「${name}」，住在用户桌面备忘录里。现在 ${clockKey()}，今天清单里未完成 ${open.length} 件${open.length ? '（' + open.slice(0, 3).map((t) => t.title).join('、') + '）' : ''}，已完成 ${doneCount} 件。
请主动关心用户一句：像喝水、久坐起身、护眼、吃饭、休息、或者催一句手头的事。
要求：只回一句中文口语，12~28 字，不要引号、不要列表、不要 emoji，不要每次都提清单，别肉麻。${persona ? '语气要符合这个性格：' + persona : ''}`;
  try {
    const j = await aiJson([{ role: 'user', content: prompt }], { json: false, timeout: 30000 });
    const text = String(j || '').replace(/["“”]/g, '').trim().split('\n')[0].slice(0, 60);
    if (text && text.length >= 4) return text;
  } catch (err) {
    console.error('[care ai]', err && err.message);
  }
  return careTemplate();
}

let careBusy = false;

async function careTick() {
  if (!store.settings.careOn) return;
  if (careBusy) return;
  const now = new Date();
  if (inQuietHours(now)) return;
  const last = store.meta.careAt ? new Date(store.meta.careAt).getTime() : 0;
  const every = Math.max(15, Math.min(480, Number(store.settings.careEvery) || 50)) * 60000;
  if (!last) { store.meta.careAt = now.toISOString(); saveStore(); return; }
  if (now.getTime() - last < every) return;
  // 用户刚在聊天就别插嘴
  if (store.meta.lastUserAt && now.getTime() - new Date(store.meta.lastUserAt).getTime() < 3 * 60000) return;
  careBusy = true;
  store.meta.careAt = now.toISOString();
  saveStore();
  try {
    const line = await careLine();
    pushCare(line, 'care');
  } finally {
    careBusy = false;
  }
}

/* ─────────────────────────── 窗口 ─────────────────────────── */

function defaultBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 392;
  const height = 640;
  return {
    width,
    height,
    x: Math.round(workArea.x + workArea.width - width - 28),
    y: Math.round(workArea.y + 72),
  };
}

function createWindow() {
  const saved = store.meta.bounds || {};
  const b = { ...defaultBounds(), ...saved };
  const { workArea } = screen.getPrimaryDisplay();
  // 防止上次在已拔掉的显示器上
  if (b.x < workArea.x - 50 || b.x > workArea.x + workArea.width - 80) b.x = defaultBounds().x;
  if (b.y < workArea.y - 20 || b.y > workArea.y + workArea.height - 80) b.y = defaultBounds().y;
  logBoot(`bounds ${b.x},${b.y} ${b.width}x${b.height} mode=${store.settings.mode} workArea=${JSON.stringify(workArea)}`);

  win = new BrowserWindow({
    ...b,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    minWidth: 320,
    minHeight: 420,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,            // 常驻桌面：不进任务栏、不进出 Alt+Tab / 任务视图
    alwaysOnTop: store.settings.mode !== 'desk',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.setTitle(assistantName());
  // 有些情况下 Windows 会把隐藏创建的窗口摆到屏幕正中，摆出来时再钉一次位置
  const pinBounds = () => {
    if (!win || win.isDestroyed()) return;
    try { win.setBounds(b); } catch { /* ignore */ }
  };
  // 窗口每次显示后重新贴一次 TOOLWINDOW（Chromium 首次 show 会重建原生窗口，样式会丢）
  win.on('show', () => {
    toolWindowDone = false;
    setTimeout(() => { try { hideFromTaskView(); } catch { /* ignore */ } }, 300);
  });

  win.once('ready-to-show', () => {
    pinBounds();
    if (!process.argv.includes('--hidden') && !process.env.FISH_SMOKE) {
      win.show();
      if (store.settings.mode !== 'desk') win.focus();
      logBoot(`shown ${JSON.stringify(win.getBounds())}`);
    }
  });

  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });

  let moveTimer = null;
  const persist = () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      store.meta.bounds = win.getBounds();
      saveStore();
    }, 400);
  };
  win.on('moved', persist);
  win.on('resized', persist);

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  applyWindowMode();
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible() && win.isFocused()) {
    win.hide();
    return;
  }
  win.show();
  win.focus();
  win.webContents.send('focus-input');
}

// 任务栏是浅色还是深色（SystemUsesLightTheme），决定托盘用深色还是浅色图形
function systemUsesLightTaskbar() {
  try {
    const out = execFileSync('reg', ['query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize',
      '/v', 'SystemUsesLightTheme'], { encoding: 'utf8', timeout: 2000, windowsHide: true });
    return /REG_DWORD\s+0x1/i.test(out);
  } catch (err) {
    return false;
  }
}

function trayIconPath() {
  const light = systemUsesLightTaskbar();          // 浅色任务栏 → 用深色图形
  const file = light ? 'tray-dark.png' : 'tray-light.png';
  const full = path.join(__dirname, 'assets', file);
  return fs.existsSync(full) ? full : path.join(__dirname, 'assets', 'tray.png');
}

function buildTray() {
  let img = nativeImage.createFromPath(trayIconPath());
  if (img.isEmpty()) img = nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip(assistantName());
  refreshTrayMenu();
  tray.on('click', toggleWindow);
  // 用户切了系统深/浅色时跟着换
  nativeTheme.on('updated', () => {
    if (!tray || tray.isDestroyed()) return;
    const next = nativeImage.createFromPath(trayIconPath());
    if (!next.isEmpty()) tray.setImage(next);
  });
}

// 名字改了之后，窗口标题、托盘、界面一起跟着变
function applyIdentity() {
  const name = assistantName();
  if (win && !win.isDestroyed()) {
    win.setTitle(name);
    win.webContents.send('identity', { name });
  }
  if (tray) tray.setToolTip(name);
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const floating = store.settings.mode !== 'desk';
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `${win && win.isVisible() ? '隐藏' : '显示'}${assistantName()}　(Ctrl+Alt+Space)`, click: toggleWindow },
    { type: 'separator' },
    {
      label: '浮在所有窗口最前',
      type: 'checkbox',
      checked: floating,
      click: () => { store.settings.mode = 'float'; saveStore(); applyWindowMode(); refreshTrayMenu(); },
    },
    {
      label: '贴在桌面（被窗口盖住）',
      type: 'checkbox',
      checked: !floating,
      click: () => { store.settings.mode = 'desk'; saveStore(); applyWindowMode(); refreshTrayMenu(); },
    },
    { type: 'separator' },
    { label: '早上播报一次', click: () => fireBrief('morning') },
    { label: '晚上播报一次', click: () => fireBrief('evening') },
    { label: '设置…', click: () => { win?.show(); win?.webContents.send('open-settings'); } },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: Boolean(app.getLoginItemSettings().openAtLogin),
      click: (item) => {
        store.settings.autoStart = item.checked;
        saveStore();
        applyAutoStart(item.checked);
      },
    },
    { type: 'separator' },
    {
      label: '重置窗口位置',
      click: () => {
        if (!win || win.isDestroyed()) return;
        const b = defaultBounds();
        win.setBounds(b);
        win.show();
        win.focus();
        store.meta.bounds = b;
        saveStore();
      },
    },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]));
}

/* ─────────────────────────── IPC ─────────────────────────── */

function statePayload() {
  rollover();
  const active = activeVoice();
  return {
    todos: store.todos,
    doneCount: todayDoneCount(),
    archiveCount: store.archive.length,
    settings: publicSettings(),
    name: assistantName(),
    today: dateKey(),
    weekday: weekdayCN(),
    canUndo: undoStack.length > 0,
    log: logFor().slice(-30),
    reminders: (store.reminders || []).map(publicReminder),
    voices: (store.voices || []).map(publicVoice),
    activeVoice: { id: active.id, name: active.name, engine: active.engine || 'edge' },
    personas: (store.personas || []).map(personaBrief),
    activePersonaId: store.activePersonaId,
    ctx: {
      count: ctxMessages().length,
      total: logFor().length,
      window: store.settings.ctxWindow || '1w',
      mode: store.settings.ctxMode || 'mixed',
      warn: ctxWarnThreshold(ctxMessages().length),
    },
  };
}

function registerIpc() {
  ipcMain.handle('state:get', () => statePayload());

  ipcMain.handle('chat:send', async (_e, { text, ack } = {}) => {
    store.meta.lastUserAt = new Date().toISOString();
    const message = String(text || '').trim();
    if (!message) return { error: '空消息' };

    // 上下文太长时先问一句：继续 / 继续且这一档别再提醒 / 算了
    pruneLogs();
    const ctxCount = ctxMessages().length;
    if (!ack) {
      const th = ctxWarnThreshold(ctxCount);
      if (th) return { needConfirm: true, count: ctxCount, threshold: th, ...statePayload() };
    } else if (ack === 'silent') {
      const th = ctxWarnThreshold(ctxCount);
      if (th) addCtxWarnAck(th);
    }

    snapshot();
    pushLog({ role: 'user', text: message, at: new Date().toISOString() });
    // AI 思考的这几秒顺手把本地语音服务热起来，省掉「等模型加载」那一段
    try {
      const v = activeVoice();
      if (v && v.engine === 'local') ensureLocalServer().catch(() => {});
    } catch { /* ignore */ }
    try {
      const content = await aiJson([
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: message },
      ]);
      const j = extractJson(content);
      if (!j) {
        const plain = String(content || '').trim();
        pushLog({ role: 'assistant', text: plain, at: new Date().toISOString() });
        saveStore();
        return { reply: plain || '（没有回复）', say: plain, ask: [], applied: [], ...statePayload() };
      }
      const applied = applyOps(j.ops);
      const reply = String(j.reply || j.say || '').trim() || '（没有回复）';
      const say = String(j.say || reply).trim();
      const ask = normalizeAsk(j.ask);
      const sum = String(j.sum || '').trim().slice(0, 60);
      pushLog({ role: 'assistant', text: reply, say, sum, at: new Date().toISOString() });
      saveStore();
      return { reply, say, ask, applied, ...statePayload() };
    } catch (err) {
      saveStore();
      return { error: String(err && err.message ? err.message : err), ...statePayload() };
    }
  });

  ipcMain.handle('todo:toggle', (_e, { id }) => {
    snapshot();
    const t = findTodo(id);
    if (t) {
      t.done = !t.done;
      t.doneAt = t.done ? new Date().toISOString() : null;
      if (t.done) spawnNextRepeat(t);
      saveStore();
    }
    return statePayload();
  });

  ipcMain.handle('todo:add', (_e, payload) => {
    snapshot();
    addTodo(payload || {});
    saveStore();
    return statePayload();
  });

  ipcMain.handle('todo:update', (_e, { id, patch }) => {
    snapshot();
    applyOps([{ op: 'update', id, ...(patch || {}) }]);
    saveStore();
    return statePayload();
  });

  ipcMain.handle('todo:remove', (_e, { id }) => {
    snapshot();
    applyOps([{ op: 'remove', id }]);
    saveStore();
    return statePayload();
  });

  ipcMain.handle('todo:sub-toggle', (_e, { id, subId }) => {
    snapshot();
    const t = findTodo(id);
    const s = t && t.subs.find((x) => x.id === subId);
    if (s) { s.done = !s.done; saveStore(); }
    return statePayload();
  });

  ipcMain.handle('todo:sub-add', (_e, { id, title }) => {
    snapshot();
    const t = findTodo(id);
    const v = String(title || '').trim();
    if (t && v) {
      if (!Array.isArray(t.subs)) t.subs = [];
      t.subs.push({ id: newId('s'), title: v.slice(0, 120), done: false });
      saveStore();
    }
    return statePayload();
  });

  ipcMain.handle('todo:sub-update', (_e, { id, subId, title }) => {
    snapshot();
    const t = findTodo(id);
    const s1 = t && (t.subs || []).find((x) => x.id === subId);
    const v = String(title || '').trim();
    if (s1 && v) { s1.title = v.slice(0, 120); saveStore(); }
    return statePayload();
  });

  ipcMain.handle('todo:sub-remove', (_e, { id, subId }) => {
    snapshot();
    const t = findTodo(id);
    if (t && Array.isArray(t.subs)) {
      const i = t.subs.findIndex((x) => x.id === subId);
      if (i >= 0) { t.subs.splice(i, 1); saveStore(); }
    }
    return statePayload();
  });

  ipcMain.handle('todo:sub-move', (_e, { fromId, subId, toId }) => {
    snapshot();
    const from = findTodo(fromId);
    const to = findTodo(toId);
    if (from && to && from !== to && Array.isArray(from.subs)) {
      const i = from.subs.findIndex((x) => x.id === subId);
      if (i >= 0) {
        const [sub] = from.subs.splice(i, 1);
        if (!Array.isArray(to.subs)) to.subs = [];
        to.subs.push(sub);
        saveStore();
      }
    }
    return statePayload();
  });

  ipcMain.handle('todo:repeat', (_e, { id, repeat }) => {
    snapshot();
    const t = findTodo(id);
    if (t) { t.repeat = normalizeRepeat(repeat); saveStore(); }
    return statePayload();
  });

  ipcMain.handle('reminder:list', () => (store.reminders || []).map(publicReminder));

  ipcMain.handle('reminder:save', (_e, payload = {}) => {
    const raw = { ...payload };
    const list = store.reminders || (store.reminders = []);
    if (raw.id) {
      const r = list.find((x) => x.id === raw.id);
      if (r) Object.assign(r, normalizeReminder({ ...r, ...raw }), { id: r.id, created: r.created });
    } else {
      list.push(normalizeReminder(raw));
    }
    if (list.length > 24) list.splice(0, list.length - 24);
    saveStore();
    return { reminders: list.map(publicReminder) };
  });

  ipcMain.handle('reminder:remove', (_e, { id }) => {
    store.reminders = (store.reminders || []).filter((x) => x.id !== id);
    saveStore();
    return { reminders: store.reminders.map(publicReminder) };
  });

  ipcMain.handle('reminder:test', async (_e, { id } = {}) => {
    const r = (store.reminders || []).find((x) => x.id === id) || { title: '起来走两步' };
    try {
      const text = await reminderLine(r);
      pushCare(text, 'reminder');
      return { ok: true, text };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('care:test', async () => {
    try {
      const line = await careLine();
      pushCare(line, 'care');
      return { ok: true, text: line };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('undo', () => {
    const snap = undoStack.pop();
    if (snap) {
      try {
        const j = JSON.parse(snap);
        store.todos = j.todos;
        if (j.logs) store.logs = j.logs;
        saveStore();
      } catch { /* ignore */ }
    }
    return statePayload();
  });

  ipcMain.handle('settings:save', (_e, patch = {}) => {
    const p = { ...patch };
    if (typeof p.apiKey === 'string') {
      if (p.apiKey.trim() === '') { /* 空字符串=不改 */ } else setApiKey(p.apiKey);
      delete p.apiKey;
    }
    if (p.clearKey) { setApiKey(''); delete p.clearKey; }
    if (typeof p.fishKey === 'string') {
      if (p.fishKey.trim() === '') { /* 空字符串=不改 */ } else store.settings.fishKeyEnc = seal(p.fishKey);
      delete p.fishKey;
    }
    if (p.clearFishKey) { store.settings.fishKeyEnc = ''; delete p.clearFishKey; }
    for (const k of Object.keys(p)) {
      if (k in DEFAULT_SETTINGS) store.settings[k] = p[k];
    }
    if (typeof store.settings.uiOpacity === 'number') {
      store.settings.uiOpacity = Math.min(1, Math.max(0.55, store.settings.uiOpacity));
    }
    if (patch.autoStart !== undefined) applyAutoStart(store.settings.autoStart);
    // 名字 / 性格 / 音色都是「当前人设」的属性，改完写回 personas[]
    syncActivePersona();
    saveStore();
    applyWindowMode();
    applyIdentity();
    refreshTrayMenu();
    return statePayload();
  });

  /* ── 人设（每个独立聊天记录 + 独立音色） ── */

  ipcMain.handle('persona:new', (_e, { name } = {}) => {
    const label = String(name || '').trim() || `人设 ${(store.personas || []).length + 1}`;
    const p = {
      id: `p${Date.now().toString(36)}`,
      name: label,
      persona: '',
      voiceId: String(store.settings.activeVoiceId || ''),
      createdAt: new Date().toISOString(),
    };
    store.personas.push(p);
    store.logs[p.id] = [];
    store.activePersonaId = p.id;
    store.settings.name = p.name;
    store.settings.persona = p.persona;
    saveStore();
    applyIdentity();
    refreshTrayMenu();
    return { ok: true, id: p.id, ...statePayload() };
  });

  ipcMain.handle('persona:switch', (_e, { id } = {}) => {
    const target = (store.personas || []).find((x) => x.id === id);
    if (!target) return { ok: false, error: '没找到这个人设' };
    syncActivePersona();
    store.activePersonaId = target.id;
    store.settings.name = target.name;
    store.settings.persona = target.persona || '';
    store.settings.activeVoiceId = target.voiceId || '';
    saveStore();
    applyIdentity();
    refreshTrayMenu();
    return { ok: true, ...statePayload() };
  });

  /* ── 聊天记录管理 ── */
  const LOG_RANGE_DAYS = { today: 0, '7d': 7, '30d': 30, '90d': 90, all: 0 };

  function logDayOf(m) {
    const t = Date.parse(m && m.at ? m.at : '');
    if (!Number.isFinite(t)) return '';
    return dateKey(new Date(t));
  }

  function ensureLogIds() {
    const arr = logFor();
    let changed = false;
    for (const m of arr) {
      if (!m.id) { m.id = newLogId(); changed = true; }
    }
    return changed;
  }

  ipcMain.handle('log:list', (_e, { range = 'all', q = '', limit = 200, offset = 0 } = {}) => {
    if (ensureLogIds()) saveStore();
    const days = Object.prototype.hasOwnProperty.call(LOG_RANGE_DAYS, range) ? LOG_RANGE_DAYS[range] : 0;
    const cut = days ? Date.now() - days * 86400000 : 0;
    const needle = String(q || '').trim().toLowerCase();
    const all = logFor()
      .filter((m) => {
        const t = Date.parse(m.at || '');
        if (cut && Number.isFinite(t) && t < cut) return false;
        if (!needle) return true;
        return String(m.text || '').toLowerCase().includes(needle) || String(m.say || '').toLowerCase().includes(needle);
      })
      .map((m) => ({ id: m.id, role: m.role, text: m.text || '', say: m.say || '', at: m.at || '', day: logDayOf(m), brief: m.brief || '' }))
      .reverse();
    const lim = Math.max(20, Math.min(500, Number(limit) || 200));
    const off = Math.max(0, Number(offset) || 0);
    return {
      ok: true,
      total: all.length,
      offset: off,
      hasMore: off + lim < all.length,
      items: all.slice(off, off + lim),
      persona: { id: store.activePersonaId, name: assistantName() },
      retention: store.settings.chatRetention || '1m',
    };
  });

  // 导出当前筛选出的聊天记录（Markdown）
  ipcMain.handle('log:export', async (_e, { range = 'all', q = '' } = {}) => {
    if (ensureLogIds()) saveStore();
    const days = Object.prototype.hasOwnProperty.call(LOG_RANGE_DAYS, range) ? LOG_RANGE_DAYS[range] : 0;
    const cut = days ? Date.now() - days * 86400000 : 0;
    const needle = String(q || '').trim().toLowerCase();
    const rows = logFor()
      .filter((m) => {
        const t = Date.parse(m.at || '');
        if (cut && Number.isFinite(t) && t < cut) return false;
        if (!needle) return true;
        return String(m.text || '').toLowerCase().includes(needle) || String(m.say || '').toLowerCase().includes(needle);
      })
      .slice()
      .sort((a, b) => String(a.at).localeCompare(String(b.at)));
    if (!rows.length) return { ok: false, error: '这个范围里没有记录' };

    const name = assistantName();
    const stamp = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const file = `桌边-聊天记录-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}.md`;
    const autoPath = process.env.FISH_EXPORT_PATH || '';
    const res = autoPath ? { canceled: false, filePath: autoPath } : await dialog.showSaveDialog(win, {
      title: '导出聊天记录',
      defaultPath: path.join(app.getPath('documents'), file),
      filters: [{ name: 'Markdown', extensions: ['md'] }, { name: '文本', extensions: ['txt'] }],
      buttonLabel: '导出',
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };

    const WD2 = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const lines = [];
    lines.push(`# 聊天记录 · ${name}`);
    lines.push('');
    lines.push(`- 导出时间：${stamp.toLocaleString('zh-CN', { hour12: false })}`);
    lines.push(`- 范围：${range === 'all' ? '全部时间' : range === 'today' ? '今天' : `最近 ${days} 天`}`);
    if (needle) lines.push(`- 搜索：${q}`);
    lines.push(`- 共 ${rows.length} 条`);
    lines.push('');
    let lastDay = '';
    for (const m of rows) {
      const d = new Date(m.at || Date.now());
      const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      if (day !== lastDay) {
        lastDay = day;
        lines.push('');
        lines.push(`## ${day} ${WD2[d.getDay()]}`);
        lines.push('');
      }
      const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      const who = m.role === 'user' ? '我' : name;
      const tag = m.brief ? '（定时播报）' : '';
      lines.push(`**${who}** · ${hhmm}${tag}`);
      lines.push('');
      String(m.text || '').split('\n').forEach((ln) => lines.push(ln));
      lines.push('');
      if (m.say && m.say !== m.text) {
        lines.push(`> 喇叭里念的：${String(m.say).replace(/\n/g, ' ')}`);
        lines.push('');
      }
    }
    try {
      fs.writeFileSync(res.filePath, lines.join('\n'), 'utf8');
    } catch (err) {
      return { ok: false, error: `写入失败：${err.message}` };
    }
    logBoot(`log export ${rows.length} -> ${res.filePath}`);
    return { ok: true, path: res.filePath, count: rows.length };
  });

  ipcMain.handle('log:delete', (_e, { ids = [] } = {}) => {
    const set = new Set((ids || []).map(String));
    if (!set.size) return { ok: false, error: '没有选中任何记录' };
    const arr = logFor();
    const keep = arr.filter((m) => !set.has(String(m.id)));
    store.logs[store.activePersonaId] = keep;
    saveStore();
    return { ok: true, removed: arr.length - keep.length, ...statePayload() };
  });

  ipcMain.handle('log:delete-day', (_e, { day } = {}) => {
    if (!day) return { ok: false, error: '没有指定日期' };
    const arr = logFor();
    const keep = arr.filter((m) => logDayOf(m) !== day);
    store.logs[store.activePersonaId] = keep;
    saveStore();
    return { ok: true, removed: arr.length - keep.length, ...statePayload() };
  });

  ipcMain.handle('log:clear', () => {
    const arr = logFor();
    const n = arr.length;
    store.logs[store.activePersonaId] = [];
    saveStore();
    return { ok: true, removed: n, ...statePayload() };
  });

  ipcMain.handle('persona:remove', (_e, { id } = {}) => {
    if ((store.personas || []).length <= 1) return { ok: false, error: '至少要留一个人设' };
    const idx = store.personas.findIndex((x) => x.id === id);
    if (idx < 0) return { ok: false, error: '没找到这个人设' };
    store.personas.splice(idx, 1);
    delete store.logs[id];
    if (store.activePersonaId === id) {
      const p = store.personas[0];
      store.activePersonaId = p.id;
      store.settings.name = p.name;
      store.settings.persona = p.persona || '';
      store.settings.activeVoiceId = p.voiceId || '';
      applyIdentity();
    }
    saveStore();
    refreshTrayMenu();
    return { ok: true, ...statePayload() };
  });

  ipcMain.handle('tts:speak', async (_e, { text, quick } = {}) => speak(text, null, { quick: Boolean(quick) }));

  /* ── 角色音色库 IPC ── */

  ipcMain.handle('voice:add', (_e, payload = {}) => ({ ...addVoice(payload), ...statePayload() }));

  ipcMain.handle('voice:update', (_e, { id, patch } = {}) => ({ ...updateVoice(id, patch), ...statePayload() }));

  ipcMain.handle('voice:remove', (_e, { id } = {}) => ({ ...removeVoice(id), ...statePayload() }));

  ipcMain.handle('voice:activate', (_e, { id } = {}) => ({ ...setActiveVoice(id), ...statePayload() }));

  ipcMain.handle('voice:test', async (_e, { id } = {}) => {
    const v = id ? (store.voices || []).find((x) => x.id === id) : null;
    const res = await speak('你好呀，我是小偶。今天想先做哪件事？', v || activeVoice());
    return res;
  });

  ipcMain.handle('voice:pick-audio', async () => {
    if (!win || win.isDestroyed()) return { ok: false, canceled: true };
    const picked = await dialog.showOpenDialog(win, {
      title: '选一段参考音频（5~30 秒、只有一个人说话、没有背景音乐）',
      buttonLabel: '用这段',
      properties: ['openFile'],
      filters: [{ name: '音频', extensions: AUDIO_EXTS }, { name: '所有文件', extensions: ['*'] }],
    });
    if (picked.canceled || !picked.filePaths || !picked.filePaths[0]) return { ok: false, canceled: true };
    const f = picked.filePaths[0];
    try {
      const st = fs.statSync(f);
      return { ok: true, path: f, name: path.basename(f), size: st.size };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 无边框 + 透明窗口在 Windows 上没法拖边框改大小，由渲染层的右下角抓手直接改尺寸
  ipcMain.on('win:resize', (_e, size) => {
    if (!win || win.isDestroyed() || !size) return;
    if (store.settings.uiLocked) return;        // 已固定：不许改大小
    const { workArea } = screen.getPrimaryDisplay();
    const w = Math.max(320, Math.min(Math.round(Number(size.w) || 0), workArea.width - 40));
    const h = Math.max(420, Math.min(Math.round(Number(size.h) || 0), workArea.height - 60));
    try {
      const b = win.getBounds();
      win.setBounds({ x: b.x, y: b.y, width: w, height: h });
    } catch { /* ignore */ }
  });

  ipcMain.handle('voice:status', async () => {
    const paths = localPaths();
    return {
      local: await tts.localHealth(store.settings.localUrl),
      localUrl: store.settings.localUrl,
      paths: {
        repo: paths.repo,
        python: paths.python,
        script: paths.script,
        modelDir: paths.modelDir,
        repoExists: Boolean(paths.repo && fs.existsSync(paths.repo)),
        pythonExists: Boolean(paths.python && fs.existsSync(paths.python)),
        modelExists: Boolean(paths.modelDir && fs.existsSync(paths.modelDir)),
      },
      running: Boolean(localProc),
      enabled: store.settings.localEnabled !== false,
      fish: Boolean(unseal(store.settings.fishKeyEnc)),
    };
  });

  // 手动「启用本地音色」：拉起来并等模型加载完
  ipcMain.handle('voice:start-local', async () => {
    const r = await ensureLocalServer();
    return { ...r, status: await tts.localHealth(store.settings.localUrl) };
  });

  ipcMain.handle('voice:stop-local', () => {
    stopLocalServer();
    return { ok: true };
  });

  // 设置里的「本地语音模型」总开关：开=允许并立刻拉起，关=立刻停掉释放显存
  ipcMain.handle('voice:set-local-enabled', async (_e, { on }) => {
    const want = Boolean(on);
    store.settings.localEnabled = want;
    saveStore();
    if (!want) {
      stopLocalServer();
      logBoot('local tts disabled by user');
      return { ok: true, on: false, status: await tts.localHealth(store.settings.localUrl, 800) };
    }
    const r = await ensureLocalServer();
    return { ok: r.ok, error: r.error || '', on: true, status: await tts.localHealth(store.settings.localUrl, 1200) };
  });

  ipcMain.handle('brief:run', async (_e, { kind }) => {
    await fireBrief(kind === 'evening' ? 'evening' : 'morning');
    return statePayload();
  });

  ipcMain.handle('win:mode', (_e, { mode }) => {
    store.settings.mode = mode === 'desk' ? 'desk' : 'float';
    saveStore();
    applyWindowMode();
    refreshTrayMenu();
    return statePayload();
  });

  ipcMain.handle('win:hide', () => { win?.hide(); return { ok: true }; });
  ipcMain.handle('win:minimize', () => { win?.minimize(); return { ok: true }; });
  ipcMain.handle('app:open-data', () => { shell.openPath(DATA_DIR()); return { ok: true }; });
  ipcMain.handle('app:version', () => ({ version: app.getVersion(), electron: process.versions.electron }));

  // 从 .md / .txt 导入性格设定
  ipcMain.handle('persona:pick', async () => {
    if (!win || win.isDestroyed()) return { ok: false, canceled: true };
    const picked = await dialog.showOpenDialog(win, {
      title: '选一个写好的性格设定文件',
      buttonLabel: '导入',
      properties: ['openFile'],
      filters: [
        { name: 'Markdown / 文本', extensions: ['md', 'markdown', 'txt'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (picked.canceled || !picked.filePaths || !picked.filePaths[0]) {
      return { ok: false, canceled: true };
    }
    return readPersonaFile(picked.filePaths[0]);
  });
}

/* ─────────────────────────── 启动 ─────────────────────────── */

if (process.env.FISH_SMOKE) {
  // 自检/自动化测试：用独立的 userData，避免污染真实数据
  // 自检脚本放在 _dev/ 里（不进公开仓库）
  app.setPath('userData', path.join(__dirname, '_smoke_data'));
}
app.setAppUserModelId('com.deskside.app');
// 允许自动朗读：没有手势也放音
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });

  app.whenReady().then(() => {
    store = loadStore();
    resealPlainKeys();
    // 老用户已经有 Key（或已经选过本地模型）就当看过向导，别再弹一次
    if (store.settings.onboarded !== true && (store.settings.apiKeyEnc || store.settings.apiStyle === 'ollama')) {
      store.settings.onboarded = true;
    }
    ensurePersona();       // 老数据：单份 log → 当前人设；保证至少一个人设
    pruneLogs();           // 按保留期清掉过期聊天（待办不动）
    saveStore();           // 迁移/清理立即落盘
    rollover();
    registerIpc();
    createWindow();
    buildTray();
    applyAutoStart(store.settings.autoStart);

    let okMain = false;
    let okAlt = false;
    try {
      okMain = globalShortcut.register(HOTKEY_MAIN, toggleWindow);
      okAlt = globalShortcut.register(HOTKEY_ALT, toggleWindow);
    } catch (err) {
      logBoot(`hotkey error: ${err && err.message}`);
    }
    logBoot(`hotkey ${HOTKEY_MAIN}=${okMain} ${HOTKEY_ALT}=${okAlt}`);
    if (!okMain) {
      try {
        new Notification({
          title: assistantName(),
          body: `${HOTKEY_MAIN} 被别的软件占用了，点右下角托盘里的我，或者再打开一次桌边就能呼出。`,
          silent: true,
        }).show();
      } catch { /* ignore */ }
    }

    briefTimer = setInterval(() => {
      try { briefTick(); } catch (err) { console.error('[brief]', err); }
      try { reminderTick(); } catch (err) { console.error('[reminder]', err); }
      try { careTick(); } catch (err) { console.error('[care]', err); }
    }, 20000);

    if (process.env.FISH_SMOKE) {
      try {
        require('./_dev/_smoke').run({
          app, store, setApiKey, plainApiKey, aiJson, systemPrompt,
          extractJson, applyOps, speak, buildBrief, statePayload, normalizeAsk,
          readPersonaFile,
          addVoice, updateVoice, removeVoice, setActiveVoice, voiceRefPath, activeVoice,
          voiceDir: () => VOICE_DIR(),
          getWin: () => win,
          ensurePersona, activePersona, personaBrief, logFor, pushLog,
          ctxMessages, contextBlock, ctxWarnThreshold, addCtxWarnAck, pruneLogs, syncActivePersona,
          addTodo, findTodo, normalizeRepeat, nextRepeatDay, spawnNextRepeat,
          normalizeReminder, publicReminder, inQuietHours, reminderTick, reminderLine, remindTemplate, careLine, pushCare,
        });
      } catch (err) {
        console.error('[smoke]', err);
        app.exit(1);
      }
    }

    if (process.env.FISH_VOICE_TEST) {
      try {
        require('./_voice_test').run({
          app, store, speak, activeVoice, publicVoice,
          ensureLocalServer, stopLocalServer, localPaths,
          getWin: () => win, ttsDir: TTS_DIR,
        });
      } catch (err) {
        console.error('[voice-test]', err);
        app.exit(1);
      }
    }
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    clearInterval(briefTimer);
    stopLocalServer();
    saveNow();
  });

  app.on('window-all-closed', () => {
    // 常驻托盘，不退出
  });
}
