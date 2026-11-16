// Additive aliases for naming consistency: `from` / `to` are the preferred names of a range's ends everywhere, and the older
// names (`since` / `until`, `startdate` / `enddate`) keep working with the same meaning. Both given and different is an
// error, never a silent pick.
export function aliased(args: Record<string, unknown>, preferred: string, old: string): unknown {
  const [p, o] = [args[preferred], args[old]];
  if (p !== undefined && o !== undefined && p !== o) {
    throw new Error(`${preferred} and ${old} mean the same thing but differ (${JSON.stringify(p)} and ${JSON.stringify(o)}): give one of them (${preferred} is preferred).`);
  }
  return p ?? o;
}

// Same, for an end that is required: neither given is an error naming both.
export function requiredAliased(args: Record<string, unknown>, preferred: string, old: string): unknown {
  const v = aliased(args, preferred, old);
  if (v === undefined) throw new Error(`${preferred} (or ${old}) is required.`);
  return v;
}
