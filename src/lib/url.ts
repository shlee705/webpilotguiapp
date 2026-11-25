/** Extract the first web address from prose without accepting other URI schemes. */
export function extractFirstWebUrl(text: string): string | null {
  const matches = text.matchAll(/(?:https?:\/\/|www\.)[^\s<>"'`“”‘’]+/gi);
  for (const match of matches) {
    const index = match.index ?? 0;
    // Do not extract a URL embedded in another scheme, a hostname or an email.
    if (index > 0 && /[\p{L}\p{N}_@:/\\.-]/u.test(text[index - 1])) continue;
    let candidate = match[0].replace(/[.,;:!?。！，；：！？]+$/u, '');
    // Preserve balanced brackets in real paths, e.g. /wiki/Function_(mathematics).
    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
      while (candidate.endsWith(close) && candidate.split(close).length > candidate.split(open).length) {
        candidate = candidate.slice(0, -1).replace(/[.,;:!?。！，；：！？]+$/u, '');
      }
    }
    // Korean particles attached directly to an ASCII host are prose, not its TLD.
    // Keep Korean path/query text intact because it can be a valid URL component.
    candidate = candidate.replace(/^((?:https?:\/\/|www\.)[a-z0-9.-]+(?::\d+)?)(?:에서|으로|을|를|은|는|이|가|에|로|와|과|도)$/i, '$1');
    try {
      const url = new URL(/^www\./i.test(candidate) ? `https://${candidate}` : candidate);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname && url.hostname.toLowerCase() !== 'www.') {
        return url.href;
      }
    } catch { /* Continue to the next candidate when the first address is invalid. */ }
  }
  return null;
}
