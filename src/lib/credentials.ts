import type { LoginCredentials } from '../types';

export interface ParsedPromptCredentials {
  text: string;
  credentials?: LoginCredentials;
  hasCredentialFields: boolean;
  error?: string;
}

const USER_LABELS = new Set(['id', 'username', 'user name', 'email', 'e-mail', '아이디', '사용자명', '이메일']);
const LABEL_PATTERN = /(^|[\s,;{])(?:["'`*]{0,2})(아이디|사용자명|이메일|비밀번호|비번|패스워드|암호|username|user name|email|e-mail|password|pwd|pw|id)(?:["'`*]{0,2})\s*[:=：]\s*/gi;
const HIDDEN = '[로그인 정보 숨김]';

export function loginCredentialsError(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return '아이디와 비밀번호를 함께 입력해 주세요.';
  const { username, password } = value as Partial<LoginCredentials>;
  if (typeof username !== 'string' || !username.trim().length || typeof password !== 'string' || !password.length) return '아이디와 비밀번호를 함께 입력해 주세요.';
  if (username.length > 256 || password.length > 1024) return '아이디는 256자, 비밀번호는 1,024자 이내로 입력해 주세요.';
  if (/[\u0000-\u001f\u007f]/.test(username) || /[\u0000-\u001f\u007f]/.test(password)) return '로그인 정보에는 줄 바꿈이나 제어 문자를 사용할 수 없습니다.';
  return undefined;
}

/** Redacts both values, including repeated echoes, without regex interpretation. */
export function redactKnownCredentials(text: string, credentials?: Partial<LoginCredentials>): string {
  const secrets = [credentials?.username, credentials?.password].filter((value): value is string => typeof value === 'string' && value.length > 0);
  return [...new Set(secrets)].sort((a, b) => b.length - a.length).reduce((safe, secret) => safe.split(secret).join('[숨김]'), text);
}

function valueFrom(raw: string, followedByLabel: boolean): { value: string; malformed?: boolean } {
  const value = raw.trim();
  const quote = value[0];
  if (quote === '"' || quote === "'" || quote === '`') {
    let escaped = false;
    for (let index = 1; index < value.length; index += 1) {
      const character = value[index];
      if (escaped) { escaped = false; continue; }
      if (character === '\\') { escaped = true; continue; }
      if (character !== quote) continue;
      if (!/^[\s,;}\]]*$/.test(value.slice(index + 1))) return { value, malformed: true };
      const quoted = value.slice(0, index + 1);
      if (quote === '"') {
        try { return { value: JSON.parse(quoted) as string }; } catch { return { value, malformed: true }; }
      }
      return { value: value.slice(1, index) };
    }
    return { value, malformed: true };
  }
  return { value: followedByLabel ? value.replace(/[,;]\s*$/, '').trimEnd() : value };
}

/**
 * Explicit account assignments are removed before a prompt can be displayed or saved.
 * An inline assignment owns the rest of its line; quoted values preserve spaces.
 * Bare mentions of a label (without ':' or '=') remain ordinary prompt text.
 */
export function parsePromptCredentials(text: string): ParsedPromptCredentials {
  const lines = text.split(/\r?\n/);
  const safeLines: string[] = [];
  const fields: { kind: 'username' | 'password'; value: string }[] = [];
  const rawValues: string[] = [];
  let malformed = false;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const labels = [...line.matchAll(LABEL_PATTERN)];
    if (!labels.length) { safeLines.push(line); continue; }
    const prefix = line.slice(0, labels[0].index).trimEnd();
    if (prefix && !/^[-*>{\s]+$/.test(prefix)) safeLines.push(prefix);
    for (let index = 0; index < labels.length; index += 1) {
      const label = labels[index];
      const start = label.index! + label[0].length;
      let raw = line.slice(start, labels[index + 1]?.index ?? line.length);
      // Also consume a value placed directly under an empty label, never leaving it in text.
      if (!raw.trim() && index === labels.length - 1 && lineIndex + 1 < lines.length && ![...lines[lineIndex + 1].matchAll(LABEL_PATTERN)].length) raw = lines[++lineIndex];
      const parsed = valueFrom(raw, index < labels.length - 1);
      rawValues.push(raw.trim(), parsed.value);
      malformed ||= !!parsed.malformed;
      fields.push({ kind: USER_LABELS.has(label[2].toLowerCase()) ? 'username' : 'password', value: parsed.value });
    }
  }
  if (!fields.length) return { text, hasCredentialFields: false };
  let safeText = safeLines.join('\n').trim();
  // A prompt can repeat an assigned secret outside its account lines.
  for (const value of [...new Set(rawValues)].sort((a, b) => b.length - a.length)) if (value) safeText = safeText.split(value).join('[숨김]');
  const users = fields.filter(field => field.kind === 'username');
  const passwords = fields.filter(field => field.kind === 'password');
  const credentials = { username: users[0]?.value ?? '', password: passwords[0]?.value ?? '' };
  const error = malformed || users.length > 1 || passwords.length > 1
    ? '로그인 정보 형식을 확인해 주세요. 아이디와 비밀번호를 각각 한 줄에 하나씩 입력해 주세요.'
    : loginCredentialsError(credentials);
  return {
    text: `${safeText}${safeText ? '\n\n' : ''}${error ? HIDDEN : '[로그인 계정 첨부됨]'}`,
    hasCredentialFields: true,
    ...(error ? { error } : { credentials }),
  };
}
