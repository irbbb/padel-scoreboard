const POINT_LABELS = ['0', '15', '30', '40'];

export function formatPoints(us, them) {
  const left = POINT_LABELS[us] ?? String(us);
  const right = POINT_LABELS[them] ?? String(them);
  return `${left}-${right}`;
}
