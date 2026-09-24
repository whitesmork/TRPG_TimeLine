export function getScenarioPairKey(scenarioA, scenarioB) {
  return [scenarioA.id, scenarioB.id].sort().join(':');
}

export function getConnectionEndpoints(source, target) {
  const sourceAboveTarget = source.cy < target.cy;
  const sourceLeftOfTarget = source.cx < target.cx;
  const preferVertical = Math.abs(source.cy - target.cy) >= 0.01;

  return {
    preferVertical,
    sourceAboveTarget,
    sourceLeftOfTarget,
    startEdge: preferVertical
      ? (sourceAboveTarget ? 'bottom' : 'top')
      : (sourceLeftOfTarget ? 'right' : 'left'),
    endEdge: preferVertical
      ? (sourceAboveTarget ? 'top' : 'bottom')
      : (sourceLeftOfTarget ? 'left' : 'right')
  };
}
