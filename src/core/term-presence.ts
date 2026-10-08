/**
 * Candidate index for nonempty, capture-free, fixed-width compiler patterns.
 * False positives are safe; false negatives are not.
 */
export class TermPresenceIndex {
  private groups: { indices: number[]; characters: string[] | null }[] = [];

  constructor(private readonly patterns: RegExp[]) {
    for (let index = 0; index < patterns.length; index++) {
      const characters = firstCharacters(patterns[index].source);
      const group = { indices: [index], characters };
      // Merge groups whose first characters can overlap under Unicode folding.
      // Then a combined search can identify one group without hiding another
      // alternative at the same position (Alice versus AliceSmith, for example).
      for (let i = this.groups.length - 1; i >= 0; i--) {
        const other = this.groups[i];
        if (overlap(group.characters, other.characters)) {
          group.indices.push(...other.indices);
          group.characters = group.characters && other.characters
            ? [...new Set([...group.characters, ...other.characters])] : null;
          this.groups.splice(i, 1);
        }
      }
      this.groups.push(group);
    }
  }

  candidates(content: string, after = -1): Set<number> {
    const found = new Set<number>();
    const remaining = this.groups.map(group => group.indices.filter(index => index > after))
      .filter(indices => indices.length);
    let offset = 0;
    while (remaining.length) {
      // Fixed-width inputs contain no captures or quantifiers. Removing a
      // discovered group avoids revisiting millions of identical CSV values.
      const search = new RegExp(remaining.map(indices =>
        `(${indices.map(index => this.patterns[index].source).join("|")})`).join("|"), "giu");
      search.lastIndex = offset;
      const match = search.exec(content);
      if (!match) break;
      const selected = match.slice(1).findIndex(value => value !== undefined);
      for (const index of remaining[selected]) found.add(index);
      remaining.splice(selected, 1);
      // Another group's match may start inside this one. Search from the next
      // code point, not from the end of the match, to retain nested candidates.
      offset = match.index + (content.codePointAt(match.index)! > 0xffff ? 2 : 1);
    }
    return found;
  }
}

function firstCharacters(source: string): string[] | null {
  if (source.startsWith("[")) {
    const characters = source.slice(1, source.indexOf("]"));
    // Only the compiler's expanded letter classes have an enumerable prefix.
    // Dot's [^\n], escapes and any future syntax conservatively join all groups.
    return /^[\p{L}\p{N}]+$/u.test(characters) ? Array.from(characters) : null;
  }
  if (source.startsWith("\\")) return null;
  return [Array.from(source)[0]];
}

function overlap(left: string[] | null, right: string[] | null): boolean {
  if (!left || !right) return true;
  const pattern = new RegExp(`^(?:${left.map(char => char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`, "iu");
  return right.some(char => pattern.test(char));
}
