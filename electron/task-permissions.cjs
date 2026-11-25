'use strict';

// Derive this once from the user's own task, never from page text or model output.
// The browser still limits this permission to one verified content-creation form;
// it does not authorize payments, deletion, account changes or arbitrary requests.
const CONTENT_KINDS = Object.freeze(['notice', 'post', 'article']);

function deriveTaskPermissions(task) {
  const valid = typeof task === 'string' && task.length <= 32000;
  const text = valid ? task.normalize('NFKC').toLowerCase().replace(/https?:\/\/\S+/g, ' ') : '';
  const contentAction = '(?:등록|게시|발행|저장|제출|퍼블리시|포스팅)';
  const forbidden = new RegExp(`${contentAction}(?:을|를|은|는|이|가|도|까지|만)?\\s*(?:(?:절대|실제로?|자동으로|직접|아예)\\s*)*(?:하지\\s*(?:마|말|않)|금지|제외|없이|안\\s*(?:해|하)|하지는\\s*않|원하지\\s*않)`);
  const negativeBefore = new RegExp(`(?:절대\\s*)?(?:안|못)\\s*${contentAction}`);
  const explicitRestriction = /읽기\s*전용|조회\s*전용|읽기만|조회만|보기만|구경만|(?:초안|미리\s*보기|입력|작성)\s*만|(?:등록|게시|발행|저장|제출)\s*버튼\s*만|(?:등록|게시|발행|저장|제출)\s*버튼(?:을|은|는)?\s*(?:누르지|클릭하지)\s*(?:마|말|않)|올리(?:지|진)\s*(?:마|말)|올리지\s*않|\b(?:read[ -]?only|view[ -]?only|draft[ -]?only|preview[ -]?only)\b/;
  const englishRestriction = /\b(?:do\s+not|don't|dont|must\s+not|never|without|avoid|no)\b[^.!?\n]{0,60}\b(?:submit(?:ting)?|publish(?:ing)?|post(?:ing)?|sav(?:e|ing)|creat(?:e|ing))\b|\b(?:submit(?:ting)?|publish(?:ing)?|post(?:ing)?)\b[^.!?\n]{0,24}\b(?:forbidden|prohibited|disabled)\b|\b(?:only|just)\s+(?:a\s+)?(?:draft|preview|inspect|view|read|fill|type)\b|\b(?:draft|preview|inspect|view|read|fill|type)\b[^.!?\n]{0,24}\bonly\b/;
  // A request for a draft alone still stops before publication. An explicit
  // draft-then-publish sequence is allowed unless another restriction forbids it.
  const draft = /초안|\bdrafts?\b/.test(text);
  const publish = /(?:등록|게시(?!글|물|판)|발행|제출|퍼블리시|포스팅)(?:을|를|은|는|이|가)?\s*(?:정상\s*)?(?:하|해|할|되|성공|완료|테스트|점검)|\b(?:publish|submit|post\s+(?:it|this|the\s+draft))\b/.test(text);
  const denied = !valid || forbidden.test(text) || negativeBefore.test(text)
    || explicitRestriction.test(text) || englishRestriction.test(text) || (draft && !publish);
  return Object.freeze({ allowContentSubmission: !denied, contentKinds: CONTENT_KINDS });
}

module.exports = { deriveTaskPermissions };
