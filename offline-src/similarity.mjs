export function calculateFingerprintSimilarity(first, second) {
  if (!first?.length || first.length !== second?.length) return 0;
  let difference = 0;
  for (let i = 0; i < first.length; i++) difference += Math.abs(first[i] - second[i]);
  // White page backgrounds dominate document thumbnails, so amplify structural
  // pixel differences while leaving exact and near-exact repeats near 100%.
  return Math.max(0, Math.min(100, 100 - (difference / (first.length * 255)) * 350));
}

export function matchesBlankAndSimilar(blankPercentage, blankThreshold, similarityPercentage, similarityThreshold) {
  return blankPercentage >= blankThreshold && similarityPercentage >= similarityThreshold;
}
