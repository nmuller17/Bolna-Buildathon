// P4: hands-free microphone for the guest screen. Listens all the time, detects when someone starts and stops talking
// (energy-based voice activity detection with an adaptive noise floor) and hands each utterance over as a 16 kHz WAV.
// A short pre-roll is kept so the first word is never cut. No React here: see useHandsFreeSpeech.ts.

const BLOCK = 1024; // samples per analysis block (~21 ms at 48 kHz)
const PRE_ROLL_S = 0.4; // audio kept from before the speech onset
const ONSET_BLOCKS = 3; // loud blocks in a row that start an utterance (~60 ms)
const HANGOVER_S = 0.7; // silence that ends an utterance
const MIN_SPEECH_S = 0.35; // shorter utterances are ignored (coughs, door, clicks)
const MAX_UTTERANCE_S = 15;
const NOISE_ALPHA = 0.05; // how fast the noise floor follows the room
const SPEECH_RATIO = 3.5; // speech = this many times louder than the noise floor
const MIN_THRESHOLD = 0.01; // RMS, never trigger below this
const OUT_RATE = 16000;

// Collects audio in the audio thread and posts it in blocks of BLOCK samples.
const WORKLET = `
class SignbridgeTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(${BLOCK}); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === ${BLOCK}) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor("signbridge-tap", SignbridgeTap);
`;

export type ListenerEvents = {
  onSpeechStart?: () => void;
  /** An utterance ended: WAV (16 kHz mono) and its speech duration in seconds. Not called for ignored noises. */
  onUtterance?: (wav: Blob, seconds: number) => void;
  /** Speech that ended up too short to keep. */
  onDiscard?: () => void;
};

export class VoiceListener {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private preRoll: Float32Array[] = [];
  private utterance: Float32Array[] = [];
  private speaking = false;
  private loudRun = 0;
  private quietRun = 0;
  private speechBlocks = 0;
  private noise = MIN_THRESHOLD / SPEECH_RATIO;

  constructor(private readonly events: ListenerEvents) {}

  /** Opens the microphone. Throws if it is blocked. Check `running` afterwards: Chrome may need a click first. */
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.context = new AudioContext();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    await this.context.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    this.node = new AudioWorkletNode(this.context, "signbridge-tap");
    this.node.port.onmessage = (event: MessageEvent<Float32Array>) => this.block(event.data);
    this.context.createMediaStreamSource(this.stream).connect(this.node);
    await this.context.resume().catch(() => {});
  }

  /** False while Chrome keeps audio suspended until the page gets a click or a key press. */
  get running() {
    return this.context?.state === "running";
  }

  resume() {
    return this.context?.resume();
  }

  stop() {
    this.node?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.context?.close();
    this.node = null;
    this.stream = null;
    this.context = null;
  }

  private block(samples: Float32Array) {
    const rate = this.context?.sampleRate ?? 48000;
    const blockS = BLOCK / rate;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / samples.length);
    const loud = rms > Math.max(this.noise * SPEECH_RATIO, MIN_THRESHOLD);
    if (!this.speaking && !loud) this.noise += (rms - this.noise) * NOISE_ALPHA;

    if (!this.speaking) {
      this.preRoll.push(samples);
      while (this.preRoll.length * blockS > PRE_ROLL_S) this.preRoll.shift();
      this.loudRun = loud ? this.loudRun + 1 : 0;
      if (this.loudRun >= ONSET_BLOCKS) {
        this.speaking = true;
        this.utterance = [...this.preRoll];
        this.preRoll = [];
        this.speechBlocks = this.loudRun;
        this.quietRun = 0;
        this.events.onSpeechStart?.();
      }
      return;
    }

    this.utterance.push(samples);
    if (loud) {
      this.speechBlocks++;
      this.quietRun = 0;
    } else this.quietRun++;
    const ended = this.quietRun * blockS >= HANGOVER_S || this.utterance.length * blockS >= MAX_UTTERANCE_S;
    if (!ended) return;

    this.speaking = false;
    this.loudRun = 0;
    const speechS = this.speechBlocks * blockS;
    const audio = this.utterance;
    this.utterance = [];
    if (speechS < MIN_SPEECH_S) this.events.onDiscard?.();
    else this.events.onUtterance?.(encodeWav(resample(audio, rate, OUT_RATE), OUT_RATE), speechS);
  }
}

/** Joins the blocks and resamples them linearly to `to` Hz. */
function resample(blocks: Float32Array[], from: number, to: number) {
  const length = blocks.reduce((n, b) => n + b.length, 0);
  const input = new Float32Array(length);
  let o = 0;
  for (const b of blocks) {
    input.set(b, o);
    o += b.length;
  }
  const ratio = from / to;
  const out = new Float32Array(Math.floor(length / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, length - 1);
    out[i] = input[i0] + (input[i1] - input[i0]) * (x - i0);
  }
  return out;
}

/** 16-bit PCM mono WAV. */
function encodeWav(samples: Float32Array, rate: number) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, s: string) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}
