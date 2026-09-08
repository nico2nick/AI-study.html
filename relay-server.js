// relay-server.js —— 带 Key 的中转服务
// 作用：把真实 API Key 安全放在服务器上，前端网页只发送「提示词」，Key 永不出现在浏览器。
//      配合 AI学习引擎.html 的「带 Key 的中转」开关使用，最适合分享给别人或在手机上免配置使用。
//
// 用法：
//   RELAY_API_KEY=sk-xxxx RELAY_BASE=https://api.deepseek.com/v1 node relay-server.js
//
// 环境变量：
//   RELAY_API_KEY  必填，真实大模型 API Key（如 DeepSeek / 智谱 / 通义 等）
//   RELAY_BASE     必填，大模型 Base URL（通常以 /v1 结尾）
//   RELAY_MODEL    选填，默认模型（前端也可单独指定）
//   RELAY_TOKEN    选填，访问口令；若设置，前端必须在设置里填同样的口令
//   PORT           选填，监听端口，默认 8788
//
// 前端调用：POST /generate  { model?, messages:[{role,content}...], temperature?, token? }
// 服务返回与 OpenAI 一致的 JSON，前端据此解析内容。

const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 8788;
const API_KEY = process.env.RELAY_API_KEY || '';
const BASE = (process.env.RELAY_BASE || '').replace(/\/$/, '');
const DEFAULT_MODEL = process.env.RELAY_MODEL || '';
const TOKEN = process.env.RELAY_TOKEN || '';

const server = http.createServer((req, res) => {
  // 允许跨域：这样托管在任意静态站点上的 HTML 都能调用本服务
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('AI 学习引擎 · 中转服务运行中 (BASE=' + (BASE || '未配置') + ')');
  }

  if (req.method !== 'POST') { res.writeHead(405, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'method not allowed' })); }

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    if (!API_KEY || !BASE) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: '服务器未配置 RELAY_API_KEY / RELAY_BASE，请在环境变量中设置。' }));
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}'); }
    catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: '非法 JSON 请求体' })); }

    if (TOKEN && body.token !== TOKEN) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: '访问口令错误' }));
    }
    const model = body.model || DEFAULT_MODEL;
    if (!model) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: '未指定模型 model（可在前端设置里填，或在服务端用 RELAY_MODEL 指定）' })); }
    if (!Array.isArray(body.messages) || !body.messages.length) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: '缺少 messages 字段' })); }

    const payload = JSON.stringify({
      model,
      messages: body.messages,
      temperature: (typeof body.temperature === 'number') ? body.temperature : 0.7
    });

    const t = url.parse(BASE + '/chat/completions');
    const lib = t.protocol === 'https:' ? https : http;
    const options = {
      method: 'POST',
      hostname: t.hostname,
      port: t.port || (t.protocol === 'https:' ? 443 : 80),
      path: t.path,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + API_KEY }
    };
    const proxy = lib.request(options, (resp) => {
      res.writeHead(resp.statusCode, resp.headers);
      resp.pipe(res);
    });
    proxy.on('error', (e) => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '上游错误：' + e.message })); });
    proxy.write(payload);
    proxy.end();
  });
});

server.listen(PORT, () => console.log('中转服务已启动：http://localhost:' + PORT + '  (BASE=' + (BASE || '未配置') + ', TOKEN=' + (TOKEN ? '已设' : '无') + ')'));
