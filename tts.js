'use strict';

/**
 * 语音引擎路由：把一个「角色音色」变成一段音频文件。
 *
 * 支持三种引擎：
 *   edge  —— msedge-tts（微软朗读接口，固定音色，永远可用的兜底）
 *   local —— 本机 IndexTTS-2.5 sidecar（HTTP，零样本克隆，可离线）
 *   fish  —— Fish Audio 云端（按量计费，不占显存）
 *
 * 约定：本模块只负责「拿到音频字节」，缓存、dataUrl、播放都由 main.js 处理；
 * 任何引擎失败都抛错，由上层决定是否降级到 edge。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const DEFAULTS = {
  localUrl: 'http://127.0.0.1:8756',
  fishUrl: 'https://api.fish.audio/v1/tts',
  fishModel: 's1',
  edgeVoice: 'zh-CN-XiaoxiaoNeural',
};

/* ───────────────────── 引擎：edge ───────────────────── */

let edgeClient = null;
let edgeChain = Promise.resolve();

function createEdgeEngine(msedge) {
  const { MsEdgeTTS, OUTPUT_FORMAT } = msedge;
  return async function synthEdge({ text, voice, rate }) {
    const run = async () => {
      if (!edgeClient) edgeClient = new MsEdgeTTS({ connectionTimeoutMs: 12000, synthesisTimeoutMs: 45000 });
      await edgeClient.setMetadata(voice || DEFAULTS.edgeVoice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      const opts = rate ? { rate: `${rate > 0 ? '+' : ''}${rate}%` } : {};
      const { audioStream } = edgeClient.toStream(text, opts);
      const chunks = [];
      await new Promise((resolve, reject) => {
        audioStream.on('data', (c) => chunks.push(c));
        audioStream.on('end', resolve);
        audioStream.on('error', reject);
      });
      const buf = Buffer.concat(chunks);
      if (buf.length < 800) throw new Error('语音返回为空');
      return { buf, ext: 'mp3', mime: 'audio/mpeg' };
    };
    const p = edgeChain.then(run, run);
    edgeChain = p.catch(() => {});
    try {
      return await p;
    } catch (err) {
      edgeClient = null; // 连接可能已坏，下次重建
      throw err;
    }
  };
}

/* ───────────────────── 通用 HTTP ───────────────────── */

function postJson(url, body, { headers = {}, timeout = 90000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode || 0, headers: res.headers, buf });
        });
      }
    );
    req.setTimeout(timeout, () => req.destroy(new Error('语音服务超时')));
    req.on('error', reject);
    req.end(payload);
  });
}

function getJson(url, { timeout = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(
      { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname, timeout },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data = null;
          try { data = JSON.parse(text); } catch { /* 不是 JSON 就算了 */ }
          resolve({ status: res.statusCode || 0, data, text });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/* ───────────────────── 引擎：local（IndexTTS sidecar） ───────────────────── */

async function synthLocal({ text, voice, style, baseUrl }) {
  const url = (baseUrl || DEFAULTS.localUrl).replace(/\/+$/, '');
  const body = {
    text,
    ref_audio: voice.refAudio || '',
    ref_text: voice.refText || '',
    emo: voice.emo || 'neutral',
    emo_alpha: typeof voice.emoAlpha === 'number' ? voice.emoAlpha : 0.8,
    speed: typeof voice.speed === 'number' ? voice.speed : 1.0,
    style: style || voice.style || '',
  };
  const r = await postJson(url + '/tts', body, { timeout: 120000 });
  if (r.status !== 200) {
    throw new Error(`本地语音服务返回 ${r.status}：${r.buf.toString('utf8').slice(0, 120)}`);
  }
  const ct = String(r.headers['content-type'] || '');
  if (/json/.test(ct)) {
    const j = JSON.parse(r.buf.toString('utf8'));
    if (!j.audio) throw new Error(j.error || '本地语音服务没有返回音频');
    return { buf: Buffer.from(j.audio, 'base64'), ext: j.ext || 'wav', mime: j.mime || 'audio/wav' };
  }
  if (r.buf.length < 800) throw new Error('本地语音服务返回为空');
  const ext = /wav/.test(ct) ? 'wav' : 'mp3';
  return { buf: r.buf, ext, mime: /wav/.test(ct) ? 'audio/wav' : 'audio/mpeg' };
}

async function localHealth(baseUrl, timeout = 2500) {
  const base = (baseUrl || DEFAULTS.localUrl).replace(/\/+$/, '');
  try {
    const r = await getJson(base + '/health', { timeout });
    if (r.status !== 200) return { ok: false, error: `健康检查返回 ${r.status}` };
    const d = r.data || {};
    return {
      ok: Boolean(d.ready),
      up: true,
      ready: Boolean(d.ready),
      loading: Boolean(d.loading),
      error: d.error || '',
      device: d.device || '',
    };
  } catch (err) {
    return { ok: false, up: false, error: String((err && err.message) || err) };
  }
}

/* ───────────────────── 引擎：fish（云端） ───────────────────── */

async function synthFish({ text, voice, apiKey, model, format }) {
  if (!apiKey) throw new Error('还没有填 Fish Audio 的 API Key');
  const body = {
    text,
    format: format || 'mp3',
    mp3_bitrate: 192,
    chunk_length: 200,
    normalize: true,
    latency: 'normal',
  };
  if (voice.remoteVoiceId) body.reference_id = voice.remoteVoiceId;
  const r = await postJson(
    DEFAULTS.fishUrl,
    body,
    {
      headers: {
        Authorization: 'Bearer ' + apiKey,
        model: model || DEFAULTS.fishModel,
      },
      timeout: 90000,
    }
  );
  if (r.status !== 200) {
    throw new Error(`Fish Audio 返回 ${r.status}：${r.buf.toString('utf8').slice(0, 160)}`);
  }
  const ct = String(r.headers['content-type'] || '');
  if (/json/.test(ct)) {
    const j = JSON.parse(r.buf.toString('utf8'));
    if (!j.audio) throw new Error(j.message || 'Fish Audio 没有返回音频');
    return { buf: Buffer.from(j.audio, 'base64'), ext: 'mp3', mime: 'audio/mpeg' };
  }
  if (r.buf.length < 800) throw new Error('Fish Audio 返回为空');
  return { buf: r.buf, ext: 'mp3', mime: 'audio/mpeg' };
}

/* ───────────────────── 路由 ───────────────────── */

function cacheKey(engine, voice, text) {
  const tag = [
    engine,
    voice && voice.id,
    voice && voice.edgeVoice,
    voice && voice.remoteVoiceId,
    voice && voice.refAudio,
    voice && voice.emo,
    voice && voice.speed,
    text,
  ].join('|');
  return crypto.createHash('sha1').update(tag).digest('hex');
}

function makeTts({ msedge, cacheDir, getFishKey, log }) {
  const synthEdge = createEdgeEngine(msedge);

  /**
   * @param {object} o
   * @param {string} o.text
   * @param {object} o.voice  角色音色记录（含 engine/refAudio/remoteVoiceId/...）
   * @param {number} o.rate   edge 语速百分比
   * @param {string} o.baseUrl 本地服务地址
   * @returns {Promise<{file:string, mime:string, engine:string, fallback:boolean}>}
   */
  async function synth({ text, voice, rate }) {
    const v = voice || { engine: 'edge' };
    const engine = v.engine || 'edge';
    const file = path.join(cacheDir(), cacheKey(engine, v, text) + '.cue');
    // 缓存命中（扩展名在运行时确定，所以用同名不同扩展去找）
    for (const ext of ['mp3', 'wav']) {
      const f = file.replace(/\.cue$/, '.' + ext);
      if (fs.existsSync(f) && fs.statSync(f).size > 800) {
        return { file: f, mime: ext === 'wav' ? 'audio/wav' : 'audio/mpeg', engine, fallback: false };
      }
    }

    let out;
    let used = engine;
    let fallback = false;
    try {
      if (engine === 'local') {
        out = await synthLocal({ text, voice: v, baseUrl: v.localUrl });
      } else if (engine === 'fish') {
        out = await synthFish({ text, voice: v, apiKey: getFishKey(), model: v.fishModel });
      } else {
        out = await synthEdge({ text, voice: v.edgeVoice, rate });
      }
    } catch (err) {
      if (engine === 'edge') throw err;
      log(`[tts] ${engine} 失败，降级 edge：${err && err.message}`);
      out = await synthEdge({ text, voice: v.edgeVoice, rate });
      used = 'edge';
      fallback = true;
    }

    fs.mkdirSync(cacheDir(), { recursive: true });
    const dest = file.replace(/\.cue$/, '.' + out.ext);
    fs.writeFileSync(dest + '.part', out.buf);
    fs.renameSync(dest + '.part', dest);
    return { file: dest, mime: out.mime, engine: used, fallback };
  }

  return { synth, localHealth };
}

module.exports = { makeTts, DEFAULTS };
