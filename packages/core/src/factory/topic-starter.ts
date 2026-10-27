/**
 * No-material starting point: deterministic, rule-based topic suggestions.
 *
 * This is NOT semantic AI. It calls no model, performs no lookup and invents no
 * scripture, quotation or fact: it combines fixed, reviewed topic angles for the
 * content profile with a few keywords taken from the owner's channel purpose.
 * The output is labelled `local_rules` everywhere it is shown, so it can never be
 * mistaken for the local semantic planner (which is a separate, runtime-gated
 * route). A suggested topic only fills the brief; the owner still supplies or
 * reviews every word of the script.
 */
import type { FactoryContentProfile, FactoryLanguage } from './contract.js';
import { detectLanguage } from './planning.js';

/** One reviewed starting topic. `id` is stable for a given profile and index. */
export interface FactoryTopicSuggestion {
  id: string;
  title: string;
  /** Why this angle fits the profile. Fixed copy, no generated facts. */
  angle: string;
  /**
   * What the owner does next. Rules never write the script: the owner pastes
   * reviewed words, or runs the separately gated local semantic planner.
   */
  nextStep: string;
}

export interface FactoryTopicResult {
  /** Always local_rules: these suggestions are deterministic, not semantic. */
  route: 'local_rules';
  language: Exclude<FactoryLanguage, 'und'>;
  suggestions: FactoryTopicSuggestion[];
}

interface TopicCopy {
  angle: string;
  nextStep: string;
  titles: string[];
  /** Used when the channel purpose yields no usable keyword. */
  fallbackTopic: string;
}

const EN_COPY: Record<FactoryContentProfile, TopicCopy> = {
  religious: {
    angle: 'A reflective theme, not a scripture passage. Passages and quoted words are always supplied by you; the rules never generate them.',
    nextStep: 'Pick the theme, then supply the reviewed passage and reflection text, or open the local semantic planner when it is configured.',
    titles: [
      'Patience in ordinary daily moments',
      'Gratitude as a daily practice',
      'Truthfulness at work and at home',
      'Kindness inside the household',
      'Keeping promises in small matters',
      'Calm when plans go wrong',
    ],
    fallbackTopic: 'A practical reflection on everyday conduct',
  },
  educational: {
    angle: 'A problem-first explainer angle. Each topic can carry one worked example and one action step using facts you supply.',
    nextStep: 'Pick the topic, then paste the reviewed lesson text, or open the local semantic planner when it is configured.',
    titles: [
      'The one mistake beginners make with {kw}',
      'A worked example that explains {kw}',
      'Three practical steps to apply {kw} today',
      'What {kw} looks like on a real site',
      'A five-minute primer on {kw}',
      'The checklist behind safe {kw}',
    ],
    fallbackTopic: 'A short explainer built around one clear problem',
  },
  promotional: {
    angle: 'A customer-problem angle. Product claims stay yours: the rules add no figure, result or call to action.',
    nextStep: 'Pick the topic, then supply the reviewed claim, proof and call to action, or open the local semantic planner when it is configured.',
    titles: [
      'The everyday problem {kw} solves',
      'What changes for the customer after {kw}',
      'A clear first step with {kw}',
      'Why buyers choose {kw} over the usual route',
      'The one question customers ask about {kw}',
      'A week with {kw}: a realistic picture',
    ],
    fallbackTopic: 'A customer story built around one reviewed benefit',
  },
};

const AR_COPY: Record<FactoryContentProfile, TopicCopy> = {
  religious: {
    angle: 'محور تأملي وليس نصًا شرعيًا. النصوص والاقتباسات تُعتمد منك دائمًا، والقواعد لا تولّد أي آية أو اقتباس.',
    nextStep: 'اختر المحور ثم أضف النص المراجَع، أو استخدم المخطط الدلالي المحلي عند تجهيزه.',
    titles: [
      'الصبر في تفاصيل الحياة اليومية',
      'الامتنان عادة يومية',
      'الصدق في العمل والبيت',
      'اللطف داخل البيت',
      'الوفاء بالوعود الصغيرة',
      'الهدوء حين تتعطل الخطط',
    ],
    fallbackTopic: 'تأمل عملي في سلوك يومي',
  },
  educational: {
    angle: 'زاوية تبدأ بالمشكلة. يمكن أن يضم كل موضوع مثالًا واحدًا وخطوة عملية تستند إلى معلومات تقدمها أنت.',
    nextStep: 'اختر الموضوع ثم الصق النص التعليمي المراجَع، أو استخدم المخطط الدلالي المحلي عند تجهيزه.',
    titles: [
      'الخطأ الأكثر شيوعًا في {kw}',
      'مثال عملي يشرح {kw}',
      'ثلاث خطوات عملية لتطبيق {kw} اليوم',
      'كيف يبدو {kw} في موقع حقيقي',
      'مقدمة سريعة عن {kw}',
      'قائمة المراجعة لتطبيق {kw} بأمان',
    ],
    fallbackTopic: 'شرح قصير يبنى حول مشكلة واحدة واضحة',
  },
  promotional: {
    angle: 'زاوية تبدأ بمشكلة العميل. الادعاءات والأرقام تظل ملكك؛ القواعد لا تضيف نتيجة أو رقمًا أو دعوة.',
    nextStep: 'اختر الموضوع ثم قدم الادعاء والدليل والدعوة المراجَعة، أو استخدم المخطط الدلالي المحلي عند تجهيزه.',
    titles: [
      'المشكلة اليومية التي يحلها {kw}',
      'ما الذي يتغير للعميل مع {kw}',
      'خطوة أولى واضحة مع {kw}',
      'لماذا يختار العملاء {kw} بدل الطريقة المعتادة',
      'السؤال الأول الذي يسأله العملاء عن {kw}',
      'أسبوع مع {kw}: صورة واقعية',
    ],
    fallbackTopic: 'قصة عميل تبنى حول فائدة واحدة مراجَعة',
  },
};

/** Split a free-text channel purpose into a few clean keywords. Deterministic, conservative. */
export function purposeKeywords(purpose: string, language: Exclude<FactoryLanguage, 'und'>): string[] {
  const arabicStop = new Set(['في', 'من', 'على', 'عن', 'مع', 'هذا', 'هذه', 'ذلك', 'التي', 'الذي', 'إلى', 'كل', 'أو', 'و', 'أن', 'قناة']);
  const englishStop = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'you', 'are', 'how', 'why', 'what', 'channel', 'about']);
  const tokens = purpose
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .filter((t) => (language === 'ar' ? !arabicStop.has(t) : !englishStop.has(t.toLowerCase())));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= 3) break;
  }
  return out;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Three deterministic starting topics for a content profile. When the channel
 * purpose carries usable keywords, the first keyword is woven into the titles;
 * otherwise the profile's fallback topic is used. Religious suggestions are
 * always thematic and never contain generated scripture.
 */
export function suggestTopics(
  profile: FactoryContentProfile,
  purpose: string = '',
  opts: { count?: number } = {},
): FactoryTopicResult {
  const count = clamp(Math.trunc(opts.count ?? 3), 1, 6);
  const lang: Exclude<FactoryLanguage, 'und'> = detectLanguage(purpose) === 'ar' ? 'ar' : 'en';
  const copy = lang === 'ar' ? AR_COPY[profile] : EN_COPY[profile];
  const keywords = purposeKeywords(purpose, lang);
  const kw = keywords[0];
  const fill = (title: string): string => (kw ? title.replace('{kw}', kw) : copy.fallbackTopic);
  const suggestions: FactoryTopicSuggestion[] = copy.titles.slice(0, count).map((title, i) => ({
    id: `topic-${i + 1}`,
    title: fill(title),
    angle: copy.angle,
    nextStep: copy.nextStep,
  }));
  return { route: 'local_rules', language: lang, suggestions };
}
