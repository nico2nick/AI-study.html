// ▼▼▼ 你（或我）只需要改这一行 ▼▼▼
// 部署 relay-server.js 之后，把平台给你的「中转地址」填到 url 里（末尾要带 /generate）
// token 必须与 relay-server.js 启动时设置的 RELAY_TOKEN 完全一致；若服务端没设口令就留空 ""
// provider 是默认启用的服务商（用户也可在 UI 里随时切换）：zhipu / deepseek / qwen / moonshot / siliconflow / openai
window.APP_RELAY = {
  url: "https://ai-learn-relay-production.up.railway.app/generate",  // 你的 Railway 中转
  token: "study2026",                                                // 与服务端 RELAY_TOKEN 一致
  provider: "zhipu",                                                 // 默认服务商（zhipu 国内快/免费）
  model: "glm-4-flash"                                               // 与 provider 对应的默认模型
};
// ▲▲▲ 改完保存并重新上传这个文件即可：网页会自动启用中转，任何人打开链接都能直接生成学习计划 ▲▲▲
// ★ 给中转增加新服务商：登录 Railway → Variables → 加 RELAY_KEY_DEEPSEEK=sk-xxx，无需重新部署
