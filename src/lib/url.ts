/** Extract the first web address from prose without accepting other URI schemes. */
export function extractFirstWebUrl(text: string): string | null {
  const matches = text.matchAll(/(?:https?:\/\/|www\.)[^\s<>"'`“”‘’]+/gi);
  for (const match of matches) {
    const index = match.index ?? 0;
    // Do not extract a URL embedded in another scheme, a hostname or an email.
    if (index > 0 && /[\p{L}\p{N}_@:/\\.-]/u.test(text[index - 1])) continue;
    let candidate = match[0].replace(/[.,;:!?。！，；：！？]+$/u, '');
    // An unmatched closing bracket ends a link even when prose follows it, e.g.
    // [https://example.com/](https://example.com/)에서. Keep balanced URL paths
    // and IPv6 hosts intact.
    const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
    const depths: Record<string, number> = { '(': 0, '[': 0, '{': 0 };
    for (let offset = 0; offset < candidate.length; offset += 1) {
      const character = candidate[offset];
      if (character in depths) depths[character] += 1;
      else if (character in pairs) {
        const open = pairs[character];
        if (!depths[open]) { candidate = candidate.slice(0, offset); break; }
        depths[open] -= 1;
      }
    }
    candidate = candidate.replace(/[.,;:!?。！，；：！？]+$/u, '');
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
