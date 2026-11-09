/**
 * Safe box for a procedural graphic inside a scene. The brand chrome (section label at the top, logo band at the bottom,
 * and the side padding) is drawn over the scene, so the graphic is laid out inside a box that clears those bands.
 * Pure: depends only on the format and the frame size, so the preview and the export compute the same box.
 *
 * Values match the chrome positions in scenes/Hooks.tsx Chrome: long pads 96px and the logo sits 44px from the bottom;
 * short pads 72px and the logo sits 190px from the bottom. The top band holds the section label and progress rail.
 */
export interface GraphicSafeBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function graphicSafeBox(format: 'long' | 'short', frameWidth: number, frameHeight: number): GraphicSafeBox {
  const side = format === 'long' ? 96 : 72;
  const top = 150;
  const bottom = format === 'long' ? 120 : 260;
  return {
    left: side,
    top,
    width: Math.max(1, frameWidth - 2 * side),
    height: Math.max(1, frameHeight - top - bottom),
  };
}
