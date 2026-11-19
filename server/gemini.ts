import fs from 'node:fs';
import path from 'node:path';
import {
  createPartFromUri,
  FileState,
  GoogleGenAI,
  Part,
  ThinkingLevel,
  Type,
} from '@google/genai';
import { CurriculumBook, Lesson, TutorMode } from '../src/types';
import { UPLOADS_DIR } from './db';
import { runMathEngine } from './mathEngine';
import { SYRIAN_GRADES } from './seedData';

const INLINE_LIMIT_BYTES = 15 * 1024 * 1024; // Use Gemini Files API above 15MB

const uploadedFileCache = new Map<
  string,
  { uri: string; mimeType: string; expiresAt: number }
>();

function formatGeminiError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  try {
    const parsed = JSON.parse(raw) as {
      error?: { code?: number; message?: string; status?: string };
    };
    const code = parsed?.error?.code;
    const status = parsed?.error?.status;
    if (code === 503 || status === 'UNAVAILABLE') {
      return 'خدمة الذكاء الاصطناعي تشهد ضغطاً مؤقتاً حالياً (503). يرجى المحاولة مرة أخرى بعد لحظات.';
    }
    if (code === 429 || status === 'RESOURCE_EXHAUSTED') {
      return 'تم تجاوز حد الطلبات المؤقت لخدمة الذكاء الاصطناعي. انتظر دقيقة ثم أعد المحاولة.';
    }
    if (code === 401 || code === 403) {
      return 'تعذر التحقق من صلاحية مفتاح الذكاء الاصطناعي (GEMINI_API_KEY).';
    }
    if (parsed?.error?.message) {
      return `تعذر الحصول على رد من الذكاء الاصطناعي: ${parsed.error.message}`;
    }
  } catch {
    // Non-JSON error message
  }
  if (raw.includes('503') || raw.includes('UNAVAILABLE') || raw.includes('high demand')) {
    return 'خدمة الذكاء الاصطناعي تشهد ضغطاً مؤقتاً حالياً. يرجى المحاولة مرة أخرى بعد ثوانٍ.';
  }
  return raw || 'حدث خطأ أثناء التواصل مع مدرس الرياضيات الذكي.';
}

function isTransientApiError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return (
    msg.includes('503') ||
    msg.includes('429') ||
    msg.includes('UNAVAILABLE') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('high demand') ||
    msg.includes('overloaded') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT')
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`ETIMEDOUT: ${label} exceeded ${ms}ms`));
    }, ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function generateContentWithFallback(
  ai: GoogleGenAI,
  params: {
    parts: Part[];
    systemInstruction?: string;
    thinkingLevel?: ThinkingLevel;
    responseMimeType?: string;
    responseSchema?: unknown;
  }
) {
  const attempts: Array<{
    model: string;
    delayMs: number;
    useThinking: boolean;
    timeoutMs: number;
  }> = [
    { model: 'gemini-4-hydrogen', delayMs: 0, useThinking: true, timeoutMs: 10000 },
    { model: 'gemini-3.1-flash-lite', delayMs: 200, useThinking: false, timeoutMs: 8000 },
  ];

  let lastErr: unknown;
  for (const attempt of attempts) {
    if (attempt.delayMs > 0) {
      await new Promise((r) => setTimeout(r, attempt.delayMs));
    }
    try {
      const config: Record<string, unknown> = {};
      if (params.systemInstruction) {
        config.systemInstruction = params.systemInstruction;
      }
      if (attempt.useThinking && params.thinkingLevel) {
        config.thinkingConfig = { thinkingLevel: params.thinkingLevel };
      }
      if (params.responseMimeType) {
        config.responseMimeType = params.responseMimeType;
      }
      if (params.responseSchema) {
        config.responseSchema = params.responseSchema;
      }
      return await withTimeout(
        ai.models.generateContent({
          model: attempt.model,
          contents: { parts: params.parts },
          config,
        }),
        attempt.timeoutMs,
        attempt.model
      );
    } catch (err) {
      lastErr = err;
      if (!isTransientApiError(err)) {
        throw err;
      }
    }
  }
  throw lastErr;
}

function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error(
      'مفتاح GEMINI_API_KEY غير مهيأ. يرجى إضافته في إعدادات الأسرار (Settings > Secrets) لتفعيل الذكاء الاصطناعي.'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function getCachedLargeFilePart(
  filePath: string,
  mimeType: string
): Part | null {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  const cacheKey = `${filePath}:${stat.size}:${stat.mtimeMs}`;
  const cached = uploadedFileCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return createPartFromUri(cached.uri, cached.mimeType);
  }
  return null;
}

async function buildMediaPart(
  ai: GoogleGenAI,
  file: {
    mimeType: string;
    filePath?: string;
    base64?: string;
    size?: number;
  }
): Promise<Part> {
  const stat =
    file.filePath && fs.existsSync(file.filePath)
      ? fs.statSync(file.filePath)
      : null;
  const fileSize = file.size ?? stat?.size ?? 0;

  if (file.filePath && fileSize > INLINE_LIMIT_BYTES) {
    const cacheKey = `${file.filePath}:${fileSize}:${stat?.mtimeMs ?? 0}`;
    const cached = uploadedFileCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return createPartFromUri(cached.uri, cached.mimeType);
    }

    let uploaded = await ai.files.upload({
      file: file.filePath,
      config: { mimeType: file.mimeType },
    });
    let attempts = 0;
    while (
      uploaded.state === FileState.PROCESSING &&
      uploaded.name &&
      attempts < 20
    ) {
      await new Promise((r) => setTimeout(r, 1000));
      uploaded = await ai.files.get({ name: uploaded.name });
      attempts++;
    }
    if (uploaded.state === FileState.FAILED) {
      throw new Error('تعذرت معالجة الملف الكبير عبر خدمة الملفات.');
    }
    if (!uploaded.uri) {
      throw new Error('لم يرجع رابط الملف بعد الرفع.');
    }
    const resolvedMime = uploaded.mimeType || file.mimeType;
    uploadedFileCache.set(cacheKey, {
      uri: uploaded.uri,
      mimeType: resolvedMime,
      expiresAt: Date.now() + 36 * 60 * 60 * 1000,
    });
    return createPartFromUri(uploaded.uri, resolvedMime);
  }

  const base64Data =
    file.base64 ??
    (file.filePath ? fs.readFileSync(file.filePath).toString('base64') : '');

  return {
    inlineData: {
      mimeType: file.mimeType,
      data: base64Data,
    },
  };
}

export interface TutorChatInput {
  message: string;
  gradeId: number;
  maxAllowedGradeId: number;
  lesson?: Lesson | null;
  referenceBook?: CurriculumBook | null;
  allowedBooks: CurriculumBook[];
  allowedLessons: Lesson[];
  mode: TutorMode;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  file?: {
    mimeType: string;
    filePath?: string;
    base64?: string;
    size?: number;
    fileName: string;
  };
}

function normalizeArabic(text: string): string {
  return text
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .toLowerCase();
}

const ARABIC_STOPWORDS = new Set([
  'اشرح',
  'شرح',
  'لي',
  'ما',
  'هي',
  'هو',
  'في',
  'من',
  'على',
  'عن',
  'باختصار',
  'كيف',
  'حل',
  'احسب',
  'اوجد',
  'للصف',
  'الصف',
  'درس',
  'كتاب',
]);

function findBestMatchingLesson(input: TutorChatInput): Lesson | null {
  if (input.lesson) return input.lesson;

  const queryWords = normalizeArabic(input.message)
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !ARABIC_STOPWORDS.has(w));

  const eligible = input.allowedLessons.filter(
    (l) => l.gradeId <= input.maxAllowedGradeId
  );
  if (eligible.length === 0) return null;

  let best: Lesson | null = null;
  let bestScore = 0;

  for (const l of eligible) {
    let score = 0;
    if (input.referenceBook && l.bookId === input.referenceBook.id) score += 15;
    if (l.gradeId === input.gradeId) score += 10;

    const titleNorm = normalizeArabic(l.title);
    const bodyNorm = normalizeArabic(
      `${l.theory} ${l.objectives.join(' ')} ${l.formulas.map((f) => `${f.title} ${f.description}`).join(' ')}`
    );

    let keywordHits = 0;
    for (const w of queryWords) {
      if (titleNorm.includes(w)) {
        score += 45;
        keywordHits++;
      } else if (bodyNorm.includes(w)) {
        score += 20;
        keywordHits++;
      }
    }
    if (keywordHits > 0 && score > bestScore) {
      bestScore = score;
      best = l;
    }
  }

  return bestScore >= 35 ? best : null;
}

function buildCurriculumFallbackReply(input: TutorChatInput): string | null {
  const matched = findBestMatchingLesson(input);
  if (!matched) return null;

  const book = input.allowedBooks.find((b) => b.id === matched.bookId);
  const grade = SYRIAN_GRADES.find((g) => g.id === matched.gradeId);

  const lines: string[] = [];
  lines.push(
    `**المرجع المعتمد:** ${book ? book.title : grade?.name ?? `الصف ${matched.gradeId}`} · **${matched.title}** (ص ${matched.pageStart}–${matched.pageEnd})`
  );
  lines.push('');
  lines.push(`### الشرح الأساسي من الكتاب:`);
  lines.push(matched.theory);

  if (matched.formulas.length > 0) {
    lines.push('');
    lines.push(`### القوانين والمبرهنات الأساسية:`);
    for (const f of matched.formulas.slice(0, 3)) {
      lines.push(`- **${f.title}:** $$${f.expression}$$${f.description ? ` (${f.description})` : ''}`);
    }
  }

  if (input.mode === 'generate_practice' && matched.exercises.length > 0) {
    lines.push('');
    lines.push(`### تمارين تدريبية من الدرس:`);
    matched.exercises.slice(0, 3).forEach((ex, idx) => {
      lines.push(`${idx + 1}. **(${ex.difficulty})** ${ex.question}\n   - **تلميح:** ${ex.hint}\n   - **الحل:** ${ex.solution}`);
    });
  } else if (matched.examples.length > 0) {
    const ex = matched.examples[0];
    lines.push('');
    lines.push(`### مثال محلول (${ex.title}):`);
    lines.push(ex.problem);
    ex.steps.forEach((step, idx) => {
      lines.push(`${idx + 1}. ${step}`);
    });
    lines.push(`**النتيجة:** ${ex.answer}`);
  }

  lines.push('');
  lines.push(
    `*(ملاحظة: خدمة الذكاء الاصطناعي تشهد ضغطاً مؤقتاً حالياً، لذا تم استخراج الشرح والأمثلة من فهرس الكتاب المدرسي المعتمد مباشرة).*`
  );
  return lines.join('\n');
}

function buildCurriculumGroundingText(input: TutorChatInput): string {
  const queryWords = normalizeArabic(input.message)
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !ARABIC_STOPWORDS.has(w));

  const scoreLesson = (l: Lesson): number => {
    let score = 0;
    if (l.id === input.lesson?.id) score += 1000;
    if (input.referenceBook && l.bookId === input.referenceBook.id) score += 200;
    if (l.gradeId === input.gradeId) score += 100;
    const hay = normalizeArabic(
      `${l.title} ${l.theory} ${l.formulas.map((f) => f.title).join(' ')}`
    );
    for (const w of queryWords) {
      if (hay.includes(w)) score += 35;
    }
    return score;
  };

  const eligible = input.allowedLessons.filter(
    (l) => l.gradeId <= input.maxAllowedGradeId
  );

  // Top 6 detailed lessons for fast prompt size
  const detailedLessons = [...eligible]
    .sort((a, b) => scoreLesson(b) - scoreLesson(a) || b.gradeId - a.gradeId)
    .slice(0, 6);

  // Compact table of contents for target grade lessons
  const targetToc = eligible
    .filter((l) => l.gradeId === input.gradeId)
    .map((l) => `ص${l.pageStart}-${l.pageEnd}: ${l.title}`)
    .join(' | ');

  const booksSummary = input.allowedBooks
    .filter((b) => b.gradeId <= input.maxAllowedGradeId)
    .sort((a, b) => b.gradeId - a.gradeId)
    .slice(0, 8)
    .map((b) => `- [الصف ${b.gradeId}] ${b.title} (${b.part}): ${b.summary}`)
    .join('\n');

  const lessonsContext = detailedLessons
    .map((l) => {
      const formulas = l.formulas
        .map((f) => `${f.title}: $${f.expression}$`)
        .join(' ؛ ');
      return `• [الصف ${l.gradeId} | ص ${l.pageStart}-${l.pageEnd}] ${l.title}\n  الشرح: ${l.theory}\n  القوانين: ${formulas || 'مفاهيم أساسية'}`;
    })
    .join('\n');

  return `\n[الكتب المعتمدة للطالب (الصف ${input.maxAllowedGradeId} وما قبله)]:\n${booksSummary}${targetToc ? `\n\n[فهرس دروس الصف ${input.gradeId}]: ${targetToc}` : ''}\n\n[أقرب الدروس والقوانين للسؤال]:\n${lessonsContext}`;
}

export async function askSmartTutor(input: TutorChatInput): Promise<{
  reply: string;
  engineNote?: string;
}> {
  const grade =
    SYRIAN_GRADES.find((g) => g.id === input.gradeId) ?? SYRIAN_GRADES[11];
  const maxGrade =
    SYRIAN_GRADES.find((g) => g.id === input.maxAllowedGradeId) ?? grade;

  const engineResult = runMathEngine(input.message);
  let engineNote: string | undefined;
  let engineContext = '';

  if (engineResult?.handled) {
    engineNote = `${engineResult.summary}: ${engineResult.finalAnswer}`;
    engineContext = `\n[نتيجة المحرك الرياضي الدقيق المدمج]:\nالملخص: ${engineResult.summary}\nالخطوات الرياضية المحسوبة: ${engineResult.latexSteps.join(' | ')}\nالنتيجة النهائية الدقيقة: ${engineResult.finalAnswer}\nاعتمد هذه الحسابات الدقيقة في شرحك التربوي ووضّحها للطالب خطوة بخطوة.`;
  }

  const modeInstructions: Record<TutorMode, string> = {
    solve:
      'حل المسألة خطوة بخطوة بوضوح ومنهجية الكتب المدرسية السورية المعتمدة مع ذكر اسم الكتاب/الصف والقانون المستخدم في كل خطوة.',
    explain:
      'اشرح القانون أو النظرية الرياضية بطريقة مبسطة ومرتبة من الكتاب المدرسي مع مثال عددي من مستوى الصف المحدد وما قبله.',
    grade_answer:
      'صحّح إجابة الطالب بدقة. حدد أين أصاب وأين أخطأ بلطف تربوي، واشرح سبب الخطأ وفق قوانين الكتاب المدرسي، ثم اكتب الحل الصحيح.',
    generate_practice:
      'أنشئ 3 تمارين تدريبية متدرجة الصعوبة (أساسي، متوسط، تحدي) مطابقة للكتب المدرسية المعتمدة للصف المحدد وما قبله، مع تلميح مختصر وإجابة نهائية لكل تمرين.',
    matrix_compute:
      'قم بحساب المصفوفة أو الجملة الخطية أو المعادلة خطوة بخطوة مع توضيح المحدد والمنقول والمعكوس وطريقة الحل المناسبة للمنهاج السوري.',
  };

  const lessonContext = input.lesson
    ? `\nالدرس الحالي المختار: "${input.lesson.title}" (الصف ${input.lesson.gradeId}، الصفحات ${input.lesson.pageStart}-${input.lesson.pageEnd}).\nأهداف الدرس: ${input.lesson.objectives.join('، ')}.`
    : '';

  const refBookContext = input.referenceBook
    ? `\nالكتاب المرجعي المختار من قبل الطالب: "${input.referenceBook.title}" (الصف ${input.referenceBook.gradeId}). التزم بالحل من هذا الكتاب ومناهج الصفوف السابقة له عند الحاجة.`
    : '';

  const curriculumGrounding = buildCurriculumGroundingText(input);

  const systemInstruction = `أنت "مدرس الرياضيات الذكي" في منصة «المستشار الرياضي للمنهاج السوري».
قواعد صارمة إلزامية:
1. صف الطالب المسجل هو **${maxGrade.name}** (الصف رقم ${input.maxAllowedGradeId})، والصف المستهدف حالياً هو **${grade.name}** (الصف رقم ${input.gradeId}).
2. يجب أن يكون الحل والشرح مستنداً **حكماً** إلى الكتب المدرسية المعتمدة في المنهاج السوري لصف الطالب (**الصف ${input.maxAllowedGradeId}**) والصفوف **الأدنى/السابقة له فقط** (الصفوف 1 حتى ${input.maxAllowedGradeId}).
3. **ممنوع منعاً باتاً** استخدام قوانين أو نظريات أو طرق حل من صفوف أعلى من الصف ${input.maxAllowedGradeId} (مثلاً لا تستخدم الاشتقاق أو النهايات أو التكامل أو الأعداد العقدية لطالب في الصف التاسع أو العاشر؛ بل حلّ له بطرق الجبر والهندسة والمبرهنات الموجودة في صفه والصفوف السابقة له مثل فيثاغورس وتالس والمميز دلتا).
4. اذكر في بداية أو ثنايا الحل المرجع الدراسي المستخدم (اسم الكتاب/الدرس والصف).
5. المطلوب في هذا الطلب: ${modeInstructions[input.mode]}
6. استخدم اللغة العربية الفصحى التعليمية الواضحة، واكتب جميع الرموز والمعادلات بصيغة LaTeX صحيحة محصورة بين $...$ للسطر أو $$...$$ للمعادلات المستقلة.${lessonContext}${refBookContext}${curriculumGrounding}${engineContext}`;

  const ai = getAiClient();

  const historyText = (input.history ?? [])
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'الطالب' : 'المدرس'}: ${m.content}`)
    .join('\n');

  const promptText = historyText
    ? `سياق المحادثة السابقة:\n${historyText}\n\nسؤال الطالب الحالي:\n${input.message}`
    : input.message;

  const parts: Part[] = [];

  // Attach reference PDF if cached or small; for uncached >15MB PDFs of already-indexed books, warm cache in background so chat responds fast
  if (
    input.referenceBook?.pdfFileName &&
    input.referenceBook.gradeId <= input.maxAllowedGradeId &&
    !input.file
  ) {
    const pdfPath = input.referenceBook.pdfFileName.startsWith('public/')
      ? path.resolve(process.cwd(), input.referenceBook.pdfFileName)
      : path.join(UPLOADS_DIR, input.referenceBook.pdfFileName);
    if (fs.existsSync(pdfPath)) {
      const size = fs.statSync(pdfPath).size;
      const cachedPart = getCachedLargeFilePart(pdfPath, 'application/pdf');
      if (cachedPart) {
        parts.push(cachedPart);
      } else if (size <= INLINE_LIMIT_BYTES) {
        parts.push(
          await buildMediaPart(ai, {
            mimeType: 'application/pdf',
            filePath: pdfPath,
            size,
          })
        );
      } else {
        // Warm cache in background without blocking the student's current question
        void buildMediaPart(ai, {
          mimeType: 'application/pdf',
          filePath: pdfPath,
          size,
        }).catch(() => undefined);
      }
    }
  }

  if (input.file) {
    parts.push(await buildMediaPart(ai, input.file));
  }
  parts.push({
    text:
      promptText.trim() ||
      'اقرأ المسألة الموجودة في الملف المرفق وحلها خطوة بخطوة وفق الكتاب المدرسي.',
  });

  try {
    const response = await generateContentWithFallback(ai, {
      parts,
      systemInstruction,
      thinkingLevel: ThinkingLevel.LOW,
    });

    const reply = response.text?.trim();
    if (!reply) {
      throw new Error('لم يرد نموذج الذكاء الاصطناعي بإجابة نصية.');
    }

    return { reply, engineNote };
  } catch (err) {
    // If deterministic math engine already solved the expression, return verified steps cleanly
    if (engineResult?.handled && !input.file) {
      const stepsFormatted = engineResult.latexSteps
        .map((step, idx) => `${idx + 1}. $${step}$`)
        .join('\n');
      return {
        reply: `**تم الحل عبر المحرك الرياضي المدمج (${grade.name}):**\n\n**${engineResult.summary}**\n\n${stepsFormatted}\n\n**النتيجة النهائية:** $${engineResult.finalAnswer}$\n\n*(ملاحظة: خدمة الشرح التفاعلي تشهد ضغطاً مؤقتاً حالياً، لذا تم تزويدك بالحل الرياضي الدقيق مباشرة).*`,
        engineNote,
      };
    }
    // If transient outage and question matches an indexed textbook lesson, reply directly from the book
    if (isTransientApiError(err) && !input.file) {
      const fallbackReply = buildCurriculumFallbackReply(input);
      if (fallbackReply) {
        return { reply: fallbackReply };
      }
    }
    throw new Error(formatGeminiError(err));
  }
}

export interface ExtractedBookPayload {
  title: string;
  part: string;
  gradeId: number;
  pageCount: number;
  summary: string;
  units: Array<{
    chapterLabel: string;
    title: string;
    description: string;
    pageStart: number;
    pageEnd: number;
    lessons: Array<{
      title: string;
      pageStart: number;
      pageEnd: number;
      objectives: string[];
      theory: string;
      formulas: Array<{ title: string; expression: string; description: string }>;
      examples: Array<{ title: string; problem: string; steps: string[]; answer: string }>;
      exercises: Array<{
        question: string;
        difficulty: 'أساسي' | 'متوسط' | 'تحدي';
        hint: string;
        solution: string;
      }>;
      quiz: Array<{
        question: string;
        options: string[];
        correctIndex: number;
        explanation: string;
      }>;
    }>;
  }>;
}

export async function extractBookFromPdf(params: {
  fileName: string;
  filePath?: string;
  base64Pdf?: string;
  fileSize?: number;
  hintGradeId?: number;
  hintTitle?: string;
  hintSummary?: string;
}): Promise<ExtractedBookPayload> {
  const ai = getAiClient();
  const hasPdf = Boolean(params.filePath || params.base64Pdf);

  const promptText = hasPdf
    ? `قم بتحليل كتاب الرياضيات المرفق بصيغة PDF واسم الملف "${params.fileName}" وفق المنهاج السوري الرسمي.
استخرج:
1. اسم الكتاب والجزء والصف الدراسي المناسب من 1 إلى 12 (إن تعذر الجزم اعتمد ${params.hintGradeId ?? 12}).
2. فهرس الكتاب مقسماً إلى وحدات وفصول ودروس مع أرقام الصفحات التقريبية أو الفعلية.
3. لكل درس استخرج: الأهداف التعليمية، الشرح النظري المركز، القوانين والتعاريف بصيغة LaTeX صحيحة، أمثلة محلولة خطوة بخطوة، تمارين تدريبية مع التلميح والحل، وسؤال اختيار من متعدد.
تأكد من دقة المحتوى العربي والرموز الرياضية بصيغة LaTeX محصورة بين $...$ داخل النصوص، وبدون $ في حقل expression داخل formulas.`
    : `أعد فهرسة وتوليد بنية كتاب رياضيات للمنهاج السوري بعنوان "${params.hintTitle ?? params.fileName}" للصف رقم ${params.hintGradeId ?? 12}.
الملخص المتاح: ${params.hintSummary ?? 'كتاب رياضيات في المنهاج السوري'}.
أنشئ وحدات ودروساً متكاملة مع القوانين (LaTeX) والأمثلة والتمارين والاختبارات وأرقام الصفحات.`;

  const parts: Part[] = [];

  if (hasPdf) {
    parts.push(
      await buildMediaPart(ai, {
        mimeType: 'application/pdf',
        filePath: params.filePath,
        base64: params.base64Pdf,
        size: params.fileSize,
      })
    );
  }
  parts.push({ text: promptText });

  const response = await generateContentWithFallback(ai, {
    parts,
    thinkingLevel: ThinkingLevel.LOW,
    responseMimeType: 'application/json',
    responseSchema: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          part: { type: Type.STRING },
          gradeId: { type: Type.INTEGER },
          pageCount: { type: Type.INTEGER },
          summary: { type: Type.STRING },
          units: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                chapterLabel: { type: Type.STRING },
                title: { type: Type.STRING },
                description: { type: Type.STRING },
                pageStart: { type: Type.INTEGER },
                pageEnd: { type: Type.INTEGER },
                lessons: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      title: { type: Type.STRING },
                      pageStart: { type: Type.INTEGER },
                      pageEnd: { type: Type.INTEGER },
                      objectives: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                      },
                      theory: { type: Type.STRING },
                      formulas: {
                        type: Type.ARRAY,
                        items: {
                          type: Type.OBJECT,
                          properties: {
                            title: { type: Type.STRING },
                            expression: { type: Type.STRING },
                            description: { type: Type.STRING },
                          },
                          required: ['title', 'expression', 'description'],
                        },
                      },
                      examples: {
                        type: Type.ARRAY,
                        items: {
                          type: Type.OBJECT,
                          properties: {
                            title: { type: Type.STRING },
                            problem: { type: Type.STRING },
                            steps: {
                              type: Type.ARRAY,
                              items: { type: Type.STRING },
                            },
                            answer: { type: Type.STRING },
                          },
                          required: ['title', 'problem', 'steps', 'answer'],
                        },
                      },
                      exercises: {
                        type: Type.ARRAY,
                        items: {
                          type: Type.OBJECT,
                          properties: {
                            question: { type: Type.STRING },
                            difficulty: { type: Type.STRING },
                            hint: { type: Type.STRING },
                            solution: { type: Type.STRING },
                          },
                          required: ['question', 'difficulty', 'hint', 'solution'],
                        },
                      },
                      quiz: {
                        type: Type.ARRAY,
                        items: {
                          type: Type.OBJECT,
                          properties: {
                            question: { type: Type.STRING },
                            options: {
                              type: Type.ARRAY,
                              items: { type: Type.STRING },
                            },
                            correctIndex: { type: Type.INTEGER },
                            explanation: { type: Type.STRING },
                          },
                          required: ['question', 'options', 'correctIndex', 'explanation'],
                        },
                      },
                    },
                    required: [
                      'title',
                      'pageStart',
                      'pageEnd',
                      'objectives',
                      'theory',
                      'formulas',
                      'examples',
                      'exercises',
                      'quiz',
                    ],
                  },
                },
              },
              required: ['chapterLabel', 'title', 'description', 'pageStart', 'pageEnd', 'lessons'],
            },
          },
        },
      required: ['title', 'part', 'gradeId', 'pageCount', 'summary', 'units'],
    },
  });

  const text = (response.text ?? '').trim();
  if (!text) {
    throw new Error('تعذر استخراج بنية الكتاب من ملف PDF.');
  }
  return JSON.parse(text) as ExtractedBookPayload;
}
