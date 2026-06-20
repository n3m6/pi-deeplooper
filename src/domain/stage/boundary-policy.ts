// Boundary policy — classifies files as test vs pipeline artifact.
// No node:* or pi imports.

export function isTestFile(relativePath: string): boolean {
  return /\b(__tests__|tests?|spec)\b/.test(relativePath) || /[._-](test|spec)\.[^.]+$/.test(relativePath);
}

export function isPipelineArtifact(relativePath: string): boolean {
  return relativePath.startsWith(".pipeline/");
}
