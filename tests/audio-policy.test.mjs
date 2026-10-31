import test from 'node:test';
import assert from 'node:assert/strict';
import { isEnglishSubject, audioDecision } from '../public/audio-policy.js';

test('automatic audio recognizes English teaching subjects, not explanation language', () => {
  for (const subject of ['English', ' English reading and speaking ', 'English · Grammar', 'English literature', 'English language arts', 'English for science', 'English (Primary)', 'ESL', 'EFL', 'IELTS preparation', '英语', '英語閱讀', '英文阅读']) assert.equal(isEnglishSubject(subject), true, subject);
  for (const subject of ['Auto', 'Science', 'Math in English', 'English history', 'English physics', 'English muffin baking', 'English Civil War', 'English Channel', 'English Channel geography', 'English economics', 'English explanations', 'Englishness', 'Spanish', '', null]) assert.equal(isEnglishSubject(subject), false, String(subject));
  assert.equal(audioDecision('auto', 'English', { language: '简体中文' }), true);
  assert.equal(audioDecision('auto', 'Physics', { language: 'English', englishLearning: true }), false);
});

test('Auto defers subject inference until teaching; explicit on/off and subjects take priority', () => {
  assert.equal(audioDecision('auto'), null);
  assert.equal(audioDecision('auto', 'Auto', { englishLearning: true, subject: 'Language practice', language: 'Chinese' }), true);
  assert.equal(audioDecision('auto', 'Auto', { englishLearning: false, subject: 'English' }), false);
  assert.equal(audioDecision('auto', 'Auto', { subject: 'English reading and speaking' }), true);
  assert.equal(audioDecision('auto', 'Auto', { subject: 'Chemistry', language: 'English' }), false);
  assert.equal(audioDecision('auto', 'Auto', {}), false);
  assert.equal(audioDecision('on', 'Biology'), true);
  assert.equal(audioDecision('off', 'English', { englishLearning: true }), false);
  assert.equal(audioDecision('auto', 'English', { englishLearning: false }), true);
  assert.throws(() => audioDecision('invalid'), TypeError);
});
