import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFirstWebUrl } from '../src/lib/url';

test('extracts first HTTP URL and normalizes www addresses', () => {
  assert.equal(extractFirstWebUrl('https://example.com 확인해 줘'), 'https://example.com/');
  assert.equal(extractFirstWebUrl('www.example.com/path?tab=1 확인'), 'https://www.example.com/path?tab=1');
  assert.equal(extractFirstWebUrl('https://first.test https://second.test'), 'https://first.test/');
});

test('trims quotes, prose punctuation and unmatched closing brackets', () => {
  assert.equal(extractFirstWebUrl('"https://example.com" 열어 줘'), 'https://example.com/');
  assert.equal(extractFirstWebUrl('주소 (https://example.com/path).'), 'https://example.com/path');
  assert.equal(extractFirstWebUrl('“https://example.com”, 부탁해'), 'https://example.com/');
  assert.equal(extractFirstWebUrl('[사이트](https://example.com/path)'), 'https://example.com/path');
  assert.equal(extractFirstWebUrl('https://example.com/wiki/Function_(mathematics)'), 'https://example.com/wiki/Function_(mathematics)');
});

test('handles Korean particles on host without corrupting Korean URL paths', () => {
  assert.equal(extractFirstWebUrl('https://example.com을 열어 줘'), 'https://example.com/');
  assert.equal(extractFirstWebUrl('www.example.com에서 확인해'), 'https://www.example.com/');
  assert.equal(extractFirstWebUrl('https://example.com/한글로'), new URL('https://example.com/한글로').href);
});

test('extracts Markdown and parenthesized URLs followed by Korean instructions', () => {
  assert.equal(extractFirstWebUrl('[http://127.0.0.1:5173/](http://127.0.0.1:5173/)에서 로그인 기능을 점검해줘.'), 'http://127.0.0.1:5173/');
  assert.equal(extractFirstWebUrl('[사이트](https://example.com/login)에서 로그인 후 글쓰기 화면을 확인해 줘'), 'https://example.com/login');
  assert.equal(extractFirstWebUrl('(https://example.com/)에서 메뉴와 검색을 확인해 줘'), 'https://example.com/');
  assert.equal(extractFirstWebUrl('[문서](https://example.com/wiki/Function_(mathematics))에서 확인해 줘'), 'https://example.com/wiki/Function_(mathematics)');
  assert.equal(extractFirstWebUrl('[로컬](http://[::1]:3000/)에서 확인해 줘'), 'http://[::1]:3000/');
});

test('supports explicit localhost, IP addresses and IPv6', () => {
  assert.equal(extractFirstWebUrl('http://localhost:3000/login'), 'http://localhost:3000/login');
  assert.equal(extractFirstWebUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080/');
  assert.equal(extractFirstWebUrl('http://[::1]:3000/'), 'http://[::1]:3000/');
});

test('ignores dangerous schemes, embedded addresses and invalid candidates', () => {
  assert.equal(extractFirstWebUrl('javascript:alert(1)'), null);
  assert.equal(extractFirstWebUrl('file:///C:/test.html'), null);
  assert.equal(extractFirstWebUrl('ftp://www.example.com'), null);
  assert.equal(extractFirstWebUrl('javascript:https://example.com'), null);
  assert.equal(extractFirstWebUrl('test@www.example.com'), null);
  assert.equal(extractFirstWebUrl('https://:bad 다음 https://example.com'), 'https://example.com/');
  assert.equal(extractFirstWebUrl('URL 없이 테스트해 줘'), null);
});
