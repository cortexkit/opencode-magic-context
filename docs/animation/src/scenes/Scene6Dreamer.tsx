import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import {
  COLORS,
  FONT_FAMILY,
  FONT_FAMILY_MONO,
  SCENE_6_DURATION,
  DREAMER_PILLS,
} from "../constants";
import { ContextBar } from "../components/ContextBar";
import { SceneCaption } from "../components/SceneCaption";
import { AgentPanel } from "../components/AgentPanel";

// Scene 6: Dreamer (1110-1230 frames, 4s)
// "Overnight, Dreamer cleans house."

export const Scene6Dreamer: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sceneStartFrame = 0;

  // Frame ranges
  const NIGHT_START = 10;
  const NIGHT_END = 30;
  const DREAMER_ENTER = 30;
  const DREAMER_EXIT = 100;
  const PILL_START = 50;
  const DAY_START = 90;
  const DAY_END = 110;

  // Night mode transition
  const nightProgress = interpolate(
    frame,
    [NIGHT_START, NIGHT_END],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const dayProgress = interpolate(
    frame,
    [DAY_START, DAY_END],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Background color: normal → night → normal
  const bgColor = frame < DAY_START
    ? interpolate(nightProgress, [0, 1], [10, 5], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
    : interpolate(dayProgress, [0, 1], [5, 10], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const background = `rgb(${Math.round(bgColor)}, ${Math.round(bgColor * 1.2)}, ${Math.round(bgColor * 2.4)})`;

  // Dreamer panel enter/exit
  const dreamerEnterP = spring({
    frame: frame - DREAMER_ENTER,
    fps,
    config: { damping: 200 },
  });
  const dreamerExitP = interpolate(
    frame,
    [DREAMER_EXIT - 20, DREAMER_EXIT],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Memory quality bar
  const memoryQualityStart = 60;
  const memoryQuality = interpolate(
    frame,
    [memoryQualityStart, memoryQualityStart + 40],
    [72, 91],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Panel position
  const panelLeft = (1280 - 400) / 2;
  const panelTop = 200;

  return (
    <AbsoluteFill style={{ background }}>
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
          Dreamer
        </div>
      </div>

      {/* Night indicator */}
      {frame >= NIGHT_START && frame < DAY_START && (
        <div
          style={{
            position: "absolute",
            top: 100,
            right: 100,
            display: "flex",
            alignItems: "center",
            gap: 8,
            opacity: nightProgress,
          }}
        >
          <span style={{ fontSize: 20 }}>☾</span>
          <span
            style={{
              fontFamily: FONT_FAMILY_MONO,
              fontSize: 14,
              color: COLORS.textSecondary,
            }}
          >
            2:00 AM
          </span>
        </div>
      )}

      {/* Dreamer panel */}
      {frame >= DREAMER_ENTER && frame < DREAMER_EXIT + 20 && (
        <div style={{ position: "absolute", left: panelLeft, top: panelTop }}>
          <AgentPanel
            type="dreamer"
            enterProgress={dreamerEnterP}
            exitProgress={dreamerExitP}
          >
            {/* Dreamer pills */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {DREAMER_PILLS.map((pill, i) => {
                const pillEnterFrame = PILL_START + i * 15;
                const pillEntered = spring({
                  frame: frame - pillEnterFrame,
                  fps,
                  config: { damping: 18, stiffness: 260 },
                });
                const pillOpacity = interpolate(pillEntered, [0, 0.5], [0, 1], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                });
                const pillTranslateX = interpolate(pillEntered, [0, 1], [-20, 0], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                });

                const pillColors: Record<string, string> = {
                  success: COLORS.contextGreen,
                  archive: COLORS.textMuted,
                };

                return (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      background: `${pillColors[pill.type]}15`,
                      border: `1px solid ${pillColors[pill.type]}30`,
                      borderRadius: 999,
                      padding: "6px 12px",
                      opacity: pillOpacity,
                      transform: `translateX(${pillTranslateX}px)`,
                    }}
                  >
                    <span style={{ fontSize: 11, color: pillColors[pill.type] }}>
                      {pill.icon}
                    </span>
                    <span
                      style={{
                        fontFamily: FONT_FAMILY,
                        fontSize: 10,
                        color: COLORS.textSecondary,
                      }}
                    >
                      {pill.text}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Memory quality bar */}
            <div style={{ marginTop: 16 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 6,
                }}
              >
                <span
                  style={{
                    fontFamily: FONT_FAMILY,
                    fontSize: 10,
                    color: COLORS.textMuted,
                  }}
                >
                  Memory quality
                </span>
                <span
                  style={{
                    fontFamily: FONT_FAMILY_MONO,
                    fontSize: 10,
                    color: COLORS.dreamerAccent,
                  }}
                >
                  {Math.round(memoryQuality)}%
                </span>
              </div>
              <div
                style={{
                  height: 4,
                  background: COLORS.panelBorder,
                  borderRadius: 999,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${memoryQuality}%`,
                    background: COLORS.dreamerAccent,
                    borderRadius: 999,
                    transition: "width 0.3s ease-out",
                  }}
                />
              </div>
            </div>
          </AgentPanel>
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
        <ContextBar pct={30} />
      </div>

      {/* Scene caption */}
      <SceneCaption
        text="Overnight maintenance while you sleep."
        frame={frame}
        sceneStartFrame={sceneStartFrame}
        sceneDuration={SCENE_6_DURATION}
      />
    </AbsoluteFill>
  );
};
