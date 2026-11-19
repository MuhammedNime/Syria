import 'dotenv/config';
import express, { NextFunction, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import { createServer as createViteServer } from 'vite';
import {
  createAuthToken,
  getDb,
  getSupabaseStatus,
  recordActivity,
  registerUser,
  sanitizeUser,
  saveDb,
  StoredUser,
  UPLOADS_DIR,
  verifyAuthToken,
} from './server/db';
import { askSmartTutor, extractBookFromPdf } from './server/gemini';
import { runMathEngine } from './server/mathEngine';
import { SYRIAN_GRADES } from './server/seedData';
import {
  CurriculumBook,
  Lesson,
  PdfProcessingJob,
  TutorMode,
  Unit,
} from './src/types';

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100MB limit for large PDF textbooks

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    if (!fs.existsSync(UPLOADS_DIR)) {
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    }
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    const safeName = `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    cb(null, safeName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

interface AuthedRequest extends Request {
  user?: StoredUser;
}

function getTokenFromReq(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  return undefined;
}

function attachUser(req: AuthedRequest, _res: Response, next: NextFunction) {
  const token = getTokenFromReq(req);
  if (token) {
    const user = verifyAuthToken(token);
    if (user) {
      req.user = user;
    }
  }
  next();
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({ error: 'يرجى تسجيل الدخول أولاً.' });
    return;
  }
  next();
}

function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({ error: 'يرجى تسجيل الدخول أولاً.' });
    return;
  }
  if (req.user.role !== 'admin') {
    res.status(403).json({ error: 'هذه الصلاحية مخصصة للمشرفين فقط.' });
    return;
  }
  next();
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  // Ensure DB initialized
  getDb();

  app.use(express.json({ limit: '10mb' }));
  app.use(attachUser);

  // Health & Config status
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      geminiConfigured: Boolean(
        process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'
      ),
      ...getSupabaseStatus(),
    });
  });

  // Auth Routes
  app.post('/api/auth/login', (req, res) => {
    const { email, password, gradeId } = req.body as {
      email?: string;
      password?: string;
      gradeId?: number;
    };
    if (!email || !password) {
      res.status(400).json({ error: 'يرجى إدخال البريد الإلكتروني وكلمة المرور.' });
      return;
    }
    const db = getDb();
    const user = db.users.find(
      (u) => u.email.toLowerCase() === email.trim().toLowerCase()
    );
    if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
      res.status(401).json({ error: 'بيانات الدخول غير صحيحة.' });
      return;
    }
    if (gradeId && Number.isInteger(Number(gradeId))) {
      const g = Number(gradeId);
      if (g >= 1 && g <= 12) {
        user.gradeId = g;
        saveDb();
      }
    }
    const token = createAuthToken(user);
    res.json({ user: sanitizeUser(user), token });
  });

  app.post('/api/auth/register', (req, res) => {
    const { name, email, password, gradeId } = req.body as {
      name?: string;
      email?: string;
      password?: string;
      gradeId?: number;
    };
    if (!name || !email || !password || password.length < 6) {
      res
        .status(400)
        .json({ error: 'يرجى تعبئة الاسم والبريد وكلمة مرور لا تقل عن 6 أحرف.' });
      return;
    }
    try {
      const result = registerUser({
        name,
        email,
        password,
        gradeId: Number(gradeId) || 12,
      });
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/api/auth/me', (req: AuthedRequest, res) => {
    if (!req.user) {
      res.json({ user: null });
      return;
    }
    res.json({ user: sanitizeUser(req.user) });
  });

  app.patch('/api/auth/grade', requireAuth, (req: AuthedRequest, res) => {
    const gradeId = Number(req.body?.gradeId);
    if (!Number.isInteger(gradeId) || gradeId < 1 || gradeId > 12) {
      res.status(400).json({ error: 'رقم الصف الدراسي غير صالح.' });
      return;
    }
    req.user!.gradeId = gradeId;
    saveDb();
    res.json({ user: sanitizeUser(req.user!) });
  });

  // Grades & Curriculum Routes (strictly scoped by grade)
  app.get('/api/grades', (_req, res) => {
    const db = getDb();
    const gradesWithCounts = SYRIAN_GRADES.map((g) => ({
      ...g,
      booksCount: db.books.filter((b) => b.gradeId === g.id).length,
      unitsCount: db.units.filter((u) => u.gradeId === g.id).length,
      lessonsCount: db.lessons.filter((l) => l.gradeId === g.id).length,
    }));
    res.json({ grades: gradesWithCounts });
  });

  app.get('/api/curriculum', (req: AuthedRequest, res) => {
    const gradeId = Number(req.query.grade);
    const includePrevious = req.query.includePrevious === 'true';
    const db = getDb();
    if (!Number.isInteger(gradeId) || gradeId < 1 || gradeId > 12) {
      res.status(400).json({ error: 'يرجى تحديد صف دراسي صحيح (1-12).' });
      return;
    }
    if (req.user?.role === 'student' && gradeId > req.user.gradeId) {
      res.status(403).json({
        error: `عذراً، لا يمكنك الوصول لمناهج صف أعلى من صفك الدراسي (${req.user.gradeId}). يمكنك تصفح صفك والصفوف السابقة فقط.`,
      });
      return;
    }

    const grade = SYRIAN_GRADES.find((g) => g.id === gradeId);
    const matchGrade = (itemGrade: number) =>
      includePrevious ? itemGrade <= gradeId : itemGrade === gradeId;

    const books = db.books.filter((b) => matchGrade(b.gradeId));
    const units = db.units
      .filter((u) => matchGrade(u.gradeId))
      .sort((a, b) => b.gradeId - a.gradeId || a.order - b.order);
    const lessons = db.lessons
      .filter((l) => matchGrade(l.gradeId))
      .sort((a, b) => b.gradeId - a.gradeId || a.order - b.order);

    res.json({ grade, books, units, lessons });
  });

  app.get('/api/library/books', (req: AuthedRequest, res) => {
    const gradeParam = req.query.grade ? Number(req.query.grade) : null;
    const query = String(req.query.q ?? '').trim().toLowerCase();
    const maxGrade = req.user?.role === 'student' ? req.user.gradeId : 12;
    const db = getDb();

    let books = db.books.filter((b) => b.gradeId <= maxGrade);
    if (gradeParam && gradeParam >= 1 && gradeParam <= 12) {
      if (gradeParam > maxGrade) {
        res.status(403).json({
          error: `عذراً، يمكن تصفح كتب صفك (${maxGrade}) والصفوف السابقة له فقط.`,
        });
        return;
      }
      books = books.filter((b) => b.gradeId === gradeParam);
    }

    const enrichedBooks = books.map((book) => {
      const units = db.units
        .filter((u) => u.bookId === book.id)
        .sort((a, b) => a.order - b.order);
      const lessons = db.lessons
        .filter((l) => l.bookId === book.id)
        .sort((a, b) => a.order - b.order);
      return { ...book, units, lessons };
    });

    if (!query) {
      res.json({ books: enrichedBooks });
      return;
    }

    const filtered = enrichedBooks.filter((b) => {
      const matchBook =
        b.title.toLowerCase().includes(query) ||
        b.summary.toLowerCase().includes(query) ||
        b.part.toLowerCase().includes(query);
      const matchUnits = b.units.some((u) => u.title.toLowerCase().includes(query));
      const matchLessons = b.lessons.some(
        (l) =>
          l.title.toLowerCase().includes(query) ||
          l.formulas.some((f) => f.title.toLowerCase().includes(query))
      );
      return matchBook || matchUnits || matchLessons;
    });

    res.json({ books: filtered });
  });

  // Download/Stream stored PDF book for internal memory caching
  app.get('/api/library/books/:id/pdf', (req: AuthedRequest, res) => {
    const db = getDb();
    const book = db.books.find((b) => b.id === req.params.id);
    if (!book) {
      res.status(404).json({ error: 'الكتاب غير موجود.' });
      return;
    }
    if (req.user?.role === 'student' && book.gradeId > req.user.gradeId) {
      res.status(403).json({
        error: 'غير مصرح بالوصول إلى كتب صفوف أعلى من صفك الدراسي.',
      });
      return;
    }
    if (!book.pdfFileName) {
      res.status(404).json({ error: 'لا يوجد ملف PDF مرفوع لهذا الكتاب بعد.' });
      return;
    }
    const filePath = book.pdfFileName.startsWith('public/')
      ? path.resolve(process.cwd(), book.pdfFileName)
      : path.join(UPLOADS_DIR, book.pdfFileName);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'ملف PDF غير متوفر على القرص.' });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(book.title)}.pdf"`
    );
    fs.createReadStream(filePath).pipe(res);
  });

  app.get('/api/lessons/:id', (req: AuthedRequest, res) => {
    const db = getDb();
    const lesson = db.lessons.find((l) => l.id === req.params.id);
    if (!lesson) {
      res.status(404).json({ error: 'الدرس غير موجود.' });
      return;
    }
    if (req.user?.role === 'student' && lesson.gradeId > req.user.gradeId) {
      res.status(403).json({
        error: 'عذراً، لا يمكنك فتح دروس صفوف أعلى من صفك الدراسي.',
      });
      return;
    }
    const unit = db.units.find((u) => u.id === lesson.unitId) ?? null;
    const book = db.books.find((b) => b.id === lesson.bookId) ?? null;
    const grade = SYRIAN_GRADES.find((g) => g.id === lesson.gradeId) ?? null;
    const siblingLessons = db.lessons
      .filter((l) => l.unitId === lesson.unitId)
      .sort((a, b) => a.order - b.order);

    res.json({ lesson, unit, book, grade, siblingLessons });
  });

  // Student Progress & Recent Activities
  app.get('/api/progress', (req: AuthedRequest, res) => {
    const db = getDb();
    const userId = req.user?.id ?? 'user-student-1';
    const progress = db.progressByUser[userId] ?? [];
    const activities = db.activitiesByUser[userId] ?? [];
    res.json({ progress, activities, isGuestDemo: !req.user });
  });

  app.post('/api/progress/lesson', (req: AuthedRequest, res) => {
    const { lessonId, completed } = req.body as {
      lessonId?: string;
      completed?: boolean;
    };
    const db = getDb();
    const lesson = db.lessons.find((l) => l.id === lessonId);
    if (!lesson) {
      res.status(404).json({ error: 'الدرس غير موجود.' });
      return;
    }

    if (!req.user) {
      res.json({ ok: true, guest: true });
      return;
    }

    const userId = req.user.id;
    if (!db.progressByUser[userId]) db.progressByUser[userId] = [];
    const list = db.progressByUser[userId];
    const existing = list.find((p) => p.lessonId === lesson.id);
    const now = new Date().toISOString();

    if (existing) {
      existing.lastVisitedAt = now;
      if (typeof completed === 'boolean') {
        existing.completed = completed;
      }
    } else {
      list.unshift({
        lessonId: lesson.id,
        gradeId: lesson.gradeId,
        completed: Boolean(completed),
        lastVisitedAt: now,
      });
    }

    recordActivity(userId, {
      type: 'lesson_view',
      title: completed ? `إتمام دراسة: ${lesson.title}` : `دراسة: ${lesson.title}`,
      subtitle: `الصفحات ${lesson.pageStart}-${lesson.pageEnd}`,
      gradeId: lesson.gradeId,
      lessonId: lesson.id,
    });

    saveDb();
    res.json({ progress: db.progressByUser[userId], activities: db.activitiesByUser[userId] });
  });

  app.post('/api/progress/quiz', (req: AuthedRequest, res) => {
    const { lessonId, answers } = req.body as {
      lessonId?: string;
      answers?: Record<string, number>;
    };
    const db = getDb();
    const lesson = db.lessons.find((l) => l.id === lessonId);
    if (!lesson) {
      res.status(404).json({ error: 'الدرس غير موجود.' });
      return;
    }
    const total = lesson.quiz.length;
    let score = 0;
    const results = lesson.quiz.map((q) => {
      const selected = answers?.[q.id];
      const isCorrect = selected === q.correctIndex;
      if (isCorrect) score++;
      return {
        questionId: q.id,
        selected,
        correctIndex: q.correctIndex,
        isCorrect,
        explanation: q.explanation,
      };
    });

    if (req.user) {
      const userId = req.user.id;
      if (!db.progressByUser[userId]) db.progressByUser[userId] = [];
      const existing = db.progressByUser[userId].find((p) => p.lessonId === lesson.id);
      const now = new Date().toISOString();
      if (existing) {
        existing.quizScore = score;
        existing.quizTotal = total;
        existing.lastVisitedAt = now;
        if (total > 0 && score === total) existing.completed = true;
      } else {
        db.progressByUser[userId].unshift({
          lessonId: lesson.id,
          gradeId: lesson.gradeId,
          completed: total > 0 && score === total,
          quizScore: score,
          quizTotal: total,
          lastVisitedAt: now,
        });
      }
      recordActivity(userId, {
        type: 'quiz_submit',
        title: `تقديم اختبار: ${lesson.title}`,
        subtitle: `النتيجة: ${score} من ${total}`,
        gradeId: lesson.gradeId,
        lessonId: lesson.id,
      });
      saveDb();
    }

    res.json({ score, total, results });
  });

  // Smart Math Tutor Endpoint (Unified Chat + Image/PDF + Matrix/Equation Engine)
  app.post(
    '/api/tutor/chat',
    upload.single('file'),
    async (req: AuthedRequest, res) => {
      try {
        const message = String(req.body.message ?? '');
        const requestedGradeId = Math.min(12, Math.max(1, Number(req.body.gradeId) || 12));
        const maxAllowedGradeId =
          req.user?.role === 'student' ? req.user.gradeId : requestedGradeId;

        if (req.user?.role === 'student' && requestedGradeId > req.user.gradeId) {
          res.status(403).json({
            error: `لا يمكن لطالب الصف ${req.user.gradeId} استخدام مناهج صف أعلى (${requestedGradeId}). يمكنك استخدام مناهج صفك والصفوف السابقة فقط.`,
          });
          return;
        }

        const gradeId = requestedGradeId;
        const lessonId = req.body.lessonId ? String(req.body.lessonId) : undefined;
        const bookId = req.body.bookId ? String(req.body.bookId) : undefined;
        const mode = (req.body.mode as TutorMode) || 'solve';

        let history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
        if (req.body.history) {
          try {
            history = JSON.parse(String(req.body.history));
          } catch {
            history = [];
          }
        }

        const db = getDb();
        const allowedBooks = db.books.filter((b) => b.gradeId <= maxAllowedGradeId);
        const allowedLessons = db.lessons.filter((l) => l.gradeId <= maxAllowedGradeId);
        const lesson = lessonId
          ? allowedLessons.find((l) => l.id === lessonId) ?? null
          : null;
        const referenceBook = bookId
          ? allowedBooks.find((b) => b.id === bookId) ?? null
          : null;

        let filePayload:
          | { mimeType: string; filePath: string; size: number; fileName: string }
          | undefined;
        if (req.file) {
          filePayload = {
            mimeType: req.file.mimetype,
            filePath: req.file.path,
            size: req.file.size,
            fileName: req.file.originalname,
          };
        }

        if (!message.trim() && !filePayload) {
          res.status(400).json({ error: 'يرجى كتابة سؤال أو إرفاق صورة أو ملف PDF.' });
          return;
        }

        const result = await askSmartTutor({
          message,
          gradeId,
          maxAllowedGradeId,
          lesson,
          referenceBook,
          allowedBooks,
          allowedLessons,
          mode,
          history,
          file: filePayload,
        });

        if (req.user) {
          recordActivity(req.user.id, {
            type: 'tutor_question',
            title: `سؤال للمدرس الذكي (${SYRIAN_GRADES.find((g) => g.id === gradeId)?.shortName ?? ''})`,
            subtitle: message.slice(0, 70) || (filePayload ? `ملف: ${filePayload.fileName}` : 'استفسار رياضي'),
            gradeId,
            lessonId,
          });
        }

        res.json(result);
      } catch (err) {
        console.error('Tutor error:', err);
        res.status(500).json({
          error:
            (err as Error).message ||
            'حدث خطأ أثناء التواصل مع مدرس الرياضيات الذكي.',
        });
      } finally {
        if (req.file?.path && fs.existsSync(req.file.path)) {
          try {
            fs.unlinkSync(req.file.path);
          } catch {
            // Ignore temp cleanup failure
          }
        }
      }
    }
  );

  // Deterministic Matrix/Equation Quick Check inside Smart Tutor
  app.post('/api/tutor/engine-check', (req, res) => {
    const expr = String(req.body?.expression ?? '');
    const result = runMathEngine(expr);
    res.json({ result });
  });

  // Upload & Auto-Index PDF Textbook into Syrian Curriculum Library (Admin only)
  app.post(
    '/api/library/upload-pdf',
    requireAdmin,
    upload.single('pdf'),
    async (req: AuthedRequest, res) => {
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'يرجى اختيار ملف كتاب بصيغة PDF.' });
        return;
      }
      if (file.mimetype !== 'application/pdf' && !file.originalname.toLowerCase().endsWith('.pdf')) {
        res.status(400).json({ error: 'يجب أن يكون الملف المرفوع بصيغة PDF.' });
        return;
      }

      const db = getDb();
      const hintGradeId = req.body.gradeId ? Number(req.body.gradeId) : 12;
      const hintTitle = req.body.title ? String(req.body.title) : file.originalname.replace(/\.pdf$/i, '');

      const safeName = file.filename;

      const job: PdfProcessingJob = {
        id: `job-${Date.now()}`,
        bookId: `book-${Date.now()}`,
        fileName: file.originalname,
        gradeId: hintGradeId,
        status: 'processing',
        createdAt: new Date().toISOString(),
        extractedUnitsCount: 0,
        extractedLessonsCount: 0,
        extractedFormulasCount: 0,
        extractedExercisesCount: 0,
      };
      db.processingJobs.unshift(job);
      saveDb();

      try {
        const extracted = await extractBookFromPdf({
          fileName: file.originalname,
          filePath: file.path,
          fileSize: file.size,
          hintGradeId,
          hintTitle,
        });

        const finalGradeId = Math.min(12, Math.max(1, Number(extracted.gradeId) || hintGradeId));
        const bookId = job.bookId;

        const newBook: CurriculumBook = {
          id: bookId,
          gradeId: finalGradeId,
          title: extracted.title || hintTitle,
          part: extracted.part || 'نسخة مرفوعة',
          author: 'مستخرج تلقائياً من PDF',
          year: '2025 - 2026',
          pageCount: extracted.pageCount || 120,
          coverUrl: '/src/assets/images/book_cover_syrian_math_1795101193959.jpg',
          pdfFileName: safeName,
          isIndexed: true,
          indexedAt: new Date().toISOString(),
          summary: extracted.summary || 'كتاب رياضيات مفهرس تلقائياً.',
        };

        const createdUnits: Unit[] = [];
        const createdLessons: Lesson[] = [];
        let formulasCount = 0;
        let exercisesCount = 0;

        extracted.units.forEach((u, uIdx) => {
          const unitId = `u-${bookId}-${uIdx + 1}`;
          createdUnits.push({
            id: unitId,
            bookId,
            gradeId: finalGradeId,
            order: uIdx + 1,
            chapterLabel: u.chapterLabel || `الوحدة ${uIdx + 1}`,
            title: u.title,
            description: u.description || '',
            pageStart: u.pageStart || 1,
            pageEnd: u.pageEnd || 40,
          });

          u.lessons.forEach((l, lIdx) => {
            const lessonId = `l-${bookId}-${uIdx + 1}-${lIdx + 1}`;
            const formulas = (l.formulas ?? []).map((f, fIdx) => ({
              id: `f-${lessonId}-${fIdx}`,
              title: f.title,
              expression: f.expression,
              description: f.description,
            }));
            const examples = (l.examples ?? []).map((e, eIdx) => ({
              id: `ex-${lessonId}-${eIdx}`,
              title: e.title,
              problem: e.problem,
              steps: e.steps ?? [],
              answer: e.answer,
            }));
            const exercises = (l.exercises ?? []).map((er, erIdx) => ({
              id: `er-${lessonId}-${erIdx}`,
              question: er.question,
              difficulty: (['أساسي', 'متوسط', 'تحدي'].includes(er.difficulty)
                ? er.difficulty
                : 'متوسط') as 'أساسي' | 'متوسط' | 'تحدي',
              hint: er.hint,
              solution: er.solution,
            }));
            const quiz = (l.quiz ?? []).map((q, qIdx) => ({
              id: `q-${lessonId}-${qIdx}`,
              question: q.question,
              options: q.options ?? [],
              correctIndex: Number(q.correctIndex) || 0,
              explanation: q.explanation,
            }));

            formulasCount += formulas.length;
            exercisesCount += exercises.length;

            createdLessons.push({
              id: lessonId,
              unitId,
              bookId,
              gradeId: finalGradeId,
              order: lIdx + 1,
              title: l.title,
              pageStart: l.pageStart || u.pageStart || 1,
              pageEnd: l.pageEnd || u.pageEnd || 10,
              durationMinutes: 40,
              objectives: l.objectives ?? [],
              theory: l.theory || '',
              formulas,
              examples,
              exercises,
              quiz,
            });
          });
        });

        db.books.unshift(newBook);
        db.units.push(...createdUnits);
        db.lessons.push(...createdLessons);

        job.gradeId = finalGradeId;
        job.status = 'completed';
        job.completedAt = new Date().toISOString();
        job.extractedUnitsCount = createdUnits.length;
        job.extractedLessonsCount = createdLessons.length;
        job.extractedFormulasCount = formulasCount;
        job.extractedExercisesCount = exercisesCount;
        job.rawSummary = newBook.summary;

        recordActivity(req.user!.id, {
          type: 'book_upload',
          title: `رفع وفهرسة كتاب: ${newBook.title}`,
          subtitle: `استخراج ${createdUnits.length} وحدات و ${createdLessons.length} دروس`,
          gradeId: finalGradeId,
        });

        saveDb();
        res.status(201).json({
          book: newBook,
          units: createdUnits,
          lessons: createdLessons,
          job,
        });
      } catch (err) {
        job.status = 'failed';
        job.completedAt = new Date().toISOString();
        job.errorMessage = (err as Error).message;
        saveDb();
        res.status(500).json({ error: (err as Error).message, job });
      }
    }
  );

  // Admin Console Routes
  app.get('/api/admin/overview', requireAdmin, (_req, res) => {
    const db = getDb();
    res.json({
      books: db.books,
      units: db.units,
      lessons: db.lessons,
      jobs: db.processingJobs,
      usersCount: db.users.length,
    });
  });

  app.post('/api/admin/books', requireAdmin, (req, res) => {
    const db = getDb();
    const body = req.body as Partial<CurriculumBook>;
    if (!body.title || !body.gradeId) {
      res.status(400).json({ error: 'اسم الكتاب والصف الدراسي مطلوبان.' });
      return;
    }
    const newBook: CurriculumBook = {
      id: `book-${Date.now()}`,
      gradeId: Number(body.gradeId),
      title: body.title,
      part: body.part || 'كتاب الطالب',
      author: body.author || 'وزارة التربية - سوريا',
      year: body.year || '2025 - 2026',
      pageCount: Number(body.pageCount) || 180,
      coverUrl: '/src/assets/images/book_cover_syrian_math_1795101193959.jpg',
      isIndexed: true,
      indexedAt: new Date().toISOString(),
      summary: body.summary || '',
    };
    db.books.unshift(newBook);
    saveDb();
    res.status(201).json({ book: newBook });
  });

  app.put('/api/admin/books/:id', requireAdmin, (req, res) => {
    const db = getDb();
    const idx = db.books.findIndex((b) => b.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'الكتاب غير موجود.' });
      return;
    }
    const prev = db.books[idx];
    const updated: CurriculumBook = {
      ...prev,
      ...req.body,
      id: prev.id,
      gradeId: Number(req.body.gradeId ?? prev.gradeId),
      pageCount: Number(req.body.pageCount ?? prev.pageCount),
    };
    db.books[idx] = updated;
    // Sync gradeId on child units & lessons if grade changed
    if (updated.gradeId !== prev.gradeId) {
      db.units.forEach((u) => {
        if (u.bookId === updated.id) u.gradeId = updated.gradeId;
      });
      db.lessons.forEach((l) => {
        if (l.bookId === updated.id) l.gradeId = updated.gradeId;
      });
    }
    saveDb();
    res.json({ book: updated });
  });

  app.delete('/api/admin/books/:id', requireAdmin, (req, res) => {
    const db = getDb();
    const id = req.params.id;
    db.books = db.books.filter((b) => b.id !== id);
    db.units = db.units.filter((u) => u.bookId !== id);
    db.lessons = db.lessons.filter((l) => l.bookId !== id);
    saveDb();
    res.json({ ok: true });
  });

  app.post('/api/admin/books/:id/reindex', requireAdmin, async (req, res) => {
    const db = getDb();
    const book = db.books.find((b) => b.id === req.params.id);
    if (!book) {
      res.status(404).json({ error: 'الكتاب غير موجود.' });
      return;
    }

    let filePath: string | undefined;
    let fileSize: number | undefined;
    if (book.pdfFileName) {
      const candidatePath = path.join(UPLOADS_DIR, book.pdfFileName);
      if (fs.existsSync(candidatePath)) {
        filePath = candidatePath;
        fileSize = fs.statSync(candidatePath).size;
      }
    }

    const job: PdfProcessingJob = {
      id: `job-reindex-${Date.now()}`,
      bookId: book.id,
      fileName: book.pdfFileName ?? `${book.title}.pdf`,
      gradeId: book.gradeId,
      status: 'processing',
      createdAt: new Date().toISOString(),
      extractedUnitsCount: 0,
      extractedLessonsCount: 0,
      extractedFormulasCount: 0,
      extractedExercisesCount: 0,
    };
    db.processingJobs.unshift(job);
    saveDb();

    try {
      const extracted = await extractBookFromPdf({
        fileName: book.title,
        filePath,
        fileSize,
        hintGradeId: book.gradeId,
        hintTitle: book.title,
        hintSummary: book.summary,
      });

      // Replace existing units & lessons for this book with fresh extraction
      db.units = db.units.filter((u) => u.bookId !== book.id);
      db.lessons = db.lessons.filter((l) => l.bookId !== book.id);

      let formulasCount = 0;
      let exercisesCount = 0;
      const newUnits: Unit[] = [];
      const newLessons: Lesson[] = [];

      extracted.units.forEach((u, uIdx) => {
        const unitId = `u-${book.id}-${Date.now()}-${uIdx}`;
        newUnits.push({
          id: unitId,
          bookId: book.id,
          gradeId: book.gradeId,
          order: uIdx + 1,
          chapterLabel: u.chapterLabel || `الوحدة ${uIdx + 1}`,
          title: u.title,
          description: u.description || '',
          pageStart: u.pageStart || 1,
          pageEnd: u.pageEnd || 40,
        });

        u.lessons.forEach((l, lIdx) => {
          const lessonId = `l-${book.id}-${Date.now()}-${uIdx}-${lIdx}`;
          const formulas = (l.formulas ?? []).map((f, fi) => ({
            id: `f-${lessonId}-${fi}`,
            ...f,
          }));
          const examples = (l.examples ?? []).map((e, ei) => ({
            id: `ex-${lessonId}-${ei}`,
            ...e,
          }));
          const exercises = (l.exercises ?? []).map((er, eri) => ({
            id: `er-${lessonId}-${eri}`,
            ...er,
            difficulty: (['أساسي', 'متوسط', 'تحدي'].includes(er.difficulty)
              ? er.difficulty
              : 'متوسط') as 'أساسي' | 'متوسط' | 'تحدي',
          }));
          const quiz = (l.quiz ?? []).map((q, qi) => ({
            id: `q-${lessonId}-${qi}`,
            ...q,
          }));

          formulasCount += formulas.length;
          exercisesCount += exercises.length;

          newLessons.push({
            id: lessonId,
            unitId,
            bookId: book.id,
            gradeId: book.gradeId,
            order: lIdx + 1,
            title: l.title,
            pageStart: l.pageStart || 1,
            pageEnd: l.pageEnd || 12,
            durationMinutes: 45,
            objectives: l.objectives ?? [],
            theory: l.theory || '',
            formulas,
            examples,
            exercises,
            quiz,
          });
        });
      });

      db.units.push(...newUnits);
      db.lessons.push(...newLessons);
      book.isIndexed = true;
      book.indexedAt = new Date().toISOString();
      if (extracted.summary) book.summary = extracted.summary;

      job.status = 'completed';
      job.completedAt = new Date().toISOString();
      job.extractedUnitsCount = newUnits.length;
      job.extractedLessonsCount = newLessons.length;
      job.extractedFormulasCount = formulasCount;
      job.extractedExercisesCount = exercisesCount;
      job.rawSummary = `إعادة فهرسة ناجحة: ${newUnits.length} وحدات و ${newLessons.length} دروس.`;

      saveDb();
      res.json({ book, units: newUnits, lessons: newLessons, job });
    } catch (err) {
      job.status = 'failed';
      job.completedAt = new Date().toISOString();
      job.errorMessage = (err as Error).message;
      saveDb();
      res.status(500).json({ error: (err as Error).message, job });
    }
  });

  app.post('/api/admin/units', requireAdmin, (req, res) => {
    const db = getDb();
    const body = req.body as Partial<Unit>;
    if (!body.bookId || !body.title) {
      res.status(400).json({ error: 'الكتاب وعنوان الوحدة مطلوبان.' });
      return;
    }
    const book = db.books.find((b) => b.id === body.bookId);
    if (!book) {
      res.status(404).json({ error: 'الكتاب غير موجود.' });
      return;
    }
    const newUnit: Unit = {
      id: `u-${Date.now()}`,
      bookId: book.id,
      gradeId: book.gradeId,
      order: Number(body.order) || db.units.filter((u) => u.bookId === book.id).length + 1,
      chapterLabel: body.chapterLabel || 'وحدة جديدة',
      title: body.title,
      description: body.description || '',
      pageStart: Number(body.pageStart) || 1,
      pageEnd: Number(body.pageEnd) || 30,
    };
    db.units.push(newUnit);
    saveDb();
    res.status(201).json({ unit: newUnit });
  });

  app.put('/api/admin/units/:id', requireAdmin, (req, res) => {
    const db = getDb();
    const idx = db.units.findIndex((u) => u.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'الوحدة غير موجودة.' });
      return;
    }
    db.units[idx] = { ...db.units[idx], ...req.body, id: db.units[idx].id };
    saveDb();
    res.json({ unit: db.units[idx] });
  });

  app.delete('/api/admin/units/:id', requireAdmin, (req, res) => {
    const db = getDb();
    const id = req.params.id;
    db.units = db.units.filter((u) => u.id !== id);
    db.lessons = db.lessons.filter((l) => l.unitId !== id);
    saveDb();
    res.json({ ok: true });
  });

  app.post('/api/admin/lessons', requireAdmin, (req, res) => {
    const db = getDb();
    const body = req.body as Partial<Lesson>;
    if (!body.unitId || !body.title) {
      res.status(400).json({ error: 'الوحدة وعنوان الدرس مطلوبان.' });
      return;
    }
    const unit = db.units.find((u) => u.id === body.unitId);
    if (!unit) {
      res.status(404).json({ error: 'الوحدة غير موجودة.' });
      return;
    }
    const newLesson: Lesson = {
      id: `l-${Date.now()}`,
      unitId: unit.id,
      bookId: unit.bookId,
      gradeId: unit.gradeId,
      order: Number(body.order) || db.lessons.filter((l) => l.unitId === unit.id).length + 1,
      title: body.title,
      pageStart: Number(body.pageStart) || unit.pageStart,
      pageEnd: Number(body.pageEnd) || unit.pageStart + 10,
      durationMinutes: Number(body.durationMinutes) || 40,
      objectives: body.objectives ?? ['فهم المفاهيم الأساسية في الدرس.'],
      theory: body.theory || 'شرح نظري للدرس.',
      formulas: body.formulas ?? [],
      examples: body.examples ?? [],
      exercises: body.exercises ?? [],
      quiz: body.quiz ?? [],
      videoUrl: body.videoUrl || undefined,
      videoTitle: body.videoTitle || undefined,
    };
    db.lessons.push(newLesson);
    saveDb();
    res.status(201).json({ lesson: newLesson });
  });

  app.put('/api/admin/lessons/:id', requireAdmin, (req, res) => {
    const db = getDb();
    const idx = db.lessons.findIndex((l) => l.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'الدرس غير موجود.' });
      return;
    }
    db.lessons[idx] = { ...db.lessons[idx], ...req.body, id: db.lessons[idx].id };
    saveDb();
    res.json({ lesson: db.lessons[idx] });
  });

  app.delete('/api/admin/lessons/:id', requireAdmin, (req, res) => {
    const db = getDb();
    db.lessons = db.lessons.filter((l) => l.id !== req.params.id);
    saveDb();
    res.json({ ok: true });
  });

  // Graceful Upload / API Error Handler (prevents unhandled MulterError)
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({
          error: 'حجم الملف يتجاوز الحد الأقصى المسموح به (100 ميغابايت).',
        });
        return;
      }
      res.status(400).json({ error: `تعذر رفع الملف: ${err.message}` });
      return;
    }
    res.status(500).json({
      error: (err as Error)?.message || 'حدث خطأ غير متوقع في الخادم.',
    });
  });

  // Vite middleware in dev, static dist in production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Syrian Math Advisor server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
