const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deriveTaskPermissions } = require('../electron/task-permissions.cjs');

test('ordinary tasks allow guarded content creation without requiring a publishing whitelist', () => {
  for (const task of [
    'https://example.com 사이트를 탐색해 줘.',
    '관리자 계정으로 로그인해서 공지사항 글쓰기가 정상 등록되는지 점검해 줘.',
    '공지글 제목과 본문을 입력한 뒤 등록해 정상 등록되는지 확인해 주세요.',
    '게시판 글쓰기 기능을 점검해 줘.',
    '기사 초안을 작성한 뒤 게시해 줘.',
    '초안 먼저 작성하고 등록해 줘.',
    '공지 등록이 오류 없이 정상되는지 점검해 줘.',
    '오류 없이 정상 등록되는지 점검해 줘.',
    'Test the article editor and submit a new article.',
    'Write a blog post.',
    'Write a draft, then publish it.',
  ]) {
    const permission = deriveTaskPermissions(task);
    assert.equal(permission.allowContentSubmission, true, task);
    assert.deepEqual(permission.contentKinds, ['notice', 'post', 'article']);
    assert.equal(Object.isFrozen(permission), true);
    assert.equal(Object.isFrozen(permission.contentKinds), true);
    assert.deepEqual(Object.keys(permission).sort(), ['allowContentSubmission', 'contentKinds']);
  }
});

test('explicit no-submit, draft and read-only restrictions override autonomous content creation', () => {
  for (const task of [
    '공지사항 초안만 작성해 줘.', '공지사항 초안을 작성해 줘.',
    '게시글 초안을 작성해 줘.', '게시물 초안 작성 부탁해.', '게시판에 쓸 초안을 작성해줘.',
    '글쓰기 기능을 확인하되 등록하지 마.', '작성해도 게시하지 말아 줘.',
    '등록은 절대 하지 말고 본문 입력만 해줘.', '글 등록 금지. 나머지를 탐색해.',
    '저장 없이 확인해 줘.', '게시 안 해도 되니 초안만 입력해.',
    '제출하지는 않아야 해.', '읽기 전용으로 확인해 줘.', '조회만 해줘.',
    '글을 작성하되 게시하지 않고 화면만 확인해.', '올리진 마.', '저장 금지.', '읽기만 해줘.', '초안을 저장해 줘.',
    '공지사항 등록 버튼만 확인해 줘.',
    '등록 버튼은 누르지 마.',
    'Never publish an article.', 'Do not submit the form.', "Don't post anything.",
    'Check the article editor without saving.', 'Read-only exploration.',
    'Write only a draft.', 'Write a draft only.', 'Just fill the article fields.',
    'Save a draft for me.',
    'Publish an article. Do not submit or publish anything.',
  ]) assert.equal(deriveTaskPermissions(task).allowContentSubmission, false, task);
});

test('malformed permission sources fail closed and only the original string is accepted', () => {
  for (const input of [undefined, null, {}, { task: 'publish' }, ['publish'], 'x'.repeat(32001)]) {
    assert.equal(deriveTaskPermissions(input).allowContentSubmission, false);
  }
  assert.equal(deriveTaskPermissions('https://example.com/read-only').allowContentSubmission, true, 'URL words are not user restrictions.');
});
