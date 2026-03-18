export interface Scope {
  places: string[];
  people: string[];
}

export function loadScope(): Scope | undefined {
  const places = process.env.PACT_SCOPE_CHANNELS;
  const people = process.env.PACT_SCOPE_PEOPLE;

  if (!places && !people) return undefined;

  return {
    places: places ? places.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : [],
    people: people ? people.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : [],
  };
}
