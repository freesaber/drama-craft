import type { ShotCard } from "./types";

export interface CoverflowSlot {
  visible: boolean;
  interactive: boolean;
  translateXPercent: number;
  scale: number;
  zIndex: number;
  opacity: number;
  brightness: number;
}

/** Resolve a shot card's first-frame reference, falling back to Picture 1 if needed. */
export function firstFrameReference(card: ShotCard): string {
  const explicit = card.fields.frameFile.value.trim();
  if (explicit) return explicit;
  const firstInput = card.videoInputs.find(
    (item) =>
      item.kind === "image" &&
      (item.param === "ref_image_0" || /Picture\s*1\b/i.test(item.tag)),
  );
  return firstInput?.reference.trim() ?? "";
}

export function clampGalleryIndex(index: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(Math.max(0, Math.trunc(index)), total - 1);
}

export function stepGalleryIndex(
  index: number,
  delta: number,
  total: number,
): number {
  if (total <= 0) return 0;
  return clampGalleryIndex(index + delta, total);
}

const SIDE_STEPS: ReadonlyArray<{
  translateXPercent: number;
  scale: number;
  zIndex: number;
  opacity: number;
  brightness: number;
  interactive: boolean;
}> = [
  {
    translateXPercent: 0,
    scale: 1,
    zIndex: 10,
    opacity: 1,
    brightness: 1,
    interactive: true,
  },
  {
    translateXPercent: 40,
    scale: 0.8,
    zIndex: 8,
    opacity: 0.9,
    brightness: 0.86,
    interactive: true,
  },
  {
    translateXPercent: 67,
    scale: 0.64,
    zIndex: 6,
    opacity: 0.72,
    brightness: 0.74,
    interactive: true,
  },
  {
    translateXPercent: 86,
    scale: 0.5,
    zIndex: 4,
    opacity: 0.48,
    brightness: 0.62,
    interactive: true,
  },
  {
    translateXPercent: 102,
    scale: 0.38,
    zIndex: 2,
    opacity: 0,
    brightness: 0.5,
    interactive: false,
  },
];

/** Compute symmetric stacked-carousel transform values for a card offset from center. */
export function coverflowSlotStyle(offset: number): CoverflowSlot {
  const abs = Math.abs(offset);
  if (abs >= SIDE_STEPS.length) {
    return {
      visible: false,
      interactive: false,
      translateXPercent: Math.sign(offset) * 110,
      scale: 0.32,
      zIndex: 1,
      opacity: 0,
      brightness: 0.5,
    };
  }
  const step = SIDE_STEPS[abs];
  const sign = offset < 0 ? -1 : offset > 0 ? 1 : 0;
  return {
    visible: true,
    interactive: step.interactive,
    translateXPercent: sign * step.translateXPercent,
    scale: step.scale,
    zIndex: step.zIndex,
    opacity: step.opacity,
    brightness: step.brightness,
  };
}
