const http = require("http");

const PORT = process.env.PORT || 3000;
const AGNES_API_KEY = process.env.AGNES_API_KEY || "";
const AGNES_BASE = process.env.AGNES_BASE_URL || "https://apihub.agnes-ai.com";
const MODEL = "agnes-video-2.5-flash";
const POLLINATIONS_API_KEY = process.env.POLLINATIONS_API_KEY || "";
const POLLINATIONS_BASE = process.env.POLLINATIONS_BASE_URL || "https://gen.pollinations.ai";
const MAGIC_HOUR_API_KEY = process.env.MAGIC_HOUR_API_KEY || "";
const MAGIC_HOUR_BASE = process.env.MAGIC_HOUR_BASE_URL || "https://api.magichour.ai";
const mediaStore = new Map();
const mediaErrors = new Map();
const mediaPending = new Set();

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 8e6) reject(new Error("too large")); });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error("bad json")); } });
    req.on("error", reject);
  });
}

async function translatePrompt(prompt) {
  if (!/[\u0600-\u06FF]/.test(prompt)) return prompt;
  try {
    const r = await fetch("https://apihub.agnes-ai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGNES_API_KEY}` },
      body: JSON.stringify({ model: "agnes-1.5-flash", messages: [{ role: "user", content: "Translate this Arabic image prompt to English. Reply with the English translation only, no quotes, no explanation: " + prompt }] }),
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json().catch(() => null);
    const c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (r.ok && c) return String(c).trim().replace(/^"|"$/g, "");
  } catch {}
  try {
    const r = await fetch(`${POLLINATIONS_BASE}/text/${encodeURIComponent("Translate to English, output only the translation: " + prompt)}?model=openai`, {
      headers: POLLINATIONS_API_KEY ? { Authorization: `Bearer ${POLLINATIONS_API_KEY}` } : {},
    });
    const t = (await r.text()).trim();
    if (r.ok && t) {
      try {
        const j = JSON.parse(t);
        const c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
        if (c) return String(c).trim().replace(/^"|"$/g, "");
      } catch {}
      if (!t.startsWith("{")) return t.replace(/^"|"$/g, "");
    }
  } catch {}
  try {
    const r = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(prompt)}&langpair=ar|en`);
    const j = await r.json();
    const t = j && j.responseData && j.responseData.translatedText;
    return t && !/INVALID|QUERY LENGTH/i.test(t) ? t : prompt;
  } catch {
    return prompt;
  }
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

async function pollinationsVideo(prompt, aspect) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 240000);
  try {
    const res = await fetch(`${POLLINATIONS_BASE}/video/${encodeURIComponent(prompt)}?model=alibaba/wan-2.2-fast&duration=5&aspectRatio=${encodeURIComponent(aspect)}`, {
      headers: { Authorization: `Bearer ${POLLINATIONS_API_KEY}` },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Pollinations ${res.status}`);
    const type = res.headers.get("content-type") || "";
    if (!type.includes("video")) throw new Error("Pollinations did not return video");
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

async function magicHour(path, options = {}) {
  const res = await fetch(MAGIC_HOUR_BASE + path, {
    ...options,
    headers: { Authorization: `Bearer ${MAGIC_HOUR_API_KEY}`, "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`MagicHour ${res.status}: ${json?.error?.message || json?.message || text.slice(0, 160)}`);
  return json;
}

function friendlyError(err) {
  const m = String(err?.message || err);
  if (m.includes("401") || m.includes("Token")) return "مفتاح التوليد غير صالح أو غير مضبوط.";
  if (m.includes("429") || m.includes("503") || m.includes("queue")) return "طابور التوليد ممتلئ حالياً. جرّب بعد قليل.";
  if (m.includes("402")) return "رصيد الخدمة الاحتياطية لا يكفي لهذه المحاولة. جرّب مدة أقصر أو بعد قليل.";
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
  #menuBtn { position:fixed; top:14px; inset-inline-start:14px; width:46px; height:46px; border-radius:12px; font-size:22px; margin:0; padding:0; z-index:20; }
  #sidebar { position:fixed; top:0; inset-inline-start:0; height:100%; width:270px; max-width:82vw; background:#131c33; border-inline-end:1px solid #2b3a5f; padding:64px 16px 16px; box-sizing:border-box; transform:translateX(105%); transition:transform .25s; z-index:15; overflow-y:auto; }
  [dir="rtl"] #sidebar { transform:translateX(105%); }
  #sidebar.open { transform:translateX(0); }
  #sidebar h3 { margin:14px 0 8px; font-size:16px; }
  .histItem { display:flex; gap:8px; align-items:center; background:#16203a; border:1px solid #2b3a5f; border-radius:10px; padding:8px; margin-top:8px; }
  .histItem a { color:#8fb3ff; flex:1; font-size:14px; }
  .histItem button { width:34px; height:34px; margin:0; padding:0; border-radius:8px; background:#5a2430; font-size:15px; }
  .navBtn { margin-top:8px; background:#22345e; }
</style>
</head>
<body>
<button id="menuBtn">☰</button>
<aside id="sidebar">
  <h3>التنقل</h3>
  <button class="navBtn" id="navVideo">🎬 الفيديو</button>
  <button class="navBtn" id="navImage">🎨 الصور</button>
  <h3>المحفوظة</h3>
  <div id="history"></div>
  <button class="navBtn" id="clearHist" style="background:#5a2430">✕ حذف الكل</button>
</aside>
<div class="wrap">
  <h1>🎬 مِشهد</h1>
  <p class="sub">اكتب وصف المشهد، وولّد مقطع فيديو قصيراً.</p>
  <textarea id="prompt" placeholder="مثال: شروق الشمس فوق البحر، كاميرا تتحرك ببطء، ألوان دافئة"></textarea>
  <label style="display:block;margin-top:12px;color:#cfe0ff">📷 صورة للتحريك (اختياري)</label>
  <input id="image" type="file" accept="image/*" style="width:100%;box-sizing:border-box;margin-top:6px;border-radius:12px;border:1px solid #2b3a5f;background:#16203a;color:#eef2ff;padding:12px;font-size:15px">
  <img id="preview" style="display:none;width:100%;margin-top:10px;border-radius:14px">
  <div class="row">
    <select id="aspect">
      <option value="16:9">أفقي 16:9</option>
      <option value="9:16">عمودي 9:16</option>
      <option value="1:1">مربع 1:1</option>
    </select>
    <select id="seconds">
      <option value="" selected>تلقائي (اختياري)</option>
      <option value="5">5 ثوانٍ</option>
      <option value="10">10 ثوانٍ</option>
      <option value="20">20 ثانية</option>
      <option value="30">30 ثانية</option>
      <option value="60">60 ثانية (الأقصى)</option>
    </select>
  </div>
  <button id="go">ولّد الفيديو</button>
  <button id="goimg" style="background:#8a5cff">🎨 ولّد صورة</button>
  <button id="editimg" style="background:#c2692e">✏️ عدّل الصورة المرفوعة</button>
  <div id="status"></div>
  <video id="out" controls playsinline style="display:none"></video>
  <img id="outimg" style="display:none;width:100%;margin-top:14px;border-radius:14px">
  <a id="dlimg" class="dl" download="mishhad-image.jpg">⬇️ تنزيل الصورة</a>
  <a id="dl" class="dl" download="mishhad-video.mp4">⬇️ تنزيل الفيديو</a>
  <button id="extend" style="display:none;background:#2f9e6e">⏩ تمديد الفيديو</button>
</div>
<script>
const $ = (id) => document.getElementById(id);
$("menuBtn").onclick = () => $("sidebar").classList.toggle("open");
$("navVideo").onclick = () => { $("out").scrollIntoView({ behavior: "smooth" }); $("sidebar").classList.remove("open"); };
$("navImage").onclick = () => { $("outimg").scrollIntoView({ behavior: "smooth" }); $("sidebar").classList.remove("open"); };
function loadHist() { try { return JSON.parse(localStorage.getItem("mishhad_history") || "[]"); } catch { return []; } }
function renderHist() {
  const h = loadHist();
  $("history").innerHTML = h.length ? "" : "<div style='color:#9fb0d0;font-size:14px'>لا شيء محفوظ بعد.</div>";
  h.forEach((it, i) => {
    const d = document.createElement("div");
    d.className = "histItem";
    d.innerHTML = "<a target='_blank' rel='noopener'>" + (it.type === "video" ? "🎬 فيديو " : "🎨 صورة ") + it.date + "</a>";
    d.querySelector("a").href = it.url;
    const dl = document.createElement("a");
    dl.textContent = "⬇️";
    dl.href = it.url;
    dl.setAttribute("download", it.type === "video" ? "mishhad-video.mp4" : "mishhad-image.jpg");
    dl.style.flex = "0";
    d.appendChild(dl);
    const b = document.createElement("button");
    b.textContent = "✕";
    b.onclick = () => { const x = loadHist(); x.splice(i, 1); localStorage.setItem("mishhad_history", JSON.stringify(x)); renderHist(); };
    d.appendChild(b);
    $("history").appendChild(d);
  });
}
function saveHist(type, url) {
  const h = loadHist();
  h.unshift({ type, url, date: new Date().toLocaleString("ar") });
  localStorage.setItem("mishhad_history", JSON.stringify(h.slice(0, 20)));
  renderHist();
}
$("clearHist").onclick = () => { localStorage.removeItem("mishhad_history"); renderHist(); };
renderHist();
let imageData = "";
$("image").onchange = () => {
  const f = $("image").files[0];
  if (!f) { imageData = ""; $("preview").style.display = "none"; return; }
  const r = new FileReader();
  r.onload = () => { imageData = r.result; $("preview").src = imageData; $("preview").style.display = "block"; };
  r.readAsDataURL(f);
};
async function translateClient(prompt) {
  if (!/[\u0600-\u06FF]/.test(prompt)) return prompt;
  try {
    const r = await fetch("https://api.mymemory.translated.net/get?q=" + encodeURIComponent(prompt) + "&langpair=ar|en");
    const j = await r.json();
    const t = j && j.responseData && j.responseData.translatedText;
    return t && !/INVALID|QUERY LENGTH|MYMEMORY WARNING/i.test(t) ? t : prompt;
  } catch {
    return prompt;
  }
}
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
  if (!prompt && !imageData) { $("status").textContent = "اكتب وصفاً أو ارفع صورة أولاً."; return; }
  $("go").disabled = true;
  $("out").style.display = "none";
  $("dl").style.display = "none";
  $("preview").style.display = "none";
  $("outimg").style.display = "none";
  $("dlimg").style.display = "none";
  $("status").textContent = "جارٍ إرسال الطلب…";
  try {
    const r = await fetch("/api/video", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, aspect: $("aspect").value, seconds: $("seconds").value, imageData }) });
    const j = await r.json();
    if (!j.videoId) throw new Error(j.error || "تعذر بدء التوليد.");
    $("status").textContent = j.videoId.startsWith("mh-") ? "يولّد الآن عبر Magic Hour…" : j.videoId.startsWith("polli-") ? "يولّد الآن عبر Pollinations…" : "يولّد الآن عبر Agnes…";
    const url = await poll(j.videoId);
    $("out").src = url;
    $("out").style.display = "block";
    $("out").play().catch(() => {});
    $("dl").href = url;
    $("dl").style.display = "inline-block";
    $("extend").style.display = "block";
    saveHist("video", url);
    $("status").textContent = "تم ✅";
  } catch (e) {
    $("status").textContent = e.message;
  } finally {
    $("go").disabled = false;
  }
};
$("goimg").onclick = async () => {
  const prompt = $("prompt").value.trim();
  if (!prompt) { $("status").textContent = "اكتب وصف الصورة أولاً."; return; }
  $("goimg").disabled = true;
  $("out").style.display = "none";
  $("dl").style.display = "none";
  $("extend").style.display = "none";
  $("status").textContent = "جارٍ توليد الصورة…";
  try {
    const r = await fetch("/api/image", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: await translateClient(prompt), aspect: $("aspect").value }) });
    const j = await r.json();
    if (!j.url) throw new Error(j.error || "تعذر توليد الصورة.");
    $("outimg").src = j.url;
    $("outimg").style.display = "block";
    $("dlimg").href = j.url;
    $("dlimg").style.display = "inline-block";
    saveHist("image", j.url);
    $("status").textContent = "تم ✅";
  } catch (e) {
    $("status").textContent = e.message;
  } finally {
    $("goimg").disabled = false;
  }
};
$("editimg").onclick = async () => {
  const prompt = $("prompt").value.trim();
  if (!imageData) { $("status").textContent = "ارفع صورة أولاً."; return; }
  if (!prompt) { $("status").textContent = "اكتب التعديل المطلوب."; return; }
  $("editimg").disabled = true;
  $("out").style.display = "none";
  $("dl").style.display = "none";
  $("extend").style.display = "none";
  $("status").textContent = "جارٍ تعديل الصورة…";
  try {
    const r = await fetch("/api/image-edit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: await translateClient(prompt), imageData }) });
    const j = await r.json();
    if (!j.url) throw new Error(j.error || "تعذر تعديل الصورة.");
    $("outimg").src = j.url;
    $("outimg").style.display = "block";
    $("dlimg").href = j.url;
    $("dlimg").style.display = "inline-block";
    saveHist("image", j.url);
    $("status").textContent = "تم ✅";
  } catch (e) {
    $("status").textContent = e.message;
  } finally {
    $("editimg").disabled = false;
  }
};
$("extend").onclick = async () => {
  $("extend").disabled = true;
  $("status").textContent = "جارٍ توليد مقطع تكميلي…";
  try {
    const base = $("prompt").value.trim();
    const prompt = base ? base + ", continue the scene seamlessly" : "continue the scene seamlessly";
    const r = await fetch("/api/video", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, aspect: $("aspect").value, seconds: $("seconds").value, imageData }) });
    const j = await r.json();
    if (!j.videoId) throw new Error(j.error || "تعذر بدء التمديد.");
    $("status").textContent = j.videoId.startsWith("mh-") ? "يمدّد الآن عبر Magic Hour…" : j.videoId.startsWith("polli-") ? "يمدّد الآن عبر Pollinations…" : "يمدّد الآن عبر Agnes…";
    const url = await poll(j.videoId);
    $("out").src = url;
    $("out").style.display = "block";
    $("dl").href = url;
    $("dl").style.display = "inline-block";
    saveHist("video", url);
    $("status").textContent = "تم التمديد ✅";
  } catch (e) {
    $("status").textContent = e.message;
  } finally {
    $("extend").disabled = false;
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
      sendJson(res, 200, { ok: true, keySet: Boolean(AGNES_API_KEY), pollinationsKeySet: Boolean(POLLINATIONS_API_KEY), magicHourKeySet: Boolean(MAGIC_HOUR_API_KEY) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/image") {
      const body = await readBody(req);
      const prompt = String(body.prompt || "").trim().slice(0, 1000);
      if (!prompt) return sendJson(res, 200, { error: "اكتب وصف الصورة أولاً." });
      const dims = body.aspect === "9:16" ? [720, 1280] : body.aspect === "1:1" ? [1024, 1024] : [1280, 720];
      const imagePrompt = await translatePrompt(prompt);
      let bytes = null;
      let type = "image/jpeg";
      try {
        const ar = await fetch("https://apihub.agnes-ai.com/v1/images/generations", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGNES_API_KEY}` },
          body: JSON.stringify({ model: "agnes-image-2.1-flash", prompt: imagePrompt, size: `${dims[0]}x${dims[1]}` }),
          signal: AbortSignal.timeout(120000),
        });
        const aj = await ar.json().catch(() => null);
        const d = aj && aj.data && aj.data[0];
        if (ar.ok && d && d.b64_json) { bytes = Buffer.from(d.b64_json, "base64"); type = "image/png"; }
        else if (ar.ok && d && d.url) {
          const ir = await fetch(d.url, { signal: AbortSignal.timeout(60000) });
          if (ir.ok) { bytes = Buffer.from(await ir.arrayBuffer()); type = ir.headers.get("content-type") || "image/png"; }
        }
      } catch {}
      if (!bytes) {
        const imgRes = await fetch(`${POLLINATIONS_BASE}/image/${encodeURIComponent(imagePrompt)}?model=flux&width=${dims[0]}&height=${dims[1]}`, {
          headers: POLLINATIONS_API_KEY ? { Authorization: `Bearer ${POLLINATIONS_API_KEY}` } : {},
        });
        if (!imgRes.ok) return sendJson(res, 200, { error: "تعذر توليد الصورة الآن. حاول مجددًا." });
        type = imgRes.headers.get("content-type") || "image/jpeg";
        if (!type.includes("image")) return sendJson(res, 200, { error: "تعذر توليد الصورة الآن. حاول مجددًا." });
        bytes = Buffer.from(await imgRes.arrayBuffer());
      }
      const mediaId = "img-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      mediaStore.set(mediaId, { bytes, type });
      while (mediaStore.size > 5) mediaStore.delete(mediaStore.keys().next().value);
      return sendJson(res, 200, { url: "/api/media/" + encodeURIComponent(mediaId) });
    }
    if (req.method === "POST" && url.pathname === "/api/image-edit") {
      const body = await readBody(req);
      const prompt = String(body.prompt || "").trim().slice(0, 1000);
      const imageData = typeof body.imageData === "string" ? body.imageData : "";
      if (!prompt || !imageData) return sendJson(res, 200, { error: "ارفع صورة واكتب التعديل." });
      const m = imageData.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
      if (!m) return sendJson(res, 200, { error: "الصورة غير صالحة." });
      const srcId = "src-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      mediaStore.set(srcId, { bytes: Buffer.from(m[2], "base64"), type: m[1] });
      const host = req.headers.host || "video-site-8teq.onrender.com";
      const srcUrl = `https://${host}/api/media/${encodeURIComponent(srcId)}`;
      const imagePrompt = await translatePrompt(prompt);
      let bytes = null;
      let type = "image/jpeg";
      try {
        const ar = await fetch("https://apihub.agnes-ai.com/v1/images/generations", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGNES_API_KEY}` },
          body: JSON.stringify({ model: "agnes-image-2.1-flash", prompt: imagePrompt, size: "1K", image: [imageData], extra_body: { response_format: "url" } }),
          signal: AbortSignal.timeout(120000),
        });
        const aj = await ar.json().catch(() => null);
        const d = aj && aj.data && aj.data[0];
        if (ar.ok && d && d.b64_json) { bytes = Buffer.from(d.b64_json, "base64"); type = "image/png"; }
        else if (ar.ok && d && d.url) {
          const ir = await fetch(d.url, { signal: AbortSignal.timeout(60000) });
          if (ir.ok) { bytes = Buffer.from(await ir.arrayBuffer()); type = ir.headers.get("content-type") || "image/png"; }
        }
      } catch {}
      if (!bytes) {
        const imgRes = await fetch(`${POLLINATIONS_BASE}/image/${encodeURIComponent(imagePrompt)}?model=flux&image=${encodeURIComponent(srcUrl)}`, {
          headers: POLLINATIONS_API_KEY ? { Authorization: `Bearer ${POLLINATIONS_API_KEY}` } : {},
        });
        if (!imgRes.ok) return sendJson(res, 200, { error: "تعذر تعديل الصورة الآن. حاول مجددًا." });
        type = imgRes.headers.get("content-type") || "image/jpeg";
        if (!type.includes("image")) return sendJson(res, 200, { error: "تعذر تعديل الصورة الآن. حاول مجددًا." });
        bytes = Buffer.from(await imgRes.arrayBuffer());
      }
      const mediaId = "img-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      mediaStore.set(mediaId, { bytes, type });
      while (mediaStore.size > 8) mediaStore.delete(mediaStore.keys().next().value);
      return sendJson(res, 200, { url: "/api/media/" + encodeURIComponent(mediaId) });
    }
    if (req.method === "POST" && url.pathname === "/api/video") {
      if (!AGNES_API_KEY && !POLLINATIONS_API_KEY) return sendJson(res, 200, { error: "توليد الفيديو غير مهيأ. أضف مفتاح توليد إلى إعدادات الخادم." });
      const body = await readBody(req);
      const prompt = String(body.prompt || "").trim().slice(0, 1000);
      const imageData = typeof body.imageData === "string" ? body.imageData : "";
      if (!prompt && !imageData) return sendJson(res, 200, { error: "اكتب وصفاً أو ارفع صورة أولاً." });
      const aspect = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"].includes(body.aspect) ? body.aspect : "16:9";
      const secondsNum = Math.min(60, Math.max(4, parseInt(body.seconds, 10) || 5));
      const seconds = String(Math.min(12, secondsNum));
      if (imageData) {
        const m = imageData.match(/^data:image\/([a-z0-9.+-]+);base64,(.+)$/i);
        if (!m) return sendJson(res, 200, { error: "الصورة غير صالحة." });
        const ext = m[1].toLowerCase().replace("jpeg", "jpg");
        const bytes = Buffer.from(m[2], "base64");
        if (AGNES_API_KEY) {
          const uploadId = "imgup-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + "." + ext;
          mediaStore.set(uploadId, { bytes, type: "image/" + (ext === "jpg" ? "jpeg" : ext) });
          while (mediaStore.size > 8) mediaStore.delete(mediaStore.keys().next().value);
          const imageUrl = `https://${req.headers.host}/api/media/${encodeURIComponent(uploadId)}`;
          const agnesPrompt = prompt || "Animate this image naturally with gentle motion";
          const payloads = [
            { model: "agnes-video-v2.0", prompt: agnesPrompt, image: imageUrl, num_frames: 121, frame_rate: 24 },
            { model: "agnes-video-v2.0", prompt: agnesPrompt, image: imageData, num_frames: 121, frame_rate: 24 },
            { model: MODEL, prompt: agnesPrompt, image: imageUrl, size: "720P", aspect_ratio: aspect, seconds, n: 1 },
            { model: MODEL, prompt: agnesPrompt, image: imageData, size: "720P", aspect_ratio: aspect, seconds, n: 1 },
            { model: MODEL, prompt: agnesPrompt, mode: "ti2vid", image: imageUrl, num_frames: 121, frame_rate: 24 },
            { model: MODEL, prompt: agnesPrompt, extra_body: { image: [imageData] }, num_frames: 121, frame_rate: 24 },
          ];
          for (const payload of payloads) {
            try {
              const created = await agnes("/v1/videos", { method: "POST", body: JSON.stringify(payload) });
              const videoId = created?.video_id || created?.id || created?.task_id || created?.data?.video_id || created?.data?.id;
              if (videoId) return sendJson(res, 200, { videoId });
            } catch {}
          }
        }
        if (!MAGIC_HOUR_API_KEY) return sendJson(res, 200, { error: "تحريك الصور غير مهيأ حالياً." });
        const up = await magicHour("/v1/files/upload-urls", { method: "POST", body: JSON.stringify({ items: [{ type: "image", extension: ext }] }) });
        const item = up?.items?.[0];
        if (!item?.upload_url || !item?.file_path) return sendJson(res, 200, { error: "تعذر رفع الصورة." });
        const put = await fetch(item.upload_url, { method: "PUT", body: bytes });
        if (!put.ok) return sendJson(res, 200, { error: "تعذر رفع الصورة." });
        const mhBody = { end_seconds: secondsNum, assets: { image_file_path: item.file_path }, model: "ltx-2.5", resolution: "480p", audio: true };
        if (prompt) mhBody.style = { prompt };
        let mh;
        try {
          mh = await magicHour("/v1/image-to-video", { method: "POST", body: JSON.stringify(mhBody) });
        } catch (err) {
          const em = String(err?.message || err).toLowerCase();
          if (!(em.includes("402") || em.includes("credit") || em.includes("insufficient"))) throw err;
          mh = await magicHour("/v1/image-to-video", { method: "POST", body: JSON.stringify({ ...mhBody, end_seconds: 3 }) });
        }
        if (!mh?.id) return sendJson(res, 200, { error: "تعذر بدء التوليد." });
        return sendJson(res, 200, { videoId: "mh-" + mh.id });
      }
      let created = null;
      let lastErr = null;
      if (AGNES_API_KEY) {
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
            if (!m.includes("503") && !m.includes("429") && !m.includes("queue")) break;
            await new Promise((r) => setTimeout(r, 20000));
          }
        }
      }
      if (!created) {
        if (MAGIC_HOUR_API_KEY) {
          try {
            const mhAspect = ["16:9", "9:16", "1:1"].includes(aspect) ? aspect : "16:9";
            const mh = await magicHour("/v1/text-to-video", {
              method: "POST",
              body: JSON.stringify({ end_seconds: secondsNum, style: { prompt }, aspect_ratio: mhAspect, model: "ltx-2.5", resolution: "480p", audio: true }),
            });
            if (mh?.id) return sendJson(res, 200, { videoId: "mh-" + mh.id });
          } catch (err) {
            lastErr = err;
            const em = String(err?.message || err).toLowerCase();
            if ((em.includes("402") || em.includes("credit") || em.includes("insufficient")) && secondsNum > 3) {
              try {
                const mhAspect = ["16:9", "9:16", "1:1"].includes(aspect) ? aspect : "16:9";
                const mh = await magicHour("/v1/text-to-video", {
                  method: "POST",
                  body: JSON.stringify({ end_seconds: 3, style: { prompt }, aspect_ratio: mhAspect, model: "ltx-2.5", resolution: "480p", audio: true }),
                });
                if (mh?.id) return sendJson(res, 200, { videoId: "mh-" + mh.id });
              } catch (err2) {
                lastErr = err2;
              }
            }
          }
        }
        if (POLLINATIONS_API_KEY) {
          const mediaId = "polli-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
          mediaPending.add(mediaId);
          pollinationsVideo(prompt, aspect)
            .then((bytes) => {
              mediaStore.set(mediaId, bytes);
              while (mediaStore.size > 5) mediaStore.delete(mediaStore.keys().next().value);
            })
            .catch((err) => mediaErrors.set(mediaId, friendlyError(err)))
            .finally(() => mediaPending.delete(mediaId));
          return sendJson(res, 200, { videoId: mediaId });
        }
        throw lastErr || new Error("create failed");
      }
      const videoId = created?.video_id || created?.id || created?.data?.video_id;
      if (!videoId) return sendJson(res, 200, { error: "تعذر بدء التوليد." });
      return sendJson(res, 200, { videoId });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/media/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/media/".length));
      const entry = mediaStore.get(id);
      if (!entry) return sendJson(res, 404, { error: "not found" });
      const bytes = entry.bytes || entry;
      res.writeHead(200, { "Content-Type": entry.type || "video/mp4" });
      res.end(bytes);
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/video/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/video/".length));
      if (mediaStore.has(id)) return sendJson(res, 200, { url: "/api/media/" + encodeURIComponent(id) });
      if (mediaErrors.has(id)) return sendJson(res, 200, { error: mediaErrors.get(id) });
      if (mediaPending.has(id)) return sendJson(res, 200, { status: "pending" });
      if (id.startsWith("mh-")) {
        const st = await magicHour(`/v1/video-projects/${encodeURIComponent(id.slice(3))}`);
        const status = String(st?.status || "").toLowerCase();
        const dl = st?.downloads?.[0]?.url;
        if (status === "complete" && dl) return sendJson(res, 200, { url: dl });
        if (status === "error" || status === "canceled") return sendJson(res, 200, { error: "فشل التوليد. حاول مجددًا." });
        return sendJson(res, 200, { status: status || "pending" });
      }
      if (!AGNES_API_KEY) return sendJson(res, 200, { error: "توليد الفيديو غير مهيأ." });
      let st = null;
      for (const path of [`/agnesapi?video_id=${encodeURIComponent(id)}&model_name=${encodeURIComponent(MODEL)}`, `/agnesapi?video_id=${encodeURIComponent(id)}`, `/agnesapi?video_id=${encodeURIComponent(id)}&model_name=agnes-video-v2.0`]) {
        try { st = await agnes(path); break; } catch {}
      }
      if (!st) return sendJson(res, 200, { status: "pending" });
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
