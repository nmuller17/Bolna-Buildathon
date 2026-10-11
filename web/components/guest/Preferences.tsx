"use client";
// Guest preferences (docs/features-plan.md F5 and F10). Held in this page's memory only (AS-3): never
// localStorage, sessionStorage, IndexedDB, cookies or a service worker, and gone when the
// conversation ends. Only what the desk must know (reading aloud, avatar on or off) goes to the
// server, through the existing "prefs" action. Avatar speed is roadmap (it needs a rate option in P2).
import { SIGN_LANGUAGES, type GuestPrefs } from "@/lib/app/types";
import type { Session } from "./common";
import s from "./guest.module.css";

export const DEFAULT_PREFS: GuestPrefs = {
  textSize: 0,
  avatarSize: "medium",
  captionsOnly: false,
  alertFlash: true,
  alertVibrate: true,
  interpreterFirst: false,
  signLanguage: "ase",
};

const TEXT_SIZE_WORDS: Record<GuestPrefs["textSize"], string> = { 0: "Standard", 1: "Large", 2: "Largest" };
const AVATAR_SIZE_WORDS: Record<GuestPrefs["avatarSize"], string> = { small: "Small", medium: "Medium", large: "Large" };

export default function Preferences(props: { session: Session; prefs: GuestPrefs; setPrefs: (p: GuestPrefs) => void }) {
  const { session, prefs, setPrefs } = props;
  const { ui, act } = session;
  const set = <K extends keyof GuestPrefs>(k: K, v: GuestPrefs[K]) => setPrefs({ ...prefs, [k]: v });
  const textOnly = ui.settings.guestMode === "text_only";

  return (
    <div className={s.prefs}>
      <p className={s.subTitle} id="pref-text">
        Text size
      </p>
      <div className={s.buttonRow} role="group" aria-labelledby="pref-text">
        {([0, 1, 2] as const).map((n) => (
          <button key={n} type="button" className={s.secondary} aria-pressed={prefs.textSize === n} onClick={() => set("textSize", n)}>
            {TEXT_SIZE_WORDS[n]}
          </button>
        ))}
      </div>

      {!textOnly && (
        <>
          <p className={s.subTitle} id="pref-avatar">
            Avatar size
          </p>
          <div className={s.buttonRow} role="group" aria-labelledby="pref-avatar">
            {(["small", "medium", "large"] as const).map((n) => (
              <button key={n} type="button" className={s.secondary} aria-pressed={prefs.avatarSize === n} disabled={!ui.settings.showAvatar} onClick={() => set("avatarSize", n)}>
                {AVATAR_SIZE_WORDS[n]}
              </button>
            ))}
          </div>
          <label className={s.check}>
            <input type="checkbox" checked={!ui.settings.showAvatar} onChange={(e) => void act({ type: "prefs", showAvatar: !e.target.checked })} />
            <span>
              Captions only <span className={s.muted}>(no avatar)</span>
            </span>
          </label>
        </>
      )}

      <label className={s.check}>
        <input type="checkbox" checked={ui.settings.speakAloud} onChange={(e) => void act({ type: "prefs", speakAloud: e.target.checked })} />
        <span>
          Read my sentences aloud at the desk. <span className={s.muted}>People nearby will hear it.</span>
        </span>
      </label>

      <p className={s.subTitle}>Alerts from the desk</p>
      <label className={s.check}>
        <input type="checkbox" checked={prefs.alertFlash} onChange={(e) => set("alertFlash", e.target.checked)} />
        <span>Flash the screen once</span>
      </label>
      <label className={s.check}>
        <input type="checkbox" checked={prefs.alertVibrate} onChange={(e) => set("alertVibrate", e.target.checked)} />
        <span>
          Vibrate <span className={s.muted}>(only on devices that can)</span>
        </span>
      </label>

      <label className={s.check}>
        <input type="checkbox" checked={prefs.interpreterFirst} onChange={(e) => set("interpreterFirst", e.target.checked)} />
        <span>Show &ldquo;Talk to an interpreter&rdquo; first</span>
      </label>

      <div className={s.field}>
        <label htmlFor="pref-lang">My sign language</label>
        <select id="pref-lang" className={s.select} value={prefs.signLanguage} onChange={(e) => set("signLanguage", e.target.value as GuestPrefs["signLanguage"])}>
          {SIGN_LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.name}
            </option>
          ))}
        </select>
        <p className={s.small}>Kept on this screen only. The desk sees it only if you share it on the interpreter card.</p>
      </div>
      <p className={s.small}>These settings stay on this screen and are erased when the conversation ends.</p>
    </div>
  );
}
