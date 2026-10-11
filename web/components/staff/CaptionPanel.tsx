"use client";
// P4 (builder S): live captions of the receptionist's speech (docs/features-plan.md F3).
//
// Backends, in order, with the one in use always named (the design of mcp-terra's audio_summary.py):
// 1. "On this laptop": the microphone goes through an AudioWorklet (16 kHz PCM, same-origin file) and an
//    energy gate (lib/app/sttsegment.ts) to POST /api/staff/stt on 127.0.0.1, which forwards it to
//    faster-whisper on 127.0.0.1. Nothing leaves the laptop.
// 2. "Cloud: OpenAI speech-to-text": one utterance at a time through P1's /api/transcribe, only when a
//    key is set and the profile allows cloud.
// 3. "Cloud: Google / Apple": the browser's own speech recognition (Web Speech API). It sends the audio to
//    the browser maker, so it starts only after the disclosure below is shown and accepted, and the
//    disclosure stays on screen while it runs. The guest's badge names the vendor too.
// 4. "Typed": quick replies and the text box, always there.
// If the local process stops, the server switches the badge to "Typed"; nothing here switches to a cloud
// backend by itself. The guest page has no microphone (AS-19): all of this is staff-only.
import { useCallback, useEffect, useRef, useState } from "react";
import { Segmenter, wavFromPcm, type SegmentOut } from "@/lib/app/sttsegment";
import {
  BROWSER_SPEECH_DISCLOSURE,
  CAPTION_BACKEND_IS_CLOUD,
  CAPTION_BACKEND_LABEL,
  LIVE_CAPTION_NOTE,
  type BrowserCaptionBackend,
  type CaptionBackend,
} from "@/lib/app/types";
import type { Desk } from "./useStaffDesk";
import s from "./staff.module.css";

/* ---------------- browser speech (opt-in) ---------------- */

type SpeechResultList = { length: number; [i: number]: { isFinal: boolean; 0: { transcript: string } } };
type SpeechRec = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: { resultIndex: number; results: SpeechResultList }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
};

function speechCtor(): (new () => SpeechRec) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Who receives the audio when this browser recognises speech (named on both screens). */
export function browserVendor(ua: string): { backend: BrowserCaptionBackend; vendor: string } {
  if (/Edg\//.test(ua)) return { backend: "browser_other", vendor: "the browser maker (Microsoft)" };
  if (/Chrome\//.test(ua) || /CriOS\//.test(ua)) return { backend: "browser_google", vendor: "Google" };
  if (/Safari\//.test(ua)) return { backend: "browser_apple", vendor: "Apple" };
  return { backend: "browser_other", vendor: "the browser maker" };
}

const randomId = (n = 8) => {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 16);
};

/* ---------------- local capture ---------------- */

type Capture = { ctx: AudioContext; stream: MediaStream; node: AudioWorkletNode; seg: Segmenter };

export default function CaptionPanel({ desk }: { desk: Desk }) {
  const { ui, staffAction } = desk;
  const st = ui.status?.captions;
  const live: CaptionBackend = st?.live ?? "typed";
  const active = ui.sessionState === "ACTIVE";
  const [listening, setListening] = useState<"off" | "starting" | "on">("off");
  const [note, setNote] = useState<string | null>(null);
  const [loud, setLoud] = useState(false);
  const [disclose, setDisclose] = useState<{ backend: BrowserCaptionBackend; vendor: string } | null>(null);
  const [browserOn, setBrowserOn] = useState<{ backend: BrowserCaptionBackend; vendor: string } | null>(null);
  const capRef = useRef<Capture | null>(null);
  const recRef = useRef<SpeechRec | null>(null);
  const wantBrowserRef = useRef(false);
  const inflightRef = useRef(false);
  const chainRef = useRef<Promise<unknown>>(Promise.resolve());
  const liveRef = useRef(live);
  liveRef.current = live;
  const activeRef = useRef(active);
  activeRef.current = active;
  const SR = typeof window !== "undefined" ? speechCtor() : null;

  /* ---- posting ---- */

  const postLocal = useCallback(async (o: SegmentOut) => {
    if (!activeRef.current || liveRef.current !== "local") return;
    const final = o.kind === "final";
    if (!final && inflightRef.current) return; // interim skipped while one is in flight
    const send = async () => {
      inflightRef.current = true;
      try {
        const res = await fetch("/api/staff/stt", {
          method: "POST",
          cache: "no-store",
          headers: {
            "Content-Type": "application/octet-stream",
            "x-stt-utterance": o.id,
            "x-stt-final": final ? "1" : "0",
            ...(o.kind === "final" ? { "x-stt-speech-end": String(Math.round(o.speechEnd)) } : {}),
          },
          body: o.pcm.buffer.slice(o.pcm.byteOffset, o.pcm.byteOffset + o.pcm.byteLength) as ArrayBuffer,
        });
        if (res.status === 409) setNote("Local captions are off. Type, or use a quick reply.");
        else if (res.status === 502 || res.status === 503) setNote("Local captions did not answer for that sentence. Type it if it mattered.");
        else if (res.ok) setNote(null);
      } catch {
        setNote("The desk server did not answer.");
      } finally {
        inflightRef.current = false;
      }
    };
    if (final) chainRef.current = chainRef.current.then(send, send);
    else await send();
  }, []);

  const postCloud = useCallback(
    async (o: SegmentOut) => {
      // One utterance at a time (OpenAI through P1's /api/transcribe), final only.
      if (o.kind !== "final" || !activeRef.current || liveRef.current !== "cloud_openai") return;
      const form = new FormData();
      form.append("audio", new Blob([wavFromPcm(o.pcm) as unknown as BlobPart], { type: "audio/wav" }), "speech.wav");
      try {
        const res = await fetch("/api/transcribe", { method: "POST", cache: "no-store", body: form });
        const data = (await res.json().catch(() => null)) as { text?: string } | null;
        if (res.ok && data?.text) await staffAction({ type: "live_caption", utteranceId: o.id, text: data.text.slice(0, 600), final: true, backend: "cloud_openai" });
        else setNote("OpenAI speech-to-text did not answer. Type instead.");
      } catch {
        setNote("OpenAI speech-to-text did not answer. Type instead.");
      }
    },
    [staffAction],
  );

  const stopListening = useCallback(() => {
    const c = capRef.current;
    capRef.current = null;
    if (c) {
      for (const o of c.seg.flush(Date.now())) void (liveRef.current === "cloud_openai" ? postCloud(o) : postLocal(o));
      c.node.port.onmessage = null;
      c.node.disconnect();
      c.stream.getTracks().forEach((t) => t.stop());
      void c.ctx.close().catch(() => {});
    }
    setListening("off");
    setLoud(false);
  }, [postLocal, postCloud]);

  const startListening = useCallback(async () => {
    if (capRef.current) return;
    setNote(null);
    setListening("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const ctx = new AudioContext();
      await ctx.audioWorklet.addModule("/stt/pcm-worklet.js");
      const src = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, "sb-pcm-16k");
      const seg = new Segmenter({ newId: () => `m${randomId()}` });
      // The worklet's output is not connected to the speakers: nothing is played back.
      src.connect(node);
      let t = Date.now();
      let blocks = 0;
      node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
        t += 20;
        // Re-align with the wall clock now and then (the audio clock and Date.now drift apart slowly).
        if (++blocks % 250 === 0) t = Date.now();
        for (const o of seg.push(new Int16Array(e.data.pcm), e.data.rms, t)) void (liveRef.current === "cloud_openai" ? postCloud(o) : postLocal(o));
        if (blocks % 50 === 0) setLoud(seg.loudLobby);
      };
      capRef.current = { ctx, stream, node, seg };
      setListening("on");
    } catch {
      setListening("off");
      setNote("The microphone could not start. Type instead, or use a quick reply.");
    }
  }, [postLocal, postCloud]);

  /* ---- browser speech ---- */

  const stopBrowser = useCallback(() => {
    wantBrowserRef.current = false;
    const r = recRef.current;
    recRef.current = null;
    if (r) {
      r.onend = null;
      r.onresult = null;
      try {
        r.abort();
      } catch {
        // already stopped
      }
    }
    setBrowserOn(null);
  }, []);

  const startBrowser = useCallback(
    (b: { backend: BrowserCaptionBackend; vendor: string }) => {
      if (!SR) return;
      stopListening();
      wantBrowserRef.current = true;
      let prefix = `b${randomId(6)}`;
      const lastPost = new Map<string, number>();
      const r = new SR();
      r.lang = "en-US";
      r.continuous = true;
      r.interimResults = true;
      r.onresult = (e) => {
        if (!activeRef.current || liveRef.current !== b.backend) return;
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i];
          const text = res[0].transcript.trim();
          if (!text) continue;
          const id = `${prefix}-${i}`;
          const now = Date.now();
          if (!res.isFinal && now - (lastPost.get(id) ?? 0) < 350) continue;
          lastPost.set(id, now);
          void staffAction({ type: "live_caption", utteranceId: id, text: text.slice(0, 600), final: res.isFinal, backend: b.backend });
        }
      };
      r.onerror = (e) => {
        if (e.error === "not-allowed" || e.error === "service-not-allowed") {
          setNote("This browser would not start speech recognition. Type instead.");
          stopBrowser();
        }
      };
      // Chrome ends recognition after a pause; restart while staff still want it (new ids each run).
      r.onend = () => {
        if (!wantBrowserRef.current) return;
        prefix = `b${randomId(6)}`;
        try {
          r.start();
        } catch {
          stopBrowser();
        }
      };
      recRef.current = r;
      try {
        r.start();
        setBrowserOn(b);
      } catch {
        setNote("This browser would not start speech recognition. Type instead.");
        stopBrowser();
      }
    },
    [SR, staffAction, stopBrowser, stopListening],
  );

  /* ---- backend choice ---- */

  const choose = async (b: CaptionBackend) => {
    setNote(null);
    if (b === "browser_google" || b === "browser_apple" || b === "browser_other") return; // via the disclosure
    stopBrowser();
    if (b !== "local" && b !== "cloud_openai") stopListening();
    const res = await staffAction({ type: "caption_backend", backend: b });
    if (res && !res.ok) setNote(res.message);
  };

  const confirmBrowser = async () => {
    const d = disclose;
    setDisclose(null);
    if (!d) return;
    const res = await staffAction({ type: "caption_backend", backend: d.backend });
    if (res && res.ok) startBrowser(d);
    else if (res && !res.ok) setNote(res.message);
  };

  // The server decides what is live. If it is no longer what this page is feeding, stop feeding it.
  useEffect(() => {
    if (live !== "local" && live !== "cloud_openai" && capRef.current) {
      stopListening();
      if (live === "typed") setNote("Local captions are off. Captions are typed now.");
    }
    if (browserOn && live !== browserOn.backend) stopBrowser();
  }, [live, browserOn, stopListening, stopBrowser]);

  useEffect(() => () => {
    stopListening();
    stopBrowser();
  }, [stopListening, stopBrowser]);

  const vendorHere = typeof navigator !== "undefined" ? browserVendor(navigator.userAgent) : null;
  const cloud = CAPTION_BACKEND_IS_CLOUD[live];
  const lat = st?.localDecodeMs;
  const end = st?.speechEndToFinalMs;
  const fmt = (v: number | null | undefined) => (v === null || v === undefined ? "no data yet" : `${(v / 1000).toFixed(2)} s`);
  const lines = ui.liveCaptions.slice(-4);

  return (
    <section className={s.captionPanel} aria-labelledby="captions-title">
      <h3 className={s.subTitle} id="captions-title">
        Live captions of your speech
      </h3>
      <p className={s.captionBadge} data-cloud={cloud || undefined} role="status">
        Captions: <strong>{CAPTION_BACKEND_LABEL[live]}</strong>
        {st?.local !== "up" && <span className={s.captionOff}> Local captions are off{st?.local === "off" ? " (not set up on this laptop)" : ""}.</span>}
      </p>

      <fieldset className={s.captionChoices}>
        <legend className={s.hint}>Caption service</legend>
        <label>
          <input type="radio" name="cap-backend" checked={live === "local"} disabled={st?.local !== "up"} onChange={() => void choose("local")} /> {CAPTION_BACKEND_LABEL.local}
        </label>
        {st?.cloudOpenaiAvailable && (
          <label>
            <input type="radio" name="cap-backend" checked={live === "cloud_openai"} onChange={() => void choose("cloud_openai")} /> {CAPTION_BACKEND_LABEL.cloud_openai}
          </label>
        )}
        {st?.browserAllowed && SR && vendorHere && (
          <label>
            <input
              type="radio"
              name="cap-backend"
              checked={live === vendorHere.backend}
              onChange={() => {
                stopListening();
                setDisclose(vendorHere);
              }}
            />{" "}
            {CAPTION_BACKEND_LABEL[vendorHere.backend]}
          </label>
        )}
        <label>
          <input type="radio" name="cap-backend" checked={live === "typed"} onChange={() => void choose("typed")} /> {CAPTION_BACKEND_LABEL.typed} (no speech recognition)
        </label>
      </fieldset>

      {disclose && (
        <div className={s.disclosure} role="alertdialog" aria-labelledby="disclose-text">
          <p id="disclose-text">{BROWSER_SPEECH_DISCLOSURE.replace("{vendor}", disclose.vendor)}</p>
          <div className={s.row}>
            <button type="button" className={s.primary} onClick={() => void confirmBrowser()}>
              Send my voice to {disclose.vendor}
            </button>
            <button type="button" className={s.secondary} onClick={() => setDisclose(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {browserOn && live === browserOn.backend && (
        <div className={s.disclosure} role="status">
          <p>{BROWSER_SPEECH_DISCLOSURE.replace("{vendor}", browserOn.vendor)}</p>
          <button type="button" className={s.secondary} onClick={() => void choose(st?.local === "up" ? "local" : "typed")}>
            Stop browser speech
          </button>
        </div>
      )}

      {(live === "local" || live === "cloud_openai") && (
        <div className={s.row}>
          <button
            type="button"
            className={listening === "on" ? s.secondary : s.primary}
            disabled={!active || listening === "starting"}
            aria-pressed={listening === "on"}
            onClick={() => (listening === "on" ? stopListening() : void startListening())}
          >
            {listening === "on" ? "Stop listening" : listening === "starting" ? "Starting the microphone…" : "Start listening"}
          </button>
          {listening === "on" && <span className={s.hint}>Listening. Speak normally; words appear on the guest screen as you talk.</span>}
        </div>
      )}
      {!active && <p className={s.hint}>Captions start once a guest window is connected.</p>}
      {loud && listening === "on" && <p className={s.hint}>The lobby is loud: captions may miss words. Type room numbers and times.</p>}
      {note && (
        <p className={s.hint} role="status">
          {note}
        </p>
      )}

      {lines.length > 0 && (
        <ol className={s.captionMirror} aria-label="What the guest sees (live captions)">
          {lines.map((c) => (
            <li key={c.utteranceId} data-final={c.final || undefined} data-retracted={c.retracted || undefined}>
              <span className={s.captionText}>
                {c.words.length
                  ? c.words.map((w, i) => (
                      <span key={i} className={w.unsure ? s.unsureWord : undefined}>
                        {w.w}{" "}
                      </span>
                    ))
                  : c.text}
              </span>
              <span className={s.hint}>
                {c.retracted ? "Removed from the guest screen" : c.final ? "Staff speech, machine captions" : "still listening…"}
                {c.decodeMs !== null && `, recognised in ${(c.decodeMs / 1000).toFixed(2)} s`}
              </span>
              {!c.retracted && (
                <button type="button" className={s.small} onClick={() => void staffAction({ type: "retract_caption", utteranceId: c.utteranceId })}>
                  Remove from guest screen
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
      <p className={s.hint}>
        {LIVE_CAPTION_NOTE} Facts like the room number go in the Facts panel, never through captions.
        {st?.local === "up" && ` Local recognition: median ${fmt(lat?.median)}, last ${fmt(lat?.last)}; end of speech to caption: median ${fmt(end?.median)}, last ${fmt(end?.last)} (measured).`}
      </p>
    </section>
  );
}
