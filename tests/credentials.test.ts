import test from 'node:test';
import assert from 'node:assert/strict';
import { loginCredentialsError, parsePromptCredentials, redactKnownCredentials } from '../src/lib/credentials';

test('extracts Korean account lines and removes both values from the retained prompt', () => {
  const parsed = parsePromptCredentials('https://example.com 에 로그인해 줘.\n아이디: account-742\n비밀번호: secret-953');
  assert.deepEqual(parsed.credentials, { username: 'account-742', password: 'secret-953' });
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.hasCredentialFields, true);
  assert.match(parsed.text, /https:\/\/example.com/);
  assert.equal(parsed.text.includes('account-742'), false);
  assert.equal(parsed.text.includes('secret-953'), false);
});

test('supports English labels, inline pairs, quoted labels and passwords containing spaces', () => {
  for (const usernameLabel of ['id', 'username', 'email']) {
    const parsed = parsePromptCredentials(`Visit the site. ${usernameLabel}: "person@example.com", password: " secret with spaces "`);
    assert.deepEqual(parsed.credentials, { username: 'person@example.com', password: ' secret with spaces ' });
    assert.match(parsed.text, /^Visit the site\./);
    assert.equal(parsed.text.includes('secret with spaces'), false);
  }
  assert.deepEqual(parsePromptCredentials('{"username":"quoted-user","password":"quoted-password"}').credentials, { username: 'quoted-user', password: 'quoted-password' });
  assert.deepEqual(parsePromptCredentials('"아이디": "quoted-user"\n"비밀번호": "quoted-password"').credentials, { username: 'quoted-user', password: 'quoted-password' });
});

test('partial, duplicate or malformed credential fields never leave the assigned password in text', () => {
  const inputs = [
    '비밀번호: secret-only-951',
    'password: secret-only-951\n나머지 요청입니다.',
    'username: person\npassword: secret-only-951\npassword: second-secret',
    'username: person\npassword: "secret-only-951',
    'password:\nsecret-only-951',
  ];
  for (const input of inputs) {
    const parsed = parsePromptCredentials(input);
    assert.equal(parsed.hasCredentialFields, true);
    assert.ok(parsed.error);
    assert.equal(parsed.credentials, undefined);
    assert.equal(parsed.text.includes('secret-only-951'), false);
    assert.equal(parsed.text.includes('second-secret'), false);
  }
  assert.ok(parsePromptCredentials('아이디: only-user').error);
});

test('mentions of field labels without assignments are preserved', () => {
  const input = '"password" 라벨과 아이디 입력칸을 찾아 줘. 요소 id는 login입니다.';
  assert.deepEqual(parsePromptCredentials(input), { text: input, hasCredentialFields: false });
  const url = 'https://example.com/page?id=public-item';
  assert.deepEqual(parsePromptCredentials(url), { text: url, hasCredentialFields: false });
});

test('validates lengths and control characters without rejecting ordinary password spaces', () => {
  assert.equal(loginCredentialsError({ username: 'u'.repeat(256), password: 'p'.repeat(1024) }), undefined);
  assert.equal(loginCredentialsError({ username: 'account', password: 'two words' }), undefined);
  assert.ok(loginCredentialsError({ username: 'u'.repeat(257), password: 'secret' }));
  assert.ok(loginCredentialsError({ username: 'account', password: 'p'.repeat(1025) }));
  assert.ok(loginCredentialsError({ username: 'account', password: 'secret\tvalue' }));
  const parsed = parsePromptCredentials('id: account\npassword: secret\tvalue');
  assert.ok(parsed.error);
  assert.equal(parsed.text.includes('secret'), false);
});

test('redacts known values literally and removes repeated password echoes in a prompt', () => {
  const credentials = { username: 'person@example.com', password: 'a.*$secret' };
  assert.equal(redactKnownCredentials('person@example.com used a.*$secret twice: a.*$secret', credentials), '[숨김] used [숨김] twice: [숨김]');
  const parsed = parsePromptCredentials('Do not repeat secret-999\nid: person-888\npassword: secret-999');
  assert.equal(parsed.text.includes('secret-999'), false);
});

test('recognizes common password aliases and strips partial alias assignments', () => {
  for (const label of ['pw', 'pwd', '비번', 'PW']) {
    const complete = parsePromptCredentials(`id: alias-account\n${label}: alias-secret`);
    assert.deepEqual(complete.credentials, { username: 'alias-account', password: 'alias-secret' });
    assert.equal(complete.text.includes('alias-secret'), false);
    const partial = parsePromptCredentials(`${label}: partial-alias-secret`);
    assert.ok(partial.error);
    assert.equal(partial.text.includes('partial-alias-secret'), false);
  }
});

test('rejects whitespace-only usernames while allowing spaces in a nonempty password', () => {
  assert.ok(loginCredentialsError({ username: '   ', password: 'secret phrase' }));
  assert.ok(loginCredentialsError({ username: '\u00a0', password: 'secret phrase' }));
  const parsed = parsePromptCredentials('id: "   "\npassword: " secret phrase "');
  assert.ok(parsed.error);
  assert.equal(parsed.credentials, undefined);
  assert.equal(parsed.text.includes('secret phrase'), false);
  assert.equal(loginCredentialsError({ username: 'valid-user', password: ' secret phrase ' }), undefined);
});
