export const POINT_LABELS = ['0', '15', '30', '40'];

export function formatPointLabel(pointCount) {
  if (pointCount === 4) return 'AD';
  return POINT_LABELS[pointCount] ?? String(pointCount);
}

export function formatPoints(us, them) {
  return `${formatPointLabel(us)}-${formatPointLabel(them)}`;
}
