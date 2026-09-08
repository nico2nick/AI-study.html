// relay-server.js —— 多服务商、带 Key 的中转服务（支持智谱/DeepSeek/通义/月之暗面/硅基流动/OpenAI 等）
// 作用：把真实 API Key 安全放在服务器上，前端网页只发送「提示词 + 服务商代号」，
//      Key 永不出现在浏览器。配合 AI学习引擎.html 的「带 Key 的中转」使用，
//      最适合分享给别人或在手机上免配置使用。
//
// 用法（最简单）：
//   RELAY_KEY_ZHIPU=sk-xxx \
//   RELAY_KEY_DEEPSEEK=sk-yyy \
//   RELAY_TOKEN=study2026 \
//   PORT=8788 \
//   node relay-server.js
//
// 环境变量（每家 KEY 与 BASE 可独立配置；只配你想启用的）：
//   RELAY_TOKEN           必填（建议），访问口令；若设置，前端必须在设置里填同样的口令
//   PORT                  监听端口，默认 8788（Railway / Render 会自动注入）
//
//   RELAY_KEY_<PROVIDER>  服务商 API Key，例如 RELAY_KEY_ZHIPU / RELAY_KEY_DEEPSEEK
//   RELAY_BASE_<PROVIDER> 可选，自定义 Base（不填则用下面默认值）
//   RELAY_MODEL_<PROVIDER> 可选，该服务商的默认模型
//
// 默认服务商标识：
//   zhipu        → https://open.bigmodel.cn/api/paas/v4    默认 glm-4-flash
//   deepseek     → https://api.deepseek.com/v1             默认 deepseek-chat
//   qwen         → https://dashscope.aliyuncs.com/compatible-mode/v1  默认 qwen-plus
//   moonshot     → https://api.moonshot.cn/v1              默认 moonshot-v1-8k
//   siliconflow  → https://api.siliconflow.cn/v1           默认 deepseek-ai/DeepSeek-V3
//   openai       → https://api.openai.com/v1               默认 gpt-4o-mini
//   custom       → 无默认 base/model，必须由前端在调用时指定
//
// 健康检查（免费档 Railway 冷启动用它先暖一下）：
//   GET  /             → "AI 学习引擎 · 中转服务运行中"
//   GET  /providers    → JSON：{"providers":["zhipu","deepseek",...],"defaults":{...}}
//   POST /generate     → 主接口；请求体：{provider,model?,messages,temperature?,token?}
//   POST /probe        → 测速；请求体：{provider,model?,token?} 返回 {ok,latencyMs,error?}

const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 8788;
const TOKEN = process.env.RELAY_TOKEN || '';

// —— 多服务商注册表 ——
const PROVIDER_DEFAULTS = {
  zhipu:       { base: 'https://open.bigmodel.cn/api/paas/v4',     model: 'glm-4-flash' },
  deepseek:    { base: 'https://api.deepseek.com/v1',              model: 'deepseek-chat' },
  qwen:        { base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  moonshot:    { base: 'https://api.moonshot.cn/v1',               model: 'moonshot-v1-8k' },
  siliconflow: { base: 'https://api.siliconflow.cn/v1',            model: 'deepseek-ai/DeepSeek-V3' },
  openai:      { base: 'https://api.openai.com/v1',                model: 'gpt-4o-mini' },
  custom:      { base: '',                                         model: '' }
};

function getProviderConfig(name) {
  const key = String(name || '').toLowerCase().trim();
  const def = PROVIDER_DEFAULTS[key];
  if (!def) return null;
  return {
    name: key,
    base:  (process.env['RELAY_BASE_'  + key.toUpperCase()]  || def.base ).replace(/\/$/, ''),
    model: (process.env['RELAY_MODEL_' + key.toUpperCase()] || def.model),
    // —— 向后兼容：若没有 RELAY_KEY_<PROVIDER>，但配了旧版单一密钥，临时用旧的 ——
    hasKey:!!(process.env['RELAY_KEY_' + key.toUpperCase()] || (key === 'zhipu' && process.env.RELAY_API_KEY))
  };
}

function getApiKeyForProvider(name) {
  const upper = String(name || '').toUpperCase();
  return process.env['RELAY_KEY_' + upper] || (name === 'zhipu' && process.env.RELAY_API_KEY) || '';
}

function getBaseForProvider(name) {
  const upper = String(name || '').toUpperCase();
  return (process.env['RELAY_BASE_' + upper] || process.env.RELAY_BASE || '').replace(/\/$/, '');
}

function getModelForProvider(name) {
  const upper = String(name || '').toUpperCase();
  // 优先级：1) 显式 RELAY_MODEL_<PROVIDER>  2) PROVIDER_DEFAULTS 默认  3) 旧的 RELAY_MODEL（仅作为 zhipu legacy 兜底）
  return process.env['RELAY_MODEL_' + upper]
      || PROVIDER_DEFAULTS[name]?.model
      || (name === 'zhipu' && process.env.RELAY_MODEL)
      || '';
}

function listAvailableProviders() {
  // 列出所有至少配了 Key 的服务商；custom 不需要 Key（前端自带 Key 时使用），但默认隐藏
  const out = [];
  Object.keys(PROVIDER_DEFAULTS).forEach(k => {
    const c = getProviderConfig(k);
    if (!c) return;
    if (k === 'custom') return; // 自定义模式只有前端自带 Key 时才走，不进中转
    if (c.hasKey) out.push({ id: k, defaultModel: c.model, base: c.base });
  });
  return out;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8') || '{}';
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('非法 JSON 请求体')); }
    });
    req.on('error', e => reject(e));
  });
}

function callUpstream(targetBase, model, messages, apiKey, temperature) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ model, messages, temperature: (typeof temperature === 'number') ? temperature : 0.7 });
    const t = url.parse(targetBase + '/chat/completions');
    const lib = t.protocol === 'https:' ? https : http;
    const options = {
      method: 'POST',
      hostname: t.hostname,
      port: t.port || (t.protocol === 'https:' ? 443 : 80),
      path: t.path,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey, 'Content-Length': Buffer.byteLength(payload) }
    };
    const proxy = lib.request(options, (resp) => {
      const chunks = [];
      resp.on('data', c => chunks.push(c));
      resp.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve({ status: resp.statusCode, body, headers: resp.headers });
      });
    });
    proxy.on('error', e => reject(new Error('上游连接失败：' + e.message)));
    proxy.setTimeout(60000, () => { proxy.destroy(new Error('上游超时（60s）')); });
    proxy.write(payload);
    proxy.end();
  });
}

function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function jsonRes(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  applyCors(res);

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // —— 健康检查 ——
  if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    const list = listAvailableProviders().map(p => p.id).join(',') || '（未配置任何服务商）';
    return res.end('AI 学习引擎 · 中转服务运行中 (已配置：' + list + ')');
  }

  // —— 列出可用服务商（不含 Key）——
  if (req.method === 'GET' && req.url === '/providers') {
    const list = listAvailableProviders();
    const defaults = {};
    list.forEach(p => { defaults[p.id] = p.defaultModel; });
    return jsonRes(res, 200, { providers: list.map(p => p.id), defaults, tokenRequired: !!TOKEN });
  }

  if (req.method !== 'POST') {
    return jsonRes(res, 405, { error: 'method not allowed' });
  }

  // —— 下面所有 POST 接口都需要解析 body ——
  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return jsonRes(res, 400, { error: e.message }); }

  // —— 访问口令校验 ——
  if (TOKEN && body.token !== TOKEN) {
    return jsonRes(res, 403, { error: '访问口令错误' });
  }

  // —— 测速接口 ——
  if (req.url === '/probe') {
    const provider = (body.provider || 'zhipu').toLowerCase();
    const cfg = getProviderConfig(provider);
    if (!cfg) return jsonRes(res, 400, { error: '未知服务商：' + provider });
    if (!cfg.hasKey) return jsonRes(res, 503, { error: '该服务商未配置 Key（请在 Railway 环境变量里加 RELAY_KEY_' + provider.toUpperCase() + '）' });
    if (!cfg.base) return jsonRes(res, 500, { error: '该服务商未配置 Base URL' });
    const model = body.model || getModelForProvider(provider);
    const apiKey = getApiKeyForProvider(provider);
    const baseUrl = getBaseForProvider(provider);
    const t0 = Date.now();
    try {
      const r = await callUpstream(cfg.base, model,
        [{ role: 'user', content: 'ping' }], apiKey, 0);
      const dt = Date.now() - t0;
      if (r.status >= 400) return jsonRes(res, 200, { ok: false, latencyMs: dt, error: 'HTTP ' + r.status + ': ' + r.body.slice(0, 120) });
      return jsonRes(res, 200, { ok: true, latencyMs: dt, model });
    } catch (e) {
      const dt = Date.now() - t0;
      return jsonRes(res, 200, { ok: false, latencyMs: dt, error: e.message });
    }
  }

  // —— 主生成接口 ——
  if (req.url === '/generate') {
    const provider = (body.provider || '').toLowerCase();
    const cfg = getProviderConfig(provider);
    if (!cfg) return jsonRes(res, 400, { error: '未知服务商：' + (provider || '未指定').toString() + '（请填 provider 字段，如 "zhipu"/"deepseek"/"qwen"）' });
    if (!cfg.hasKey) return jsonRes(res, 503, { error: '中转未配置 ' + provider + ' 的 Key（需在 Railway 环境变量添加 RELAY_KEY_' + provider.toUpperCase() + '）' });
    if (!cfg.base) return jsonRes(res, 500, { error: '该服务商未配置 Base URL' });
    const model = body.model || getModelForProvider(provider);
    if (!model) return jsonRes(res, 400, { error: '未指定模型 model' });
    if (!Array.isArray(body.messages) || !body.messages.length) return jsonRes(res, 400, { error: '缺少 messages 字段' });

    const apiKey = getApiKeyForProvider(provider);
    const baseUrl = getBaseForProvider(provider);
    try {
      const r = await callUpstream(baseUrl, model, body.messages, apiKey, body.temperature);
      res.writeHead(r.status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, r.headers));
      res.end(r.body);
    } catch (e) {
      return jsonRes(res, 502, { error: e.message });
    }
    return;
  }

  return jsonRes(res, 404, { error: '未知接口：' + req.url });
});

server.listen(PORT, () => {
  const list = listAvailableProviders().map(p => p.id).join(',') || '（未配置任何服务商）';
  console.log('AI 中转已启动 :' + PORT + '  服务商=' + list + '  Token=' + (TOKEN ? '已设' : '无'));
});
