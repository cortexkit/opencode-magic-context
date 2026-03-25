import { interpolate } from "remotion";
import { COLORS, FONT_FAMILY } from "../constants";

interface SceneCaptionProps {
  text: string;
  frame: number;
  sceneStartFrame: number;
  sceneDuration: number;
  fadeInDuration?: number;
  fadeOutDuration?: number;
}

export const SceneCaption: React.FC<SceneCaptionProps> = ({
  text,
  frame,
  sceneStartFrame,
  sceneDuration,
  fadeInDuration = 15,
  fadeOutDuration = 15,
}) => {
  const sceneEndFrame = sceneStartFrame + sceneDuration;

  // Fade in at start
  const fadeInProgress = interpolate(
    frame,
    [sceneStartFrame, sceneStartFrame + fadeInDuration],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Fade out at end
  const fadeOutProgress = interpolate(
    frame,
    [sceneEndFrame - fadeOutDuration, sceneEndFrame],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const opacity = Math.min(fadeInProgress, fadeOutProgress);

  return (
    <div
      style={{
        position: "absolute",
        bottom: 80,
        left: 40,
        fontFamily: FONT_FAMILY,
        fontSize: 18,
        fontWeight: 500,
        color: COLORS.textSecondary,
        opacity,
        letterSpacing: "0.02em",
      }}
    >
      {text}
    </div>
  );
};
