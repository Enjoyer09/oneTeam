export function fitEvidence(
  imageWidth: number,
  imageHeight: number,
  width: number,
  height: number,
) {
  if (imageWidth <= 0 || imageHeight <= 0 || width <= 0 || height <= 0)
    return { width: 0, height: 0 };
  const scale = Math.min(width / imageWidth, height / imageHeight);
  return { width: imageWidth * scale, height: imageHeight * scale };
}

