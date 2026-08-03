export function calculateBlankPercentage(pixels, nearWhite = 245) {
  let blank = 0;
  const total = Math.floor(pixels.length / 4);
  for (let i = 0; i < total * 4; i += 4) {
    if (pixels[i + 3] < 12 || (pixels[i] >= nearWhite && pixels[i + 1] >= nearWhite && pixels[i + 2] >= nearWhite)) blank++;
  }
  return total ? blank / total * 100 : 100;
}
