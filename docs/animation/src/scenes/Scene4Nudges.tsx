import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import {
  COLORS,
  FONT_FAMILY,
  PANEL_W,
  PANEL_H,
  SCENE_4_DURATION,
  MESSAGE_STAGGER_FAST,
} from "../constants";
import { SkeletonMessage } from "../components/SkeletonMessage";
import { ContextBar } from "../components/ContextBar";
import { SceneCaption } from "../components/SceneCaption";
import { NudgeBanner } from "../components/NudgeBanner";
import { CommandChip } from "../components/CommandChip";

// Scene 4: Nudge Escalation (690-870 frames, 6s)
// "Progressive pressure, not surprise failures."

// Generate many messages for time-lapse effect
const NUDGE_MESSAGES = Array.from({ length: 20 }, (_, i) => ({
  id: i + 1,
  role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
  tag: i + 1,
  barWidth: 55 + Math.random() * 30,
}));

export const Scene4Nudges: React.FC = () => {
  const frame = useCurrentFrame();
  const sceneStartFrame = 0;

  // Frame ranges
  const NUDGE_55_ENTER = 30;
  const NUDGE_55_EXIT = 80;
  const NUDGE_65_ENTER = 80;
  const NUDGE_65_EXIT = 130;
  const NUDGE_80_ENTER = 130;
  const NUDGE_80_EXIT = 180;
  const COMMAND_ENTER = 160;

  // Calculate visible messages (fast stagger)
  const numVisible = NUDGE_MESSAGES.filter(
    (_, i) => frame >= i * MESSAGE_STAGGER_FAST
  ).length;

  // Context bar climbs: 30% → 55% → 65% → 80% → 40%
  let contextPct: number;
  if (frame < NUDGE_55_ENTER) {
    contextPct = 30;
  } else if (frame < NUDGE_65_ENTER) {
    contextPct = interpolate(frame, [NUDGE_55_ENTER, NUDGE_55_EXIT], [30, 55], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  } else if (frame < NUDGE_80_ENTER) {
    contextPct = interpolate(frame, [NUDGE_65_ENTER, NUDGE_65_EXIT], [55, 65], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  } else if (frame < COMMAND_ENTER) {
    contextPct = interpolate(frame, [NUDGE_80_ENTER, NUDGE_80_EXIT], [65, 80], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  } else {
    contextPct = interpolate(frame, [COMMAND_ENTER, COMMAND_ENTER + 30], [80, 40], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  }

  // Panel position
  const panelLeft = (1280 - PANEL_W) / 2;
  const panelTop = 100;

  return (
    <AbsoluteFill style={{ background: COLORS.bg }}>
      {/* Title */}
      <div
        style={{
          position: "absolute",
          top: 30,
          left: 0,
          right: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 4,
        }}
      >
        <div
          style={{
            fontFamily: FONT_FAMILY,
            fontSize: 11,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: COLORS.textMuted,
            fontWeight: 600,
          }}
        >
          magic-context
        </div>
        <div
          style={{
            fontFamily: FONT_FAMILY,
            fontSize: 20,
            fontWeight: 700,
            color: COLORS.textPrimary,
          }}
        >
          Nudge System
        </div>
      </div>

      {/* Nudge banners */}
      {frame >= NUDGE_55_ENTER && frame < NUDGE_55_EXIT && (
        <NudgeBanner
          level="gentle"
          pct={55}
          enterFrame={NUDGE_55_ENTER}
          exitFrame={NUDGE_55_EXIT}
        />
      )}
      {frame >= NUDGE_65_ENTER && frame < NUDGE_65_EXIT && (
        <NudgeBanner
          level="bolder"
          pct={65}
          enterFrame={NUDGE_65_ENTER}
          exitFrame={NUDGE_65_EXIT}
        />
      )}
      {frame >= NUDGE_80_ENTER && frame < NUDGE_80_EXIT && (
        <NudgeBanner
          level="critical"
          pct={80}
          enterFrame={NUDGE_80_ENTER}
          exitFrame={NUDGE_80_EXIT}
        />
      )}

      {/* Main panel */}
      <div
        style={{
          position: "absolute",
          left: panelLeft,
          top: panelTop,
          width: PANEL_W,
          height: PANEL_H,
          background: COLORS.panelBg,
          border: `1.5px solid ${COLORS.panelBorder}`,
          borderRadius: 16,
          boxShadow: "0 2px 20px rgba(0,0,0,0.3)",
          overflow: "hidden",
        }}
      >
        {/* Chrome bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            padding: "9px 12px",
            borderBottom: `1px solid ${COLORS.panelBorder}`,
            background: "#0f172a",
          }}
        >
          {["#ff5f57", "#ffbd2e", "#28c840"].map((c) => (
            <div key={c} style={{ width: 9, height: 9, borderRadius: "50%", background: c }} />
          ))}
          <span
            style={{
              fontFamily: FONT_FAMILY,
              fontSize: 10,
              color: COLORS.textMuted,
              marginLeft: 6,
            }}
          >
            active session
          </span>
        </div>

        {/* Message area */}
        <div style={{ padding: "18px 20px", overflow: "hidden" }}>
          {NUDGE_MESSAGES.slice(0, numVisible).map((msg, i) => (
            <SkeletonMessage
              key={msg.id}
              widthPercent={msg.barWidth}
              role={msg.role}
              enterFrame={i * MESSAGE_STAGGER_FAST}
              tag={msg.tag}
            />
          ))}
        </div>
      </div>

      {/* Command chip (AI response) */}
      {frame >= COMMAND_ENTER && (
        <div
          style={{
            position: "absolute",
            top: panelTop + PANEL_H - 60,
            left: panelLeft + 20,
          }}
        >
          <CommandChip
            command="ctx_reduce(...)"
            enterFrame={COMMAND_ENTER}
          />
        </div>
      )}

      {/* Context bar */}
      <div
        style={{
          position: "absolute",
          bottom: 42,
          left: "50%",
          transform: "translateX(-50%)",
        }}
      >
        <ContextBar pct={contextPct} />
      </div>

      {/* Scene caption */}
      <SceneCaption
        text="Escalating nudges before you hit the wall."
        frame={frame}
        sceneStartFrame={sceneStartFrame}
        sceneDuration={SCENE_4_DURATION}
      />
    </AbsoluteFill>
  );
};
