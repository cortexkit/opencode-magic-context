import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import {
  COLORS,
  FONT_FAMILY,
  FONT_FAMILY_MONO,
  PANEL_W,
  PANEL_H,
  SCENE_7_DURATION,
} from "../constants";
import { ContextBar } from "../components/ContextBar";

// Scene 7: Resolution (1230-1350 frames, 4s)
// "Keep the plot. Lose the bloat." — Final lockup

export const Scene7Resolution: React.FC = () => {
  const frame = useCurrentFrame();
  const sceneStartFrame = 0;

  // Frame ranges
  const HOLD_START = 0;
  const DISSOLVE_START = 60;
  const LOCKUP_START = 90;

  // Clean session view hold
  const holdOpacity = interpolate(
    frame,
    [DISSOLVE_START, DISSOLVE_START + 20],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Lockup fade in
  const lockupOpacity = interpolate(
    frame,
    [LOCKUP_START, LOCKUP_START + 15],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Panel position
  const panelLeft = (1280 - PANEL_W) / 2;
  const panelTop = 100;

  return (
    <AbsoluteFill style={{ background: COLORS.bg }}>
      {/* Clean session view (dissolves toward center) */}
      <div style={{ opacity: holdOpacity }}>
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
            Resolution
          </div>
        </div>

        {/* Main panel (simplified clean view) */}
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

          {/* Clean message area */}
          <div style={{ padding: "18px 20px", overflow: "hidden" }}>
            {/* Compartment card */}
            <div
              style={{
                background: COLORS.compartmentBg,
                border: `1.5px solid ${COLORS.compartmentBorder}`,
                borderLeft: `4px solid ${COLORS.compartmentAccent}`,
                borderRadius: 10,
                padding: "10px 14px",
                marginBottom: 10,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 7,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 12 }}>📦</span>
                  <span
                    style={{
                      fontFamily: FONT_FAMILY,
                      fontWeight: 700,
                      fontSize: 12,
                      color: COLORS.compartmentAccent,
                    }}
                  >
                    Compartment
                  </span>
                </div>
                <span
                  style={{
                    fontFamily: FONT_FAMILY_MONO,
                    fontSize: 9,
                    color: COLORS.compartmentAccent,
                    background: "rgba(16,185,129,0.12)",
                    padding: "2px 7px",
                    borderRadius: 999,
                  }}
                >
                  §1§–§5§
                </span>
              </div>
              <div
                style={{
                  fontFamily: FONT_FAMILY,
                  fontSize: 9,
                  color: COLORS.textMuted,
                }}
              >
                5 messages · compressed by historian
              </div>
            </div>

            {/* Recent messages with tags */}
            {[
              { w: 62, role: "user" as const, tag: 6 },
              { w: 88, role: "assistant" as const, tag: 7 },
              { w: 70, role: "user" as const, tag: 8 },
            ].map((msg, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: msg.role === "user" ? "flex-end" : "flex-start",
                  marginBottom: 8,
                  gap: 8,
                }}
              >
                {msg.role === "assistant" && (
                  <span
                    style={{
                      fontFamily: FONT_FAMILY_MONO,
                      fontSize: 9,
                      color: COLORS.tagColor,
                      background: COLORS.tagBg,
                      padding: "2px 6px",
                      borderRadius: 4,
                    }}
                  >
                    §{msg.tag}§
                  </span>
                )}
                <div
                  style={{
                    width: `${msg.w}%`,
                    height: 36,
                    borderRadius: 8,
                    background: msg.role === "user" ? COLORS.userBar : COLORS.assistantBar,
                  }}
                />
                {msg.role === "user" && (
                  <span
                    style={{
                      fontFamily: FONT_FAMILY_MONO,
                      fontSize: 9,
                      color: COLORS.tagColor,
                      background: COLORS.tagBg,
                      padding: "2px 6px",
                      borderRadius: 4,
                    }}
                  >
                    §{msg.tag}§
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Context bar */}
        <div
          style={{
            position: "absolute",
            bottom: 42,
            left: "50%",
            transform: "translateX(-50%)",
          }}
        >
          <ContextBar pct={30} />
        </div>
      </div>

      {/* Final lockup */}
      {frame >= LOCKUP_START && (
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            opacity: lockupOpacity,
            textAlign: "center",
          }}
        >
          <div
            style={{
              fontFamily: FONT_FAMILY_MONO,
              fontSize: 48,
              fontWeight: 700,
              color: COLORS.textPrimary,
              letterSpacing: "0.05em",
              marginBottom: 16,
            }}
          >
            magic-context
          </div>
          <div
            style={{
              width: 400,
              height: 1,
              background: COLORS.panelBorder,
              margin: "0 auto 16px",
            }}
          />
          <div
            style={{
              fontFamily: FONT_FAMILY,
              fontSize: 20,
              color: COLORS.textSecondary,
              marginBottom: 32,
            }}
          >
            Keep the plot. Lose the bloat.
          </div>
          <div
            style={{
              fontFamily: FONT_FAMILY_MONO,
              fontSize: 14,
              color: COLORS.textMuted,
              background: COLORS.panelBg,
              border: `1px solid ${COLORS.panelBorder}`,
              borderRadius: 6,
              padding: "10px 16px",
              display: "inline-block",
            }}
          >
            npm install @cortexkit/magic-context-opencode
          </div>
        </div>
      )}
    </AbsoluteFill>
  );
};
