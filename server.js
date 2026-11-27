const http = require("http");

const PORT = process.env.PORT || 3000;
const AGNES_API_KEY = process.env.AGNES_API_KEY || "";
const AGNES_BASE = process.env.AGNES_BASE_URL || "https://apihub.agnes-ai.com";
const MODEL = "agnes-video-2.5-flash";

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) reject(new Error("too large")); });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error("bad json")); } });
    req.on("error", reject);
  });
}

async function agnes(path, options = {}) {
  const res = await fetch(AGNES_BASE + path, {
    ...options,
    headers: { Authorization: `Bearer ${AGNES_API_KEY}`, "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) {
    const msg = json?.error?.message || json?.message || text.slice(0, 200);
    throw new Error(`Agnes ${res.status}: ${msg}`);
  }
  return json;
}

function friendlyError(err) {
  const m = String(err?.message || err);
  if (m.includes("401") || m.includes("Token")) return "مفتاح Agnes غير صالح أو غير مضبوط.";
  if (m.includes("429") || m.includes("503") || m.includes("queue")) return "طابور التوليد ممتلئ حالياً. جرّب بعد قليل.";
  if (m.includes("402")) return "انتهى رصيد Agnes المجاني حالياً.";
  return "تعذر توليد الفيديو الآن. حاول مجددًا.";
}

const page = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>مِشهد | توليد فيديو بالذكاء الاصطناعي</title>
<style>
  body { font-family: system-ui, sans-serif; background:#0f1420; color:#eef2ff; margin:0; padding:20px; }
  .wrap { max-width:640px; margin:0 auto; }
  h1 { font-size:26px; margin:8px 0 4px; }
  p.sub { color:#9fb0d0; margin:0 0 18px; }
  textarea { width:100%; box-sizing:border-box; min-height:110px; border-radius:14px; border:1px solid #2b3a5f; background:#16203a; color:#eef2ff; padding:12px; font-size:16px; }
  .row { display:flex; gap:10px; margin-top:12px; flex-wrap:wrap; }
  select { flex:1; min-width:140px; border-radius:12px; border:1px solid #2b3a5f; background:#16203a; color:#eef2ff; padding:12px; font-size:15px; }
  button { width:100%; margin-top:14px; padding:14px; border:0; border-radius:14px; background:#4f7cff; color:#fff; font-size:17px; font-weight:700; cursor:pointer; }
  button:disabled { background:#335; cursor:wait; }
  #status { margin-top:14px; color:#cfe0ff; min-height:22px; }
  video { width:100%; margin-top:14px; border-radius:14px; background:#000; }
  a.dl { display:none; margin-top:10px; color:#8fb3ff; }
</style>
</head>
<body>
<div class="wrap">
  <h1>🎬 مِشهد</h1>
  <p class="sub">اكتب وصف المشهد، وولّد مقطع فيديو قصيراً.</p>
  <textarea id="prompt" placeholder="مثال: شروق الشمس فوق البحر، كاميرا تتحرك ببطء، ألوان دافئة"></textarea>
  <div class="row">
    <select id="aspect">
      <option value="16:9">أفقي 16:9</option>
      <option value="9:16">عمودي 9:16</option>
      <option value="1:1">مربع 1:1</option>
    </select>
    <select id="seconds">
      <option value="5">5 ثوانٍ</option>
      <option value="8">8 ثوانٍ</option>
      <option value="12">12 ثانية</option>
    </select>
  </div>
  <button id="go">ولّد الفيديو</button>
  <div id="status"></div>
  <video id="out" controls playsinline style="display:none"></video>
  <a id="dl" class="dl" download="mishhad-video.mp4">⬇️ تنزيل الفيديو</a>
</div>
<script>
const $ = (id) => document.getElementById(id);
async function poll(id) {
  for (let i = 0; i < 160; i++) {
    const r = await fetch("/api/video/" + encodeURIComponent(id));
    const j = await r.json();
    if (j.url) return j.url;
    if (j.error) throw new Error(j.error);
    $("status").textContent = "جارٍ التوليد… قد يأخذ بضع دقائق (" + (i + 1) + ")";
    await new Promise((res) => setTimeout(res, 5000));
  }
  throw new Error("طال الانتظار. حاول مجددًا.");
}
$("go").onclick = async () => {
  const prompt = $("prompt").value.trim();
  if (!prompt) { $("status").textContent = "اكتب وصفاً أولاً."; return; }
  $("go").disabled = true;
  $("out").style.display = "none";
  $("dl").style.display = "none";
  $("status").textContent = "جارٍ إرسال الطلب…";
  try {
    const r = await fetch("/api/video", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, aspect: $("aspect").value, seconds: $("seconds").value }) });
    const j = await r.json();
    if (!j.videoId) throw new Error(j.error || "تعذر بدء التوليد.");
    const url = await poll(j.videoId);
    $("out").src = url;
    $("out").style.display = "block";
    $("dl").href = url;
    $("dl").style.display = "inline-block";
    $("status").textContent = "تم ✅";
  } catch (e) {
    $("status").textContent = e.message;
  } finally {
    $("go").disabled = false;
  }
};
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, keySet: Boolean(AGNES_API_KEY) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/video") {
      if (!AGNES_API_KEY) return sendJson(res, 200, { error: "توليد الفيديو غير مهيأ. أضف AGNES_API_KEY إلى إعدادات الخادم." });
      const body = await readBody(req);
      const prompt = String(body.prompt || "").trim().slice(0, 1000);
      if (!prompt) return sendJson(res, 200, { error: "اكتب وصفاً أولاً." });
      const aspect = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"].includes(body.aspect) ? body.aspect : "16:9";
      const seconds = ["4", "5", "6", "8", "10", "12"].includes(String(body.seconds)) ? String(body.seconds) : "5";
      let created = null;
      let lastErr = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          created = await agnes("/v1/videos", {
            method: "POST",
            body: JSON.stringify({ model: MODEL, mode: "text", prompt, size: "720P", aspect_ratio: aspect, seconds, n: 1 }),
          });
          break;
        } catch (err) {
          lastErr = err;
          const m = String(err?.message || err);
          if (!m.includes("503") && !m.includes("429") && !m.includes("queue")) throw err;
          await new Promise((r) => setTimeout(r, 20000));
        }
      }
      if (!created) throw lastErr || new Error("create failed");
      const videoId = created?.video_id || created?.id || created?.data?.video_id;
      if (!videoId) return sendJson(res, 200, { error: "تعذر بدء التوليد." });
      return sendJson(res, 200, { videoId });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/video/")) {
      if (!AGNES_API_KEY) return sendJson(res, 200, { error: "توليد الفيديو غير مهيأ." });
      const id = decodeURIComponent(url.pathname.slice("/api/video/".length));
      const st = await agnes(`/agnesapi?video_id=${encodeURIComponent(id)}&model_name=${encodeURIComponent(MODEL)}`);
      const videoUrl = st?.metadata?.url || st?.url || st?.data?.url || st?.video_url;
      if (videoUrl) return sendJson(res, 200, { url: videoUrl });
      const status = String(st?.status || st?.data?.status || "").toLowerCase();
      if (status.includes("fail") || status.includes("error")) return sendJson(res, 200, { error: "فشل التوليد. حاول مجددًا." });
      return sendJson(res, 200, { status: status || "pending" });
    }
    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    console.error("Video request failed:", err);
    sendJson(res, 200, { error: friendlyError(err) });
  }
});

server.listen(PORT, () => console.log("video-site listening on", PORT));
