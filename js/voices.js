// Two ways to speak a chunk of text while reporting which word is being said:
//   DeviceVoice      – the voices built into the phone/computer (free, works offline)
//   ElevenLabsVoice  – very natural AI voices, including a clone of your own voice (needs an API key)
//
// Both take a "chunk" { text, offsets } where offsets[k] is the character index where word k starts,
// and call cb.onWord(k), cb.onEnd() or cb.onError(err).

const wordAt = (offsets, charIndex) => {
  let lo = 0, hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= charIndex) lo = mid;
    else hi = mid - 1;
  }
  return lo;
};

// ---------------------------------------------------------------- device voices

export class DeviceVoice {
  constructor() {
    this.synth = window.speechSynthesis;
    this.gen = 0;
  }

  get supported() {
    return !!this.synth;
  }

  // Best-sounding voices first: Apple "Premium/Enhanced", Microsoft "Natural", Google voices.
  listVoices() {
    if (!this.synth) return [];
    const lang = (navigator.language || "en").slice(0, 2);
    const score = (v) => {
      let s = 0;
      if (v.lang?.toLowerCase().startsWith(lang)) s += 100;
      if (/premium|natural|neural/i.test(v.name)) s += 40;
      if (/enhanced|siri/i.test(v.name)) s += 30;
      if (/google/i.test(v.name)) s += 20;
      if (/compact|eloquence|novelty|bells|bubbles|cellos|zarvox|whisper|bad news|good news|jester|organ|trinoids|boing|albert|superstar|wobble|grandma|grandpa|rocko|shelley|flo|reed|sandy/i.test(v.name)) s -= 60;
      return s;
    };
    return [...this.synth.getVoices()].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
  }

  onVoicesChanged(fn) {
    if (!this.synth) return;
    this.synth.addEventListener?.("voiceschanged", fn);
  }

  unlock() {}

  speak(chunk, { rate, voiceName }, cb) {
    const gen = ++this.gen;
    this.synth.cancel();
    clearInterval(this.timer);
    const live = () => gen === this.gen;

    const u = new SpeechSynthesisUtterance(chunk.text);
    const voice = this.synth.getVoices().find((v) => v.name === voiceName);
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    }
    u.rate = rate;
    this.utterance = u; // keep a reference so the browser doesn't garbage-collect it mid-sentence

    let gotBoundary = false;
    u.onboundary = (e) => {
      if (!live() || (e.name && e.name !== "word")) return;
      gotBoundary = true;
      clearInterval(this.timer);
      cb.onWord(wordAt(chunk.offsets, e.charIndex));
    };
    u.onstart = () => {
      if (!live()) return;
      cb.onWord(0);
      // Some voices (e.g. Google's online voices in Chrome) never report word positions.
      // In that case, estimate where we are from elapsed time so highlighting still moves.
      const started = performance.now();
      setTimeout(() => {
        if (!live() || gotBoundary) return;
        const weights = chunk.offsets.map((o, k) => (chunk.offsets[k + 1] ?? chunk.text.length + 1) - o + 1);
        const total = weights.reduce((a, b) => a + b, 0);
        const seconds = chunk.text.length / (14.5 * rate) + 0.2;
        this.timer = setInterval(() => {
          if (!live() || gotBoundary) return clearInterval(this.timer);
          const frac = (performance.now() - started) / 1000 / seconds;
          let acc = 0, k = 0;
          while (k < weights.length - 1 && (acc + weights[k]) / total < frac) acc += weights[k++];
          cb.onWord(k);
        }, 60);
      }, 450);
    };
    u.onend = () => {
      clearInterval(this.timer);
      if (live()) cb.onEnd();
    };
    u.onerror = (e) => {
      clearInterval(this.timer);
      if (!live() || e.error === "interrupted" || e.error === "canceled") return;
      cb.onError(new Error("Speech failed: " + e.error));
    };
    this.synth.speak(u);
  }

  stop() {
    this.gen++;
    clearInterval(this.timer);
    this.synth?.cancel();
  }
}

// ---------------------------------------------------------------- ElevenLabs

const API = "https://api.elevenlabs.io/v1";

// A very short silent WAV, played inside a tap so iPhones allow audio to start later.
function silentWavUrl() {
  const samples = 800;
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + samples * 2, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true);
  v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, samples * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

export class ElevenLabsVoice {
  constructor() {
    this.audio = new Audio();
    this.audio.preload = "auto";
    this.cache = new Map(); // text+voice -> Promise<{ url, times }>
    this.gen = 0;
  }

  static async listVoices(apiKey) {
    const res = await fetch(`${API}/voices`, { headers: { "xi-api-key": apiKey } });
    if (!res.ok) throw new Error(await errorText(res));
    const { voices } = await res.json();
    // Your own cloned voices first.
    return voices.sort((a, b) => (a.category === "cloned" ? -1 : 0) - (b.category === "cloned" ? -1 : 0));
  }

  static async cloneVoice(apiKey, name, recording) {
    const ext = recording.type.includes("mp4") ? "m4a" : recording.type.includes("ogg") ? "ogg" : "webm";
    const form = new FormData();
    form.append("name", name);
    form.append("files", recording, `my-voice.${ext}`);
    form.append("remove_background_noise", "true");
    form.append("description", "Cloned in Read Aloud");
    const res = await fetch(`${API}/voices/add`, { method: "POST", headers: { "xi-api-key": apiKey }, body: form });
    if (!res.ok) throw new Error(await errorText(res));
    return (await res.json()).voice_id;
  }

  // Call from inside a tap/click handler.
  unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    this.audio.src = silentWavUrl();
    this.audio.play().catch(() => {});
  }

  synthesize(chunk, { apiKey, voiceId, modelId }) {
    const key = `${voiceId}|${modelId}|${chunk.text}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const job = (async () => {
      const res = await fetch(`${API}/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ text: chunk.text, model_id: modelId }),
      });
      if (!res.ok) throw new Error(await errorText(res));
      const data = await res.json();
      const bytes = Uint8Array.from(atob(data.audio_base64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
      // alignment gives a start time for every character; take the time of each word's first letter.
      const starts = data.alignment?.character_start_times_seconds || [];
      const times = chunk.offsets.map((o) => starts[Math.min(o, starts.length - 1)] ?? 0);
      return { url, times };
    })();
    job.catch(() => this.cache.delete(key));
    this.cache.set(key, job);
    // Keep memory in check: forget the oldest clips.
    while (this.cache.size > 12) {
      const [oldKey, oldJob] = this.cache.entries().next().value;
      this.cache.delete(oldKey);
      oldJob.then((r) => URL.revokeObjectURL(r.url)).catch(() => {});
    }
    return job;
  }

  prefetch(chunk, opts) {
    if (chunk?.text) this.synthesize(chunk, opts).catch(() => {});
  }

  async speak(chunk, opts, cb) {
    const gen = ++this.gen;
    const live = () => gen === this.gen;
    cancelAnimationFrame(this.raf);
    this.audio.pause();
    cb.onWord(0);
    let clip;
    try {
      clip = await this.synthesize(chunk, opts);
    } catch (err) {
      if (live()) cb.onError(err);
      return;
    }
    if (!live()) return;
    const a = this.audio;
    a.src = clip.url;
    a.playbackRate = opts.rate;
    a.onended = () => {
      cancelAnimationFrame(this.raf);
      if (live()) cb.onEnd();
    };
    a.onerror = () => live() && cb.onError(new Error("Couldn't play the audio."));
    try {
      await a.play();
    } catch (err) {
      if (live()) cb.onError(err);
      return;
    }
    a.playbackRate = opts.rate; // some browsers reset this when the source changes
    let last = -1;
    const tick = () => {
      if (!live()) return;
      const t = a.currentTime;
      let k = 0;
      while (k < clip.times.length - 1 && clip.times[k + 1] <= t) k++;
      if (k !== last) cb.onWord((last = k));
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  stop() {
    this.gen++;
    cancelAnimationFrame(this.raf);
    this.audio.pause();
  }
}

async function errorText(res) {
  let detail = "";
  try {
    const j = await res.json();
    detail = j.detail?.message || j.detail?.status || (typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail));
  } catch {}
  if (res.status === 401) return "ElevenLabs rejected the API key. Check it in Settings. " + detail;
  return `ElevenLabs error ${res.status}. ${detail}`;
}
