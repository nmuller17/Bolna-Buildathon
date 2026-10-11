"use client";

import { useRef, useState } from "react";

type TranscribeResponse = {
  text?: string;
  error?: string;
  detail?: string;
};

type GlossResponse = {
  gloss?: string[];
  error?: string;
};

export default function P1TestPage() {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [transcript, setTranscript] = useState("");
  const [gloss, setGloss] = useState<string[]>([]);
  const [error, setError] = useState("");

  async function startRecording() {
    setError("");
    setTranscript("");
    setGloss([]);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        const audio = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        await transcribeAndClassify(audio);
      };

      recorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
      setStatus("Recording...");
    } catch (caught) {
      setStatus("Microphone blocked");
      setError(caught instanceof Error ? caught.message : "Could not access microphone.");
    }
  }

  function stopRecording() {
    if (!recorderRef.current || recorderRef.current.state === "inactive") return;
    recorderRef.current.stop();
    setIsRecording(false);
    setStatus("Sending audio to Whisper...");
  }

  async function transcribeAndClassify(audio: Blob) {
    const formData = new FormData();
    formData.append("audio", audio, "speech.webm");

    const transcribeResponse = await fetch("/api/transcribe", {
      method: "POST",
      body: formData,
    });
    const transcribeData = (await transcribeResponse.json().catch(() => ({}))) as TranscribeResponse;

    if (!transcribeResponse.ok || !transcribeData.text) {
      setStatus("Transcription failed");
      setError(transcribeData.detail || transcribeData.error || "Transcription failed.");
      return;
    }

    setTranscript(transcribeData.text);
    setStatus("Classifying intention...");
    await classifyText(transcribeData.text);
  }

  async function classifyText(text: string) {
    const response = await fetch("/api/gloss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = (await response.json().catch(() => ({}))) as GlossResponse;

    if (!response.ok || !data.gloss) {
      setStatus("Classification failed");
      setError(data.error || "Gloss classification failed.");
      return;
    }

    setGloss(data.gloss);
    setStatus("Done");
  }

  async function classifyTypedText(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const text = String(formData.get("text") || "").trim();
    if (!text) return;

    setError("");
    setTranscript(text);
    setGloss([]);
    setStatus("Classifying typed text...");
    await classifyText(text);
  }

  return (
    <main className="page">
      <section className="panel">
        <p className="kicker">P1 microphone test</p>
        <h1>Voice to Text to Gloss</h1>
        <p className="status">{status}</p>

        <button
          className={isRecording ? "record stop" : "record"}
          type="button"
          onClick={isRecording ? stopRecording : startRecording}
        >
          {isRecording ? "Stop recording" : "Start recording"}
        </button>

        <form onSubmit={classifyTypedText}>
          <input name="text" placeholder="Or type: Your room is 412" />
          <button type="submit">Classify</button>
        </form>

        {error ? <p className="error">{error}</p> : null}

        <div className="results">
          <section>
            <h2>Whisper text</h2>
            <p>{transcript || "No transcript yet"}</p>
          </section>
          <section>
            <h2>Gloss</h2>
            <p>{gloss.length ? gloss.join(" ") : "No gloss yet"}</p>
          </section>
        </div>
      </section>

      <style jsx>{`
        .page {
          min-height: 100vh;
          display: grid;
          place-items: center;
          padding: 24px;
          font-family: Arial, Helvetica, sans-serif;
          background: #f6f7f9;
          color: #17202a;
        }

        .panel {
          width: min(840px, 100%);
          padding: 24px;
          border: 1px solid #d7dce2;
          border-radius: 8px;
          background: #ffffff;
        }

        .kicker {
          margin: 0;
          font-size: 13px;
          font-weight: 700;
          text-transform: uppercase;
          color: #526070;
        }

        h1 {
          margin: 8px 0;
          font-size: 32px;
          line-height: 1.15;
        }

        .status {
          min-height: 24px;
          margin: 0 0 20px;
          color: #526070;
        }

        .record,
        form button {
          min-height: 44px;
          padding: 0 18px;
          border: 1px solid #2157d6;
          border-radius: 6px;
          background: #2157d6;
          color: #ffffff;
          font-size: 16px;
          font-weight: 700;
          cursor: pointer;
        }

        .record.stop {
          border-color: #b42318;
          background: #b42318;
        }

        form {
          display: grid;
          grid-template-columns: 1fr auto;
          gap: 10px;
          margin: 16px 0 18px;
        }

        input {
          min-height: 42px;
          padding: 0 12px;
          border: 1px solid #c8d0d9;
          border-radius: 6px;
          font-size: 16px;
        }

        form button {
          border-color: #8b98a7;
          background: #ffffff;
          color: #17202a;
          font-size: 15px;
        }

        .error {
          padding: 12px;
          border: 1px solid #f0b8b8;
          border-radius: 6px;
          background: #fff4f4;
          color: #8a1f1f;
        }

        .results {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
          gap: 12px;
        }

        .results section {
          min-height: 130px;
          padding: 16px;
          border: 1px solid #d7dce2;
          border-radius: 8px;
          background: #fbfcfd;
        }

        h2 {
          margin: 0 0 10px;
          font-size: 15px;
          color: #526070;
        }

        .results p {
          margin: 0;
          font-size: 24px;
          line-height: 1.25;
          overflow-wrap: anywhere;
        }

        @media (max-width: 560px) {
          form {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </main>
  );
}
