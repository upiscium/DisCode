const FALLBACK_BACKTICK = "ˋ";

/** Renders an authority-bearing identifier without stripping canonical punctuation. */
export function renderCanonicalIdentifier(value: string, maxLength = 120): string {
  if (!Number.isInteger(maxLength) || maxLength < 3) {
    throw new Error("maxLength must be an integer of at least 3");
  }

  let content = [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f ? "�" : character;
    })
    .join("");
  let fenceLength = longestBacktickRun(content) + 1;
  if (fenceLength * 2 >= maxLength) {
    content = content.replace(/`/g, FALLBACK_BACKTICK);
    fenceLength = 1;
  }

  const contentLimit = maxLength - fenceLength * 2;
  if (content.length > contentLimit) {
    content = `${content.slice(0, Math.max(0, contentLimit - 1))}…`;
  }
  const fence = "`".repeat(fenceLength);
  return `${fence}${content}${fence}`;
}

function longestBacktickRun(value: string): number {
  let longest = 0;
  for (const match of value.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return longest;
}
