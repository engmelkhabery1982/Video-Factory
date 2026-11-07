/** Browser-only mask assembly. The API repeats this validation against actual asset bytes. */
export interface MaskRegionDraft { x: number; y: number; width: number; height: number }

export function makeMaskedCorrectionData(
  original: { width: number; height: number },
  region: MaskRegionDraft,
): string {
  const dimensions = [original.width, original.height, region.x, region.y, region.width, region.height];
  if (dimensions.some((value) => !Number.isSafeInteger(value))) throw new Error('Mask coordinates and dimensions must be integers.');
  if (original.width <= 0 || original.height <= 0) throw new Error('The original image dimensions are unavailable.');
  if (region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0) {
    throw new Error('Use non-negative x/y and a positive region width/height.');
  }
  if (region.x + region.width > original.width || region.y + region.height > original.height) {
    throw new Error(`The region must fit inside the original ${original.width}×${original.height} image.`);
  }
  // The descriptor is ASCII by contract, so browser btoa is deterministic and needs no Node Buffer.
  return btoa(JSON.stringify({
    version: 1,
    coordinateSpace: 'pixels',
    width: original.width,
    height: original.height,
    regions: [{ x: region.x, y: region.y, width: region.width, height: region.height }],
  }));
}

export function parseMaskInteger(value: string, label: string): number {
  if (!/^-?\d+$/.test(value.trim())) throw new Error(`${label} must be an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is outside the safe integer range.`);
  return parsed;
}
