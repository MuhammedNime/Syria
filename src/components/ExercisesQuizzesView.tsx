import React, { useEffect, useState } from 'react';
import {
  BookOpen,
  Bot,
  ChevronDown,
  ChevronUp,
  ClipboardCheck,
} from 'lucide-react';
import { api, GradeWithCounts } from '../lib/api';
import { Lesson } from '../types';
import { MathText } from './MathText';

interface ExercisesQuizzesViewProps {
  grades: GradeWithCounts[];
  selectedGradeId: number;
  maxAllowedGrade: number;
  onSelectGrade: (gradeId: number) => void;
  lessons: Lesson[];
  onOpenLesson: (lessonId: string) => void;
  onAskTutor: (lesson: Lesson) => void;
}

export function ExercisesQuizzesView({
  grades,
  selectedGradeId,
  maxAllowedGrade,
  onSelectGrade,
  lessons,
  onOpenLesson,
  onAskTutor,
}: ExercisesQuizzesViewProps) {
  const [difficultyFilter, setDifficultyFilter] = useState<
    'الكل' | 'أساسي' | 'متوسط' | 'تحدي'
  >('الكل');
  const [scope, setScope] = useState<'current' | 'cumulative'>('current');
  const [cumulativeLessons, setCumulativeLessons] = useState<Lesson[] | null>(null);
  const [loadingCumulative, setLoadingCumulative] = useState(false);

  const [openSolutions, setOpenSolutions] = useState<Record<string, boolean>>({});
  const [quizAnswers, setQuizAnswers] = useState<Record<string, number>>({});
  const [checkedQuizzes, setCheckedQuizzes] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    if (scope !== 'cumulative') {
      setCumulativeLessons(null);
      return;
    }
    setLoadingCumulative(true);
    api
      .getCurriculum(selectedGradeId, true)
      .then((res) => {
        if (!cancelled) {
          setCumulativeLessons(res.lessons);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCumulativeLessons(lessons);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingCumulative(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, selectedGradeId, lessons]);

  const activeGrade = grades.find((g) => g.id === selectedGradeId);
  const sourceLessons =
    scope === 'cumulative' && cumulativeLessons ? cumulativeLessons : lessons;

  const exerciseItems = sourceLessons.flatMap((lesson) =>
    lesson.exercises
      .filter((er) => difficultyFilter === 'الكل' || er.difficulty === difficultyFilter)
      .map((er) => ({ lesson, exercise: er }))
  );

  const quizItems = sourceLessons.flatMap((lesson) =>
    lesson.quiz.map((q) => ({ lesson, quiz: q }))
  );

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs font-medium text-blue-700 dark:text-sky-400">
              {activeGrade?.name}
              {scope === 'cumulative' ? ' والصفوف السابقة' : ''}
            </p>
            <h1 className="mt-1 font-display text-2xl font-bold text-slate-900 dark:text-white">
              بنك التمارين والاختبارات التفاعلية
            </h1>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
              تدرّب على مسائل صفك الدراسي والصفوف السابقة له واختبر فهمك مع التصحيح الفوري.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
            <select
              aria-label="تغيير الصف"
              value={selectedGradeId}
              onChange={(e) => onSelectGrade(Number(e.target.value))}
              className="min-h-[40px] w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 text-sm font-medium text-slate-900 outline-none focus:border-blue-600 sm:w-auto dark:border-slate-700 dark:bg-slate-800 dark:text-white"
            >
              {grades.map((g) => (
                <option key={g.id} value={g.id} disabled={g.id > maxAllowedGrade}>
                  {g.name}
                  {g.id > maxAllowedGrade ? ' (مقفل)' : ''}
                </option>
              ))}
            </select>

            <div className="flex items-center gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
              <button
                type="button"
                onClick={() => setScope('current')}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                  scope === 'current'
                    ? 'bg-white text-blue-700 shadow-xs dark:bg-slate-900 dark:text-sky-400'
                    : 'text-slate-600 dark:text-slate-300'
                }`}
              >
                الصف المختار فقط
              </button>
              <button
                type="button"
                onClick={() => setScope('cumulative')}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                  scope === 'cumulative'
                    ? 'bg-white text-blue-700 shadow-xs dark:bg-slate-900 dark:text-sky-400'
                    : 'text-slate-600 dark:text-slate-300'
                }`}
              >
                {loadingCumulative ? 'جارٍ التحميل...' : 'مع الصفوف السابقة'}
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
              {(['الكل', 'أساسي', 'متوسط', 'تحدي'] as const).map((lvl) => (
                <button
                  key={lvl}
                  type="button"
                  onClick={() => setDifficultyFilter(lvl)}
                  className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap sm:flex-none ${
                    difficultyFilter === lvl
                      ? 'bg-white text-blue-700 shadow-xs dark:bg-slate-900 dark:text-sky-400'
                      : 'text-slate-600 dark:text-slate-300'
                  }`}
                >
                  {lvl}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Interactive Quizzes Section */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-2">
          <ClipboardCheck className="h-5 w-5 text-blue-700 dark:text-sky-400" />
          <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white">
            أسئلة الاختبار السريعة ({quizItems.length})
          </h2>
        </div>

        {quizItems.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
            لا توجد أسئلة اختبار مضافة لهذا الصف بعد.
          </p>
        ) : (
          <div className="mt-4 space-y-5">
            {quizItems.map(({ lesson, quiz }) => {
              const selected = quizAnswers[quiz.id];
              const isChecked = Boolean(checkedQuizzes[quiz.id]);
              return (
                <div
                  key={quiz.id}
                  className="rounded-xl border border-slate-200 p-4 dark:border-slate-800"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 pb-2">
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      من درس: {lesson.title}
                      {scope === 'cumulative'
                        ? ` (${grades.find((g) => g.id === lesson.gradeId)?.shortName || ''})`
                        : ''}
                    </span>
                    <button
                      type="button"
                      onClick={() => onOpenLesson(lesson.id)}
                      className="text-xs font-semibold text-blue-700 hover:underline dark:text-sky-400"
                    >
                      فتح الدرس
                    </button>
                  </div>

                  <div className="font-medium text-slate-900 dark:text-white">
                    <MathText text={quiz.question} />
                  </div>

                  <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {quiz.options.map((opt, idx) => {
                      const isChosen = selected === idx;
                      const isRight = idx === quiz.correctIndex;
                      let cls =
                        'border-slate-200 bg-slate-50 text-slate-800 hover:border-blue-400 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200';
                      if (isChecked) {
                        if (isRight) {
                          cls =
                            'border-teal-500 bg-teal-50 text-teal-900 dark:border-teal-600 dark:bg-teal-950/60 dark:text-teal-200';
                        } else if (isChosen && !isRight) {
                          cls =
                            'border-rose-400 bg-rose-50 text-rose-900 dark:border-rose-700 dark:bg-rose-950/50 dark:text-rose-200';
                        }
                      } else if (isChosen) {
                        cls =
                          'border-blue-600 bg-blue-50 text-blue-900 dark:border-blue-500 dark:bg-blue-950/60 dark:text-sky-200';
                      }

                      return (
                        <button
                          key={idx}
                          type="button"
                          onClick={() => {
                            setQuizAnswers((p) => ({ ...p, [quiz.id]: idx }));
                            setCheckedQuizzes((p) => ({ ...p, [quiz.id]: false }));
                          }}
                          className={`min-h-[40px] rounded-xl border px-3.5 py-2 text-right text-sm transition-colors ${cls}`}
                        >
                          <MathText text={opt} />
                        </button>
                      );
                    })}
                  </div>

                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    <button
                      type="button"
                      disabled={selected === undefined}
                      onClick={() =>
                        setCheckedQuizzes((p) => ({ ...p, [quiz.id]: true }))
                      }
                      className="rounded-lg bg-blue-700 px-3.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-800 disabled:opacity-40 dark:bg-blue-600"
                    >
                      تحقق من الإجابة
                    </button>

                    {isChecked && (
                      <div className="flex-1 text-xs text-slate-600 dark:text-slate-300">
                        <MathText text={quiz.explanation} />
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Exercises Bank */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white">
          التمارين المسائلية ({exerciseItems.length})
        </h2>

        {exerciseItems.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
            لا توجد تمارين ضمن هذا التصنيف.
          </p>
        ) : (
          <div className="mt-4 divide-y divide-slate-100 dark:divide-slate-800">
            {exerciseItems.map(({ lesson, exercise }) => {
              const isOpen = Boolean(openSolutions[exercise.id]);
              return (
                <div key={exercise.id} className="py-4 first:pt-2 last:pb-0">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex-1">
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {lesson.title}
                        {scope === 'cumulative'
                          ? ` (${grades.find((g) => g.id === lesson.gradeId)?.shortName || ''})`
                          : ''}{' '}
                        · المستوى: {exercise.difficulty}
                      </p>
                      <div className="mt-1 text-slate-900 dark:text-slate-100">
                        <MathText text={exercise.question} />
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => onAskTutor(lesson)}
                        className="inline-flex min-h-[36px] items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-teal-400 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                      >
                        <Bot className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
                        <span>اشرح بالذكاء</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => onOpenLesson(lesson.id)}
                        className="inline-flex min-h-[36px] items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-blue-400 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                      >
                        <BookOpen className="h-3.5 w-3.5 text-blue-600 dark:text-sky-400" />
                        <span>الدرس</span>
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setOpenSolutions((prev) => ({
                            ...prev,
                            [exercise.id]: !prev[exercise.id],
                          }))
                        }
                        className="inline-flex min-h-[36px] items-center gap-1.5 rounded-xl bg-blue-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-800 dark:bg-blue-600"
                      >
                        <span>{isOpen ? 'إخفاء الحل' : 'عرض الحل'}</span>
                        {isOpen ? (
                          <ChevronUp className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  </div>

                  {isOpen && (
                    <div className="mt-3 space-y-2 rounded-xl bg-slate-50 p-4 text-sm dark:bg-slate-800/60">
                      <MathText text={`**تلميح:** ${exercise.hint}`} />
                      <div className="border-t border-slate-200 pt-2 dark:border-slate-700">
                        <MathText text={`**الحل:** ${exercise.solution}`} />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
