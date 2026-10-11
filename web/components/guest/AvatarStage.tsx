"use client";
// P4 (builder B): the guest's avatar area, through P2's public API only (mountAvatar, playGloss with
// onToken, and AvatarCaptions). Captions come first on the page; this sits under them.
// Without WebGL (or with the avatar switched off) it shows the gloss as key tags (CAP-4a).
// If the browser drops the WebGL context mid-session (GPU reset, memory pressure), the avatar box is
// hidden, the key tags take over and the guest can try the avatar again; captions never stop.
import { useEffect, useRef, useState } from "react";
import AvatarCaptions from "@/components/AvatarCaptions";
import { KeyTag } from "@/components/app/KeyTag";
import { AVATAR_DISCLAIMER, type GuestStaffUtterance } from "@/lib/app/types";
import s from "./guest.module.css";

type Player = typeof import("@/lib/avatar/player");

type Props = {
  caption: GuestStaffUtterance | null;
  /** Changes when the caption should be (re)played: a new caption or "Show again". */
  playKey: number;
  showAvatar: boolean;
  /** False in display-only Mode 0: no tappable controls at all (GST-15). */
  interactive: boolean;
};

export default function AvatarStage({ caption, playKey, showAvatar, interactive }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<Player | null>(null);
  const [webgl, setWebgl] = useState<boolean | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [showNames, setShowNames] = useState(false);
  /** True after the browser dropped the avatar's WebGL context; bumping mountKey mounts a fresh one. */
  const [lost, setLost] = useState(false);
  const [mountKey, setMountKey] = useState(0);
  const gloss = caption?.gloss ?? [];

  // Mount P2's avatar only when it is wanted; three.js loads lazily, on the client only.
  useEffect(() => {
    if (!showAvatar) return;
    let unmount: (() => void) | null = null;
    let cancelled = false;
    let detach: (() => void) | null = null;
    const onLost = () => {
      if (cancelled) return;
      setLost(true);
      setWebgl(false);
    };
    // The browser gave the context back: mount a fresh scene rather than trust the old one.
    const onRestored = () => {
      if (!cancelled) setMountKey((k) => k + 1);
    };
    import("@/lib/avatar/player")
      .then((player) => {
        if (cancelled || !boxRef.current) return;
        playerRef.current = player;
        const mount = player.mountAvatar(boxRef.current);
        unmount = mount.unmount;
        setWebgl(mount.webgl);
        const canvas = boxRef.current.querySelector("canvas");
        if (canvas) {
          canvas.addEventListener("webglcontextlost", onLost);
          canvas.addEventListener("webglcontextrestored", onRestored);
          detach = () => {
            canvas.removeEventListener("webglcontextlost", onLost);
            canvas.removeEventListener("webglcontextrestored", onRestored);
          };
        }
      })
      .catch(() => setWebgl(false));
    return () => {
      cancelled = true;
      detach?.();
      playerRef.current = null;
      unmount?.();
    };
  }, [showAvatar, mountKey]);

  const retryAvatar = () => {
    setLost(false);
    setWebgl(null);
    setMountKey((k) => k + 1);
  };

  // Play the caption's gloss; a newer call interrupts the older one inside playGloss.
  useEffect(() => {
    const player = playerRef.current;
    if (!player || !showAvatar || gloss.length === 0) return;
    let current = true;
    setActive(null);
    player
      .playGloss(gloss, { onToken: (i) => current && setActive(i) })
      .catch(() => {})
      .finally(() => current && setActive(null));
    return () => {
      current = false;
    };
    // gloss is derived from caption; playKey forces a replay of the same caption.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playKey, webgl, showAvatar]);

  // One tree for every state, so the avatar's container stays the same element and mounts once.
  if (!caption && !showAvatar) return null;
  const cardsOnly = !showAvatar || webgl === false;
  const hasGloss = gloss.length > 0;

  return (
    <section className={s.avatarArea} aria-label={caption ? "Sign language for the latest sentence" : undefined}>
      {showAvatar && <div ref={boxRef} className={s.avatarBox} aria-hidden="true" data-hidden={webgl === false} />}
      {caption && cardsOnly && hasGloss && (
        <div className={s.cards}>
          <p className={s.small}>Signs for this sentence:</p>
          <div className={s.tagRow}>
            {gloss.map((t, i) => (
              <KeyTag key={i} token={t} />
            ))}
          </div>
        </div>
      )}
      {caption && !hasGloss && <p className={s.small}>This sentence is shown as text only.</p>}
      {showAvatar && lost && (
        <p className={s.small} role="status">
          The signing avatar stopped on this screen. The signs are shown as words instead.{" "}
          {interactive && (
            <button type="button" className={s.linkButton} onClick={retryAvatar}>
              Try the avatar again
            </button>
          )}
        </p>
      )}
      {caption && showAvatar && webgl !== false && hasGloss && <p className={s.disclaimer}>{AVATAR_DISCLAIMER}</p>}
      {caption && !cardsOnly && hasGloss && interactive && (
        <div className={s.signNames}>
          <button type="button" className={s.linkButton} aria-expanded={showNames} onClick={() => setShowNames((v) => !v)}>
            {showNames ? "Hide sign names" : "Show sign names"}
          </button>
          {showNames && (
            <>
              <AvatarCaptions gloss={gloss} activeIndex={active} />
              <p className={s.small}>Key: fs = fingerspelled; eyebrows up = a yes/no question; eyebrows down = a question with what, where or how.</p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
