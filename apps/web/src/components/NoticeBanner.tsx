import { useRef, useState } from "react";
import { dismissBanner, holdBanner, useBanner } from "../lib/banner.js";
import { openNotice } from "../lib/notify.js";
import { NoticeCard } from "./NoticeCard.js";

/**
 * The app's own notice on a phone or in a tab, at the top while the app is
 * on screen (noticePrefs `shownBy: "app"`). A tap opens it, a swipe up puts
 * it away, a finger resting on it keeps it.
 */
export function NoticeBanner() {
  const banner = useBanner();
  const [lift, setLift] = useState(0);
  const start = useRef<number | null>(null);
  // Kept past the finger lifting: the click that follows a swipe is not a tap.
  const moved = useRef(false);
  if (!banner) return null;
  const { notice } = banner;
  return (
    <div
      key={banner.id}
      className="notice-banner"
      style={lift ? { transform: `translateY(${lift}px)`, opacity: Math.max(0.2, 1 + lift / 80) } : undefined}
      onPointerDown={(e) => {
        start.current = e.clientY;
        moved.current = false;
        holdBanner(true);
      }}
      onPointerMove={(e) => {
        if (start.current === null) return;
        const dy = Math.min(0, e.clientY - start.current);
        if (dy < -6) moved.current = true;
        setLift(dy);
      }}
      onPointerUp={() => {
        const away = lift < -32;
        start.current = null;
        setLift(0);
        if (away) dismissBanner();
        else holdBanner(false);
      }}
      onPointerCancel={() => {
        start.current = null;
        setLift(0);
        holdBanner(false);
      }}
    >
      <NoticeCard
        title={notice.title}
        body={notice.body}
        face={notice.face}
        onOpen={() => {
          if (moved.current) return;
          openNotice(notice.tag);
        }}
      />
      <span className="notice-grip" aria-hidden="true" />
    </div>
  );
}
