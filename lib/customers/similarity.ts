/**
 * Edit distance for spotting typos: optimal string alignment (Damerau-
 * Levenshtein without repeated edits of the same substring). Counts one edit
 * for a missing, extra, wrong or swapped-adjacent character.
 */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  let prev2 = new Array<number>(m + 1).fill(0);
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  let cur = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    [prev2, prev, cur] = [prev, cur, prev2];
  }
  return prev[m];
}

/** Typos tolerated in one word, by its length: none under 4, one up to 7, two from 8. */
export function allowedEdits(length: number): number {
  if (length < 4) return 0;
  if (length < 8) return 1;
  return 2;
}

/** All strings made by deleting one character (plus the word itself). Used to find typo candidates fast. */
export function deletionKeys(word: string): string[] {
  const keys = new Set<string>([word]);
  for (let i = 0; i < word.length; i++) keys.add(word.slice(0, i) + word.slice(i + 1));
  return [...keys];
}
