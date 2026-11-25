function validateCredentials(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => key !== 'username' && key !== 'password')
    || typeof value.username !== 'string' || typeof value.password !== 'string') {
    throw new Error('로그인 정보의 형식이 올바르지 않습니다.');
  }
  const username = value.username.trim();
  const password = value.password;
  if (!username || username.length > 320 || !password || password.length > 1024
    || /[\u0000-\u001f\u007f]/.test(username + password)) {
    throw new Error('사용자 이름과 비밀번호의 길이 또는 문자를 확인해 주세요.');
  }
  return { username, password };
}

function createSecretRedactor(credentials) {
  const variants = new Set();
  for (const secret of credentials ? [credentials.username, credentials.password] : []) {
    if (!secret) continue;
    variants.add(secret);
    variants.add(JSON.stringify(secret).slice(1, -1));
    try {
      variants.add(encodeURIComponent(secret));
      variants.add(encodeURI(secret));
      variants.add(encodeURIComponent(secret).replace(/%20/g, '+'));
    } catch { /* Exact redaction still applies to malformed Unicode. */ }
    variants.add(secret.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'));
  }
  const ordered = [...variants].filter(Boolean).sort((a, b) => b.length - a.length);
  const replacement = ['[로그인 정보 숨김]', '[REDACTED]', '•••', ''].find(candidate => ordered.every(secret => !candidate.includes(secret)));
  return value => {
    let result = typeof value === 'string' ? value : String(value ?? '');
    for (const secret of ordered) result = result.split(secret).join(replacement);
    return result;
  };
}

module.exports = { validateCredentials, createSecretRedactor };
