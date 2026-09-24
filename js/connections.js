export function getScenarioPairKey(scenarioA, scenarioB) {
  return [scenarioA.id, scenarioB.id].sort().join(':');
}

export function isSameRelation(scenarioA, scenarioB) {
  const sourceIsSame = scenarioA?.placement?.relation === 'same'
    && scenarioA.placement.referenceScenarioId === scenarioB?.id;
  const targetIsSame = scenarioB?.placement?.relation === 'same'
    && scenarioB.placement.referenceScenarioId === scenarioA?.id;
  return sourceIsSame || targetIsSame;
}

export function getConnectionEndpoints(source, target, sameRelation = false) {
  const sourceAboveTarget = source.cy < target.cy;
  const sourceLeftOfTarget = source.cx < target.cx;
  const preferVertical = !sameRelation;

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
