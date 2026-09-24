export function getScenarioFormMode(scenario) {
  return scenario ? 'edit' : 'add';
}

export function getRelationValue(placement) {
  return placement?.relation === 'after' || placement?.relation === 'same'
    ? placement.relation
    : 'none';
}
