// Audio follows the teaching subject, NOT the explanation language or Latin script.
// No network/inference: Auto uses metadata from the normal lesson response.
export function isEnglishSubject(subject) {
  const value = typeof subject === 'string' ? subject.trim().toLowerCase() : '';
  if (/^(?:英语|英語|英文)(?:$|[\s·:：—–-]|阅读|閱讀|写作|寫作|听力|聽力|口语|口語|语法|語法|文学|文學|学习|學習)/u.test(value)) return true;
  if (/^(?:esl|efl|esol|ielts|toefl)(?:$|\s|[·:—–-])/u.test(value)) return true;
  if (value === 'english') return true;
  if (/^english(?:\s|[·•:—–(\[-])/u.test(value)) {
    // A small positive vocabulary is safer than treating every adjective
    // "English" as language study (English muffins, history, Channel, etc.).
    const topic = value.slice(7).replace(/^[\s·•:—–(\[-]+/u, '');
    return /^(?:language|literature|grammar|reading|speaking|listening|writing|phonics|pronunciation|vocabulary|spelling|comprehension|composition|conversation|communication|fluency|literacy|esl|efl|esol|ielts|toefl|for|as|primary|secondary|junior|high school|college|university|grade|beginner|advanced|basic)\b/u.test(topic);
  }
  return false;
}

export function audioDecision(mode, subject = 'Auto', lesson) {
  if (!['auto', 'on', 'off'].includes(mode)) throw new TypeError('Invalid audio preference.');
  if (mode !== 'auto') return mode === 'on';
  if (typeof subject === 'string' && subject.trim() && !/^auto$/i.test(subject.trim())) return isEnglishSubject(subject);
  if (!lesson) return null; // Classification is not known until normal teaching ends.
  if (typeof lesson.englishLearning === 'boolean') return lesson.englishLearning;
  return isEnglishSubject(lesson.subject); // Older compatible lesson responses.
}
