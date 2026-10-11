// SignBridge staff page only (features-plan F3, "On this laptop"): turns the receptionist's microphone
// into 16 kHz mono signed 16-bit PCM in 20 ms blocks, each with its loudness (RMS), for the energy gate
// in CaptionPanel.tsx. Runs inside the staff page's AudioWorklet; same-origin file (CSP script-src
// 'self'). It never sends anything anywhere: the page decides what goes to /api/staff/stt on 127.0.0.1.
class SbPcm16k extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.acc = 0; // fractional input position of the next output sample
    this.sum = 0; // running sum of input samples for the current output sample (box filter)
    this.n = 0;
    this.block = new Int16Array(320);
    this.fill = 0;
    this.energy = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input[0];
    for (let i = 0; i < ch.length; i++) {
      this.sum += ch[i];
      this.n++;
      this.acc += 1;
      if (this.acc >= this.ratio) {
        this.acc -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.sum / this.n));
        this.sum = 0;
        this.n = 0;
        this.energy += v * v;
        this.block[this.fill++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (this.fill === this.block.length) {
          const rms = Math.sqrt(this.energy / this.block.length);
          const out = this.block;
          this.port.postMessage({ pcm: out.buffer, rms }, [out.buffer]);
          this.block = new Int16Array(320);
          this.fill = 0;
          this.energy = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("sb-pcm-16k", SbPcm16k);
