import { parseBook } from "./parsers.js";
import { saveBook, getBook, deleteBook, listBooks, savePosition, settings } from "./storage.js";
import { DeviceVoice, ElevenLabsVoice } from "./voices.js";

const $ = (sel) => document.querySelector(sel);
const SENTENCE_END = /[.!?…]["'”’)\]]*$/;

const state = {
  book: null,          // full book incl. sections
  section: 0,          // which chapter/page is on screen
  words: [],           // [{ el, para }] for the section on screen
  current: 0,          // index of the word being read (or where reading will start)
  playing: false,
  run: 0,              // bumps on every play/stop so stale callbacks are ignored
  followPausedUntil: 0,
};

const device = new DeviceVoice();
const eleven = new ElevenLabsVoice();
const engine = () => (settings.get("engine", "device") === "elevenlabs" ? eleven : device);

// ================================================================ library

async function renderLibrary() {
  const books = await listBooks();
  const list = $("#book-list");
  list.innerHTML = "";
  $("#empty").hidden = books.length > 0;
  for (const b of books) {
    const card = document.createElement("div");
    card.className = "book";
    card.setAttribute("role", "button");
    card.tabIndex = 0;
    card.innerHTML = `
      <div class="cover"></div>
      <div class="book-meta"><span></span><div class="bar"><i></i></div></div>
      <button class="del" aria-label="Remove book" title="Remove">✕</button>`;
    const cover = card.querySelector(".cover");
    cover.textContent = b.title;
    cover.style.background = coverColor(b.title);
    card.querySelector(".book-meta span").textContent =
      `${b.format.toUpperCase()} · ${Math.round((b.progress || 0) * 100)}% read`;
    card.querySelector(".bar i").style.width = `${(b.progress || 0) * 100}%`;
    card.onclick = () => openBook(b.id);
    card.onkeydown = (e) => e.key === "Enter" && openBook(b.id);
    card.querySelector(".del").onclick = async (e) => {
      e.stopPropagation();
      if (confirm(`Remove “${b.title}” from your library?`)) {
        await deleteBook(b.id);
        renderLibrary();
      }
    };
    list.append(card);
  }
}

function coverColor(title) {
  let h = 0;
  for (const c of title) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `linear-gradient(160deg, hsl(${h} 55% 45%), hsl(${(h + 40) % 360} 60% 30%))`;
}

async function importFiles(files) {
  const status = $("#import-status");
  for (const file of files) {
    status.hidden = false;
    status.textContent = `Opening “${file.name}”…`;
    try {
      const parsed = await parseBook(file, (p) => {
        status.textContent = `Opening “${file.name}”… ${Math.round(p * 100)}%`;
      });
      const book = {
        id: crypto.randomUUID?.() || String(Date.now() + Math.random()),
        title: parsed.title,
        format: file.name.split(".").pop().toLowerCase(),
        sections: parsed.sections,
        position: { section: 0, word: 0 },
        progress: 0,
        addedAt: Date.now(),
      };
      await saveBook(book);
      status.hidden = true;
      await renderLibrary();
      if (files.length === 1) openBook(book.id);
    } catch (err) {
      console.error(err);
      status.textContent = `Couldn't open “${file.name}”: ${err.message}`;
    }
  }
}

// ================================================================ reader

async function openBook(id) {
  const book = await getBook(id);
  if (!book) return;
  state.book = book;
  book.lastOpened = Date.now();
  $("#library").hidden = true;
  $("#reader").hidden = false;
  $("#book-title").textContent = book.title;
  document.title = book.title;
  const pos = book.position || { section: 0, word: 0 };
  showSection(Math.min(pos.section, book.sections.length - 1), pos.word);
  history.pushState({ reader: true }, "");
}

function closeBook() {
  stop();
  saveNow();
  state.book = null;
  $("#reader").hidden = true;
  $("#library").hidden = false;
  document.title = "Read Aloud";
  renderLibrary();
}

// Draws one chapter (EPUB) or page (PDF), wrapping every word in a span so it can be highlighted.
function showSection(index, startWord = 0) {
  const { book } = state;
  state.section = index;
  const section = book.sections[index];
  const page = $("#page");
  page.innerHTML = "";
  const words = [];
  const frag = document.createDocumentFragment();

  section.paragraphs.forEach((para, pi) => {
    const el = document.createElement(para.kind === "h" ? "h2" : "p");
    const tokens = para.text.split(" ");
    tokens.forEach((t, ti) => {
      if (!t) return;
      const span = document.createElement("span");
      span.className = "w";
      span.textContent = t;
      span.dataset.i = words.length;
      words.push({ el: span, para: pi, text: t });
      el.append(span);
      if (ti < tokens.length - 1) el.append(" ");
    });
    frag.append(el);
  });
  const end = document.createElement("div");
  end.className = "section-end";
  end.textContent = index < book.sections.length - 1 ? "· · ·" : "The end";
  frag.append(end);
  page.append(frag);

  state.words = words;
  $("#section-title").textContent = section.title;
  setCurrent(Math.min(startWord, Math.max(0, words.length - 1)), { scroll: "instant" });
  if (!startWord) page.scrollTop = 0;
  updateProgress();
}

let chunkEls = [];
function setCurrent(i, { scroll = "smooth", chunk } = {}) {
  const prev = state.words[state.current];
  prev?.el.classList.remove("current");
  state.current = i;
  const w = state.words[i];
  if (!w) return;
  w.el.classList.add("current");

  if (chunk) {
    chunkEls.forEach((el) => el.classList.remove("in-chunk"));
    chunkEls = state.words.slice(chunk.start, chunk.end).map((x) => x.el);
    chunkEls.forEach((el) => el.classList.add("in-chunk"));
  }

  if (scroll && settings.get("follow", true) && performance.now() > state.followPausedUntil) {
    const page = $("#page");
    const r = w.el.getBoundingClientRect();
    const pr = page.getBoundingClientRect();
    const top = r.top - pr.top;
    if (top < pr.height * 0.12 || top > pr.height * 0.62 || scroll === "instant") {
      page.scrollTo({ top: page.scrollTop + top - pr.height * 0.3, behavior: scroll === "instant" ? "auto" : "smooth" });
    }
  }
  queueSave();
}

function clearChunk() {
  chunkEls.forEach((el) => el.classList.remove("in-chunk"));
  chunkEls = [];
}

// A chunk is what we hand to the voice in one go: a sentence or two from one paragraph.
function buildChunk(start) {
  const { words } = state;
  const ai = engine() === eleven;
  const min = ai ? 250 : 40;
  const max = ai ? 700 : 220;
  let text = "";
  const offsets = [];
  let i = start;
  const para = words[start]?.para;
  while (i < words.length && words[i].para === para) {
    offsets.push(text ? text.length + 1 : 0);
    text += (text ? " " : "") + words[i].text;
    i++;
    const last = words[i - 1].text;
    if (SENTENCE_END.test(last) && text.length >= min) break;
    if (text.length >= max && /[,;:—–]$/.test(last)) break;
    if (text.length >= max * 1.5) break;
  }
  return { start, end: i, text, offsets };
}

function voiceOptions() {
  return {
    rate: settings.get("rate", 1),
    voiceName: settings.get("deviceVoice", ""),
    apiKey: settings.get("elevenKey", ""),
    voiceId: settings.get("elevenVoice", ""),
    modelId: settings.get("elevenModel", "eleven_flash_v2_5"),
  };
}

function play() {
  if (!state.book) return;
  const eng = engine();
  if (eng === eleven) {
    const o = voiceOptions();
    if (!o.apiKey || !o.voiceId) {
      toast("Add your ElevenLabs API key and pick a voice in Settings first.");
      openSettings();
      return;
    }
  } else if (!device.supported) {
    toast("This browser can't read aloud. Try Safari, Chrome or Edge.");
    return;
  }
  eng.unlock(); // must happen inside the tap on iPhone
  state.playing = true;
  const run = ++state.run;
  setPlayButton("playing");
  keepAwake(true);
  speakFrom(state.current, run);
}

function stop() {
  state.run++;
  state.playing = false;
  device.stop();
  eleven.stop();
  setPlayButton("paused");
  keepAwake(false);
}

function speakFrom(i, run) {
  if (run !== state.run) return;
  if (i >= state.words.length) {
    // Finished this chapter/page: move on to the next one.
    if (state.section < state.book.sections.length - 1) {
      showSection(state.section + 1, 0);
      return speakFrom(0, run);
    }
    stop();
    clearChunk();
    toast("Finished the book 🎉");
    return;
  }
  const chunk = buildChunk(i);
  const eng = engine();
  const opts = voiceOptions();
  if (eng === eleven) setPlayButton("loading");
  eng.speak(chunk, opts, {
    onWord: (k) => {
      if (run !== state.run) return;
      if (eng === eleven && k === 0) setPlayButton(eleven.audio.paused ? "loading" : "playing");
      else if (eng === eleven) setPlayButton("playing");
      setCurrent(chunk.start + k, { chunk });
    },
    onEnd: () => speakFrom(chunk.end, run),
    onError: (err) => {
      if (run !== state.run) return;
      console.error(err);
      stop();
      toast(err.message || "Something went wrong while reading.");
    },
  });
  // Get the next bit of audio ready so there's no gap.
  if (eng.prefetch && chunk.end < state.words.length) eng.prefetch(buildChunk(chunk.end), opts);
}

function jumpTo(i) {
  i = Math.max(0, Math.min(i, state.words.length - 1));
  if (state.playing) {
    const run = ++state.run;
    device.stop();
    eleven.stop();
    setCurrent(i);
    speakFrom(i, run);
  } else {
    clearChunk();
    setCurrent(i);
  }
}

function sentenceStart(i) {
  const { words } = state;
  while (i > 0 && words[i - 1].para === words[i].para && !SENTENCE_END.test(words[i - 1].text)) i--;
  return i;
}

function prevSentence() {
  let s = sentenceStart(state.current);
  if (state.current - s < 3 && s > 0) s = sentenceStart(s - 1);
  else if (s === 0 && state.current < 3 && state.section > 0) {
    // Jump back into the previous chapter/page.
    const wasPlaying = state.playing;
    stop();
    showSection(state.section - 1, 0);
    const last = sentenceStart(state.words.length - 1);
    setCurrent(last, { scroll: "instant" });
    if (wasPlaying) play();
    return;
  }
  jumpTo(s);
}

function nextSentence() {
  const { words } = state;
  let i = state.current;
  while (i < words.length - 1 && !SENTENCE_END.test(words[i].text) && words[i + 1].para === words[i].para) i++;
  if (i + 1 >= words.length && state.section < state.book.sections.length - 1) {
    const wasPlaying = state.playing;
    stop();
    showSection(state.section + 1, 0);
    if (wasPlaying) play();
    return;
  }
  jumpTo(i + 1);
}

function setPlayButton(mode) {
  const btn = $("#play");
  btn.classList.toggle("playing", mode === "playing");
  btn.classList.toggle("loading", mode === "loading");
  btn.setAttribute("aria-label", mode === "paused" ? "Play" : "Pause");
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = mode === "paused" ? "paused" : "playing";
}

function updateProgress() {
  const p = bookProgress();
  $("#progress-bar").style.width = `${p * 100}%`;
}

function bookProgress() {
  const { book, section, current, words } = state;
  if (!book) return 0;
  const within = words.length ? current / words.length : 0;
  return Math.min(1, (section + within) / book.sections.length);
}

let saveTimer;
function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 2500);
  if (state.current % 20 === 0) updateProgress();
}
function saveNow() {
  clearTimeout(saveTimer);
  if (!state.book) return;
  updateProgress();
  savePosition(state.book.id, { section: state.section, word: state.current }, bookProgress());
}

// Keep the screen on while listening (supported on most modern phones).
let wakeLock;
async function keepAwake(on) {
  try {
    if (on && "wakeLock" in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => (wakeLock = null));
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {}
}

// ================================================================ contents

function openToc() {
  const list = $("#toc-list");
  list.innerHTML = "";
  state.book.sections.forEach((s, i) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.textContent = s.title;
    if (i === state.section) b.className = "active";
    b.onclick = () => {
      const wasPlaying = state.playing;
      stop();
      clearChunk();
      showSection(i, 0);
      $("#toc").close();
      if (wasPlaying) play();
    };
    li.append(b);
    list.append(li);
  });
  $("#toc").showModal();
  list.querySelector(".active")?.scrollIntoView({ block: "center" });
}

// ================================================================ settings

function applyLook() {
  const root = document.documentElement;
  root.dataset.theme = settings.get("theme", matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  root.dataset.hl = settings.get("hl", "yellow");
  root.dataset.font = settings.get("font", "atkinson");
  root.style.setProperty("--font-size", settings.get("fontSize", 22) + "px");
  root.style.setProperty("--line-height", settings.get("lineHeight", 1.7));
  $("#page").classList.toggle("dim", settings.get("dim", false));
  document.querySelectorAll("#theme .sw").forEach((b) => b.classList.toggle("active", b.dataset.v === root.dataset.theme));
  document.querySelectorAll("#hl .sw").forEach((b) => b.classList.toggle("active", b.dataset.v === root.dataset.hl));
  const meta = document.querySelector('meta[name="theme-color"]');
  meta.content = getComputedStyle(root).getPropertyValue("--bg").trim();
}

function updateRateUI() {
  const r = settings.get("rate", 1);
  $("#rate").value = r;
  $("#rate-out").textContent = r.toFixed(1) + "×";
  $("#speed-btn").textContent = r.toFixed(1) + "×";
}

function updateEngineUI() {
  const eng = settings.get("engine", "device");
  document.querySelectorAll('input[name="engine"]').forEach((r) => (r.checked = r.value === eng));
  $("#device-settings").hidden = eng !== "device";
  $("#eleven-settings").hidden = eng !== "elevenlabs";
  let label = "Voice";
  if (eng === "device") label = (settings.get("deviceVoice", "") || "Voice").replace(/^(Microsoft|Google)\s+/, "").split(/[\s(]/)[0];
  else label = settings.get("elevenVoiceName", "AI voice");
  $("#voice-btn").textContent = label || "Voice";
}

function fillDeviceVoices() {
  const voices = device.listVoices();
  const sel = $("#device-voice");
  const saved = settings.get("deviceVoice", "");
  sel.innerHTML = "";
  if (!voices.length) {
    sel.innerHTML = `<option value="">Default voice</option>`;
    return;
  }
  for (const v of voices) {
    const o = document.createElement("option");
    o.value = v.name;
    o.textContent = `${v.name} (${v.lang})${v.localService === false ? " · online" : ""}`;
    sel.append(o);
  }
  if (saved && voices.some((v) => v.name === saved)) sel.value = saved;
  else {
    sel.value = voices[0].name;
    settings.set("deviceVoice", voices[0].name);
  }
  updateEngineUI();
}

function fillElevenVoices(voices) {
  const sel = $("#eleven-voice");
  const saved = settings.get("elevenVoice", "");
  sel.innerHTML = "";
  for (const v of voices) {
    const o = document.createElement("option");
    o.value = v.voice_id;
    o.textContent = (v.category === "cloned" ? "⭐ " : "") + v.name;
    sel.append(o);
  }
  if (saved && voices.some((v) => v.voice_id === saved)) sel.value = saved;
  else if (voices[0]) sel.value = voices[0].voice_id;
  settings.set("elevenVoices", voices.map(({ voice_id, name, category }) => ({ voice_id, name, category })));
  sel.dispatchEvent(new Event("change"));
}

function openSettings() {
  fillDeviceVoices();
  updateEngineUI();
  $("#settings").showModal();
}

function testVoice() {
  const sample = "Hello! This is how I will sound when I read your books to you.";
  const offsets = [];
  sample.split(" ").reduce((pos, w) => (offsets.push(pos), pos + w.length + 1), 0);
  const eng = engine();
  eng.unlock();
  stop();
  eng.speak({ text: sample, offsets }, voiceOptions(), {
    onWord: () => {},
    onEnd: () => {},
    onError: (e) => toast(e.message),
  });
}

// ---- voice cloning (records from the microphone, then uploads to ElevenLabs)
let recorder, recChunks = [], recBlob, recTimer;
async function toggleRecording() {
  const btn = $("#rec");
  if (recorder?.state === "recording") {
    recorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true } });
    recChunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(recTimer);
      btn.classList.remove("recording");
      btn.textContent = "● Record again";
      recBlob = new Blob(recChunks, { type: recorder.mimeType || "audio/webm" });
      const prev = $("#rec-preview");
      prev.src = URL.createObjectURL(recBlob);
      prev.hidden = false;
      $("#clone-save").disabled = false;
    };
    recorder.start();
    const started = Date.now();
    btn.classList.add("recording");
    btn.textContent = "■ Stop";
    $("#clone-save").disabled = true;
    recTimer = setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      $("#rec-time").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}${s < 60 ? " (aim for 1:00+)" : " ✓"}`;
    }, 500);
  } catch (err) {
    toast("Couldn't use the microphone: " + err.message);
  }
}

async function saveClone() {
  const key = settings.get("elevenKey", "");
  if (!key) return toast("Paste your ElevenLabs API key first.");
  if (!recBlob) return;
  const status = $("#clone-status");
  status.textContent = "Uploading and creating your voice… (this can take a little while)";
  $("#clone-save").disabled = true;
  try {
    const name = $("#clone-name").value.trim() || "My voice";
    const id = await ElevenLabsVoice.cloneVoice(key, name, recBlob);
    settings.set("elevenVoice", id);
    settings.set("elevenVoiceName", name);
    fillElevenVoices(await ElevenLabsVoice.listVoices(key));
    status.textContent = "Done! Your voice is selected. Press “Test voice” to hear it.";
  } catch (err) {
    status.textContent = "Couldn't create the voice: " + err.message;
    $("#clone-save").disabled = false;
  }
}

// ================================================================ misc

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 4000);
}

function bindEvents() {
  // Library
  $("#file-input").onchange = (e) => {
    importFiles([...e.target.files]);
    e.target.value = "";
  };
  const drop = $("#drop");
  drop.ondragover = (e) => (e.preventDefault(), drop.classList.add("over"));
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    importFiles([...e.dataTransfer.files]);
  };
  $("#lib-settings").onclick = openSettings;

  // Reader
  $("#back").onclick = () => history.back();
  window.addEventListener("popstate", () => state.book && closeBook());
  $("#play").onclick = () => (state.playing ? stop() : play());
  $("#prev").onclick = prevSentence;
  $("#next").onclick = nextSentence;
  $("#toc-btn").onclick = openToc;
  $("#settings-btn").onclick = openSettings;
  $("#voice-btn").onclick = openSettings;
  $("#speed-btn").onclick = () => {
    const steps = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
    const r = settings.get("rate", 1);
    const next = steps.find((s) => s > r + 0.01) ?? steps[0];
    setRate(next);
  };
  $("#page").addEventListener("click", (e) => {
    const w = e.target.closest(".w");
    if (!w || getSelection().toString()) return;
    state.followPausedUntil = 0;
    jumpTo(+w.dataset.i);
  });
  // If you scroll by hand, stop auto-scrolling for a few seconds so it doesn't fight you.
  for (const ev of ["wheel", "touchmove"]) {
    $("#page").addEventListener(ev, () => (state.followPausedUntil = performance.now() + 5000), { passive: true });
  }
  document.addEventListener("keydown", (e) => {
    if ($("#reader").hidden || e.target.closest("input, select, textarea, dialog")) return;
    if (e.code === "Space") (e.preventDefault(), state.playing ? stop() : play());
    if (e.key === "ArrowLeft") prevSentence();
    if (e.key === "ArrowRight") nextSentence();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") saveNow();
    else if (state.playing) keepAwake(true);
  });

  // Sheets
  document.querySelectorAll("dialog .close").forEach((b) => (b.onclick = () => b.closest("dialog").close()));
  document.querySelectorAll("dialog").forEach((d) =>
    d.addEventListener("click", (e) => {
      const r = d.getBoundingClientRect();
      const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      if (e.target === d && outside) d.close();
    })
  );

  // Settings
  document.querySelectorAll('input[name="engine"]').forEach((r) =>
    (r.onchange = () => {
      stop();
      settings.set("engine", r.value);
      updateEngineUI();
    })
  );
  $("#device-voice").onchange = (e) => {
    settings.set("deviceVoice", e.target.value);
    updateEngineUI();
    restartIfPlaying();
  };
  $("#test-voice").onclick = testVoice;
  $("#test-eleven").onclick = testVoice;
  $("#eleven-key").value = settings.get("elevenKey", "");
  $("#eleven-key").onchange = (e) => settings.set("elevenKey", e.target.value.trim());
  $("#eleven-model").value = settings.get("elevenModel", "eleven_flash_v2_5");
  $("#eleven-model").onchange = (e) => settings.set("elevenModel", e.target.value);
  $("#eleven-load").onclick = async () => {
    const key = $("#eleven-key").value.trim();
    settings.set("elevenKey", key);
    if (!key) return toast("Paste your ElevenLabs API key first.");
    try {
      $("#eleven-load").textContent = "Loading…";
      fillElevenVoices(await ElevenLabsVoice.listVoices(key));
      toast("Voices loaded.");
    } catch (err) {
      toast(err.message);
    } finally {
      $("#eleven-load").textContent = "Load my voices";
    }
  };
  $("#eleven-voice").onchange = (e) => {
    const opt = e.target.selectedOptions[0];
    settings.set("elevenVoice", e.target.value);
    settings.set("elevenVoiceName", opt?.textContent.replace("⭐ ", "") || "AI voice");
    updateEngineUI();
  };
  const savedEleven = settings.get("elevenVoices", null);
  if (savedEleven) fillElevenVoices(savedEleven);
  $("#rec").onclick = toggleRecording;
  $("#clone-save").onclick = saveClone;

  $("#rate").oninput = (e) => setRate(+e.target.value);
  $("#font-size").value = settings.get("fontSize", 22);
  $("#font-size").oninput = (e) => (settings.set("fontSize", +e.target.value), applyLook());
  $("#line-height").value = settings.get("lineHeight", 1.7);
  $("#line-height").oninput = (e) => (settings.set("lineHeight", +e.target.value), applyLook());
  $("#font").value = settings.get("font", "atkinson");
  $("#font").onchange = (e) => (settings.set("font", e.target.value), applyLook());
  document.querySelectorAll("#theme .sw").forEach((b) => (b.onclick = () => (settings.set("theme", b.dataset.v), applyLook())));
  document.querySelectorAll("#hl .sw").forEach((b) => (b.onclick = () => (settings.set("hl", b.dataset.v), applyLook())));
  $("#dim-others").checked = settings.get("dim", false);
  $("#dim-others").onchange = (e) => (settings.set("dim", e.target.checked), applyLook());
  $("#follow").checked = settings.get("follow", true);
  $("#follow").onchange = (e) => settings.set("follow", e.target.checked);

  // Lock-screen / headphone controls
  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("play", play);
    navigator.mediaSession.setActionHandler("pause", stop);
    navigator.mediaSession.setActionHandler("previoustrack", prevSentence);
    navigator.mediaSession.setActionHandler("nexttrack", nextSentence);
  }
}

let rateTimer;
function setRate(r) {
  settings.set("rate", Math.round(r * 100) / 100);
  updateRateUI();
  clearTimeout(rateTimer);
  rateTimer = setTimeout(restartIfPlaying, 300);
}

function restartIfPlaying() {
  if (!state.playing) return;
  stop();
  play();
}

// ================================================================ start

applyLook();
updateRateUI();
bindEvents();
fillDeviceVoices();
device.onVoicesChanged(fillDeviceVoices);
renderLibrary();

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
