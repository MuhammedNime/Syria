import React, { useState } from 'react';
import {
  BookOpen,
  CheckCircle2,
  ChevronLeft,
  ClipboardCheck,
  PlayCircle,
  Sparkles,
} from 'lucide-react';
import { GradeWithCounts } from '../lib/api';
import {
  CurriculumBook,
  Lesson,
  StudentLessonProgress,
  Unit,
} from '../types';

interface GradesLessonsViewProps {
  grades: GradeWithCounts[];
  selectedGradeId: number;
  maxAllowedGrade: number;
  onSelectGrade: (gradeId: number) => void;
  books: CurriculumBook[];
  units: Unit[];
  lessons: Lesson[];
  progress: StudentLessonProgress[];
  loading: boolean;
  onOpenLesson: (lessonId: string) => void;
  onAskTutorForLesson: (lesson: Lesson) => void;
}

export function GradesLessonsView({
  grades,
  selectedGradeId,
  maxAllowedGrade,
  onSelectGrade,
  books,
  units,
  lessons,
  progress,
  loading,
  onOpenLesson,
  onAskTutorForLesson,
}: GradesLessonsViewProps) {
  const [selectedBookId, setSelectedBookId] = useState<string>('all');

  const currentGrade = grades.find((g) => g.id === selectedGradeId);
  const completedIds = new Set(
    progress.filter((p) => p.completed).map((p) => p.lessonId)
  );

  const visibleUnits =
    selectedBookId === 'all'
      ? units
      : units.filter((u) => u.bookId === selectedBookId);

  const videosInGrade = lessons.filter((l) => Boolean(l.videoUrl));

  return (
    <div className="space-y-6">
      {/* Header & Strict Grade Filter */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs font-medium text-blue-700 dark:text-sky-400">
              {currentGrade?.stage} ·{' '}
              {maxAllowedGrade < 12
                ? `متاح لك صفك (${grades.find((g) => g.id === maxAllowedGrade)?.shortName}) وما قبله`
                : 'محتوى مخصص للصف المختار فقط'}
            </p>
            <h1 className="mt-1 font-display text-2xl font-bold text-slate-900 dark:text-white">
              {currentGrade?.name}
            </h1>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
              {currentGrade?.description}
            </p>
          </div>

          <div className="shrink-0">
            <label htmlFor="grade-view-selector" className="sr-only">
              تغيير الصف الدراسي
            </label>
            <select
              id="grade-view-selector"
              value={selectedGradeId}
              onChange={(e) => {
                setSelectedBookId('all');
                onSelectGrade(Number(e.target.value));
              }}
              className="min-h-[42px] w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-semibold text-slate-900 outline-none focus:border-blue-600 sm:w-72 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
            >
              {grades.map((g) => (
                <option key={g.id} value={g.id} disabled={g.id > maxAllowedGrade}>
                  {g.name}
                  {g.id > maxAllowedGrade ? ' (مقفل)' : ''}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Quick 1-12 Grade Stepper Buttons */}
        <div className="mt-5 flex flex-wrap gap-1.5 border-t border-slate-100 pt-4 dark:border-slate-800">
          {grades.map((g) => {
            const active = g.id === selectedGradeId;
            const locked = g.id > maxAllowedGrade;
            return (
              <button
                key={g.id}
                type="button"
                disabled={locked}
                title={locked ? 'مقفل: أعلى من صفك الدراسي المسجل' : undefined}
                onClick={() => {
                  setSelectedBookId('all');
                  onSelectGrade(g.id);
                }}
                className={`min-h-[36px] rounded-lg px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-blue-700 text-white dark:bg-blue-600'
                    : locked
                    ? 'cursor-not-allowed bg-slate-100/70 text-slate-400 opacity-50 dark:bg-slate-800/50 dark:text-slate-600'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
                }`}
              >
                {g.shortName}
              </button>
            );
          })}
        </div>
      </div>

      {loading ? (
        <div className="space-y-4">
          {[1, 2].map((n) => (
            <div
              key={n}
              className="h-40 animate-pulse rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
            />
          ))}
        </div>
      ) : (
        <>
          {/* Books Available for This Grade */}
          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white">
                الكتب المتاحة في {currentGrade?.shortName}
              </h2>
              {books.length > 1 && (
                <div className="flex flex-wrap items-center gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
                  <button
                    type="button"
                    onClick={() => setSelectedBookId('all')}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                      selectedBookId === 'all'
                        ? 'bg-white text-blue-700 shadow-xs dark:bg-slate-900 dark:text-sky-400'
                        : 'text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    كل الكتب
                  </button>
                  {books.map((b) => (
                    <button
                      key={b.id}
                      type="button"
                      onClick={() => setSelectedBookId(b.id)}
                      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                        selectedBookId === b.id
                          ? 'bg-white text-blue-700 shadow-xs dark:bg-slate-900 dark:text-sky-400'
                          : 'text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      {b.part}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {books.length === 0 ? (
              <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center dark:border-slate-800 dark:bg-slate-900">
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  لا توجد كتب مضافة لهذا الصف بعد. يمكنك رفع كتاب PDF من المكتبة أو إضافته من لوحة الإدارة.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {books.map((book) => (
                  <div
                    key={book.id}
                    className="flex gap-3.5 sm:gap-4 rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
                  >
                    <img
                      src={
                        book.coverUrl ||
                        '/src/assets/images/book_cover_syrian_math_1795101193959.jpg'
                      }
                      alt={book.title}
                      referrerPolicy="no-referrer"
                      className="h-24 w-16 sm:h-28 sm:w-20 shrink-0 rounded-xl object-cover border border-slate-200 dark:border-slate-700"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-slate-500 tabular-nums dark:text-slate-400">
                        {book.part} · {book.pageCount} صفحة · {book.year}
                      </p>
                      <h3 className="mt-1 font-display text-base font-bold text-slate-900 dark:text-white">
                        {book.title}
                      </h3>
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-600 dark:text-slate-400">
                        {book.summary}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Units & Lessons */}
          <section className="space-y-4">
            <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white">
              الوحدات والفصول والدروس
            </h2>

            {visibleUnits.length === 0 ? (
              <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center dark:border-slate-800 dark:bg-slate-900">
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  لا توجد وحدات مسجلة لهذا الاختيار حالياً.
                </p>
              </div>
            ) : (
              [...visibleUnits]
                .sort((a, b) => a.order - b.order)
                .map((unit) => {
                  const unitLessons = [...lessons]
                    .filter((l) => l.unitId === unit.id)
                    .sort((a, b) => a.order - b.order);
                  const parentBook = books.find((b) => b.id === unit.bookId);

                  return (
                    <div
                      key={unit.id}
                      className="rounded-2xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900"
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 pb-4 dark:border-slate-800">
                        <div>
                          <p className="text-xs font-medium text-blue-700 tabular-nums dark:text-sky-400">
                            {unit.chapterLabel} · {parentBook?.part ?? ''} · الصفحات{' '}
                            {unit.pageStart}–{unit.pageEnd}
                          </p>
                          <h3 className="mt-1 font-display text-xl font-bold text-slate-900 dark:text-white">
                            {unit.title}
                          </h3>
                          {unit.description && (
                            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                              {unit.description}
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="divide-y divide-slate-100 dark:divide-slate-800">
                        {unitLessons.map((lesson, idx) => {
                          const isDone = completedIds.has(lesson.id);
                          const isEx = Boolean(lesson.isUnitExercises);
                          return (
                            <div
                              key={lesson.id}
                              className={`flex flex-col gap-3 py-4 first:pt-4 last:pb-0 sm:flex-row sm:items-center sm:justify-between ${
                                isEx
                                  ? 'mt-2 rounded-xl border border-teal-200/80 bg-teal-50/50 px-4 py-3.5 dark:border-teal-900/60 dark:bg-teal-950/30'
                                  : ''
                              }`}
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  {isEx ? (
                                    <ClipboardCheck className="h-4 w-4 shrink-0 text-teal-700 dark:text-teal-400" />
                                  ) : (
                                    <span className="font-mono text-xs font-semibold text-slate-400 tabular-nums">
                                      {String(idx + 1).padStart(2, '0')}.
                                    </span>
                                  )}
                                  <h4
                                    className={`font-display text-base font-bold ${
                                      isEx
                                        ? 'text-teal-950 dark:text-teal-200'
                                        : 'text-slate-900 dark:text-white'
                                    }`}
                                  >
                                    {lesson.title}
                                  </h4>
                                  {isDone && (
                                    <CheckCircle2
                                      className="h-4 w-4 shrink-0 text-teal-600 dark:text-teal-400"
                                      aria-label="درس منجز"
                                    />
                                  )}
                                </div>
                                <p className="mt-1 text-xs text-slate-500 tabular-nums dark:text-slate-400">
                                  الصفحات {lesson.pageStart}–{lesson.pageEnd} ·{' '}
                                  {lesson.formulas.length} قوانين ·{' '}
                                  {lesson.examples.length} أمثلة ·{' '}
                                  {lesson.exercises.length} تمارين ·{' '}
                                  {lesson.quiz.length} أسئلة اختبار
                                  {lesson.videoUrl ? ' · فيديو شرح متاح' : ''}
                                </p>
                              </div>

                              <div className="flex shrink-0 flex-wrap items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => onAskTutorForLesson(lesson)}
                                  className="inline-flex min-h-[38px] items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:border-teal-400 hover:text-teal-700 whitespace-nowrap dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                                >
                                  <Sparkles className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
                                  <span>اسأل المدرس</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => onOpenLesson(lesson.id)}
                                  className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-xl px-4 py-1.5 text-xs font-semibold text-white transition-colors whitespace-nowrap ${
                                    isEx
                                      ? 'bg-teal-700 hover:bg-teal-800 dark:bg-teal-600 dark:hover:bg-teal-700'
                                      : 'bg-blue-700 hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-700'
                                  }`}
                                >
                                  {isEx ? (
                                    <ClipboardCheck className="h-3.5 w-3.5" />
                                  ) : (
                                    <BookOpen className="h-3.5 w-3.5" />
                                  )}
                                  <span>{isEx ? 'فتح التمرينات' : 'فتح الدرس'}</span>
                                  <ChevronLeft className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })
            )}
          </section>

          {/* Explanatory Videos Section for This Grade */}
          {videosInGrade.length > 0 && (
            <section className="space-y-3">
              <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white">
                فيديوهات الشرح المرتبطة بدروس الصف
              </h2>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {videosInGrade.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => onOpenLesson(l.id)}
                    className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 text-right transition-colors hover:border-blue-300 dark:border-slate-800 dark:bg-slate-900"
                  >
                    <div className="flex items-center gap-3">
                      <PlayCircle className="h-9 w-9 shrink-0 text-blue-700 dark:text-sky-400" />
                      <div>
                        <p className="text-sm font-bold text-slate-900 dark:text-white">
                          {l.videoTitle || l.title}
                        </p>
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          الدرس: {l.title}
                        </p>
                      </div>
                    </div>
                    <ChevronLeft className="h-4 w-4 text-slate-400" />
                  </button>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
