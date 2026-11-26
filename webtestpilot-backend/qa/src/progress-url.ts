/** Display metadata only: preserve the observed same-origin route, never query data. */
export function progressUrl(value: string | undefined, origin: string): string | undefined {
  if (!value || value.length > 8192) return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) return undefined;
    const hash = /^#!?\//.test(url.hash) ? url.hash.split('?')[0] : '';
    url.search = '';
    url.hash = hash;
    return url.href;
  } catch { return undefined; }
}
