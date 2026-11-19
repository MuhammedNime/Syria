import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  Calculator,
  FileText,
  GraduationCap,
  Image as ImageIcon,
  Layers,
  ListChecks,
  Paperclip,
  Send,
  Trash2,
  X,
} from 'lucide-react';
import { api, EnrichedBook, GradeWithCounts } from '../lib/api';
import { Lesson, TutorMessage, TutorMode } from '../types';
import { MathText } from './MathText';

interface SmartTutorViewProps {
  grades: GradeWithCounts[];
  selectedGradeId: number;
  maxAllowedGrade: number;
  onSelectGrade: (gradeId: number) => void;
  initialLessonId?: string;
  gradeLessons: Lesson[];
}

const TUTOR_MODES: Array<{ id: TutorMode; label: string; hint: string }> = [
  { id: 'solve', label: 'حل خطوة بخطوة', hint: 'اكتب نص المسألة أو أرفق صورة / PDF' },
  { id: 'explain', label: 'شرح القوانين', hint: 'اسأل عن أي نظرية أو قانون في المنهاج' },
  { id: 'grade_answer', label: 'تصحيح إجابتي', hint: 'اكتب سؤالك وإجابتك لنصححها ونوضح الأخطاء' },
  { id: 'generate_practice', label: 'تمارين مشابهة', hint: 'أدخل مثالاً لنولد لك تمارين تدريبية مطابقة' },
  { id: 'matrix_compute', label: 'مصفوفات ومعادلات', hint: 'مثال: [[2,1],[5,3]] أو x^2 - 5x + 6 = 0' },
];

export function SmartTutorView({
  grades,
  selectedGradeId,
  maxAllowedGrade,
  onSelectGrade,
  initialLessonId,
  gradeLessons,
}: SmartTutorViewProps) {
  const [mode, setMode] = useState<TutorMode>('solve');
  const [bookId, setBookId] = useState<string>('');
  const [unitId, setUnitId] = useState<string>('');
  const [availableBooks, setAvailableBooks] = useState<EnrichedBook[]>([]);
  const [lessonId, setLessonId] = useState<string>(initialLessonId || '');
  const [input, setInput] = useState('');
  const [attachment, setAttachment] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [messages, setMessages] = useState<TutorMessage[]>([
    {
      id: 'welcome-msg',
      role: 'assistant',
      content:
        'أهلاً بك! أنا **مدرس الرياضيات الذكي** المخصص للمنهاج السوري. ألتزم بحل المسائل وشرح القوانين استناداً إلى كتب صفك الدراسي والصفوف السابقة له فقط. اختر الصف والكتاب والوحدة والدرس من الأعلى أو أرفق صورة أو ملف PDF وسأساعدك خطوة بخطوة.',
      createdAt: new Date().toISOString(),
    },
  ]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const endOfChatRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getLibraryBooks()
      .then((res) => {
        if (!cancelled) {
          const cap = Math.min(selectedGradeId, maxAllowedGrade);
          const allowed = res.books
            .filter((b) => b.gradeId <= cap)
            .sort((a, b) => {
              if (a.gradeId === selectedGradeId && b.gradeId !== selectedGradeId) return -1;
              if (b.gradeId === selectedGradeId && a.gradeId !== selectedGradeId) return 1;
              return b.gradeId - a.gradeId;
            });
          setAvailableBooks(allowed);
          if (bookId && !allowed.some((b) => b.id === bookId)) {
            setBookId('');
            setUnitId('');
            setLessonId('');
          }
        }
      })
      .catch(() => {
        // Ignore transient book list errors
      });
    return () => {
      cancelled = true;
    };
  }, [selectedGradeId, maxAllowedGrade]);

  // Sync initialLessonId -> bookId, unitId, lessonId when books load
  useEffect(() => {
    if (!initialLessonId) return;
    setLessonId(initialLessonId);
    for (const b of availableBooks) {
      const found = b.lessons.find((l) => l.id === initialLessonId);
      if (found) {
        setBookId(b.id);
        setUnitId(found.unitId);
        return;
      }
    }
  }, [initialLessonId, availableBooks]);

  const selectedBook = useMemo(
    () => availableBooks.find((b) => b.id === bookId) ?? null,
    [availableBooks, bookId]
  );

  // Units cascade directly from the chosen book (or current grade's books if "تلقائي")
  const selectableUnits = useMemo(() => {
    if (selectedBook) {
      return [...selectedBook.units].sort((a, b) => a.order - b.order);
    }
    const gradeBooks = availableBooks.filter((b) => b.gradeId === selectedGradeId);
    const sourceBooks = gradeBooks.length > 0 ? gradeBooks : availableBooks;
    return sourceBooks.flatMap((b) =>
      [...b.units].sort((a, b2) => a.order - b2.order)
    );
  }, [selectedBook, availableBooks, selectedGradeId]);

  const selectedUnit = useMemo(
    () => selectableUnits.find((u) => u.id === unitId) ?? null,
    [selectableUnits, unitId]
  );

  // Lessons cascade from the chosen unit -> else chosen book -> else gradeLessons
  const selectableLessons = useMemo(() => {
    if (selectedUnit) {
      const parentBook = availableBooks.find((b) => b.id === selectedUnit.bookId);
      const pool = parentBook ? parentBook.lessons : gradeLessons;
      return [...pool]
        .filter((l) => l.unitId === selectedUnit.id)
        .sort((a, b) => a.order - b.order);
    }
    if (selectedBook) {
      const unitOrder = new Map(selectedBook.units.map((u) => [u.id, u.order]));
      return [...selectedBook.lessons].sort((a, b) => {
        const uDiff = (unitOrder.get(a.unitId) ?? 0) - (unitOrder.get(b.unitId) ?? 0);
        return uDiff !== 0 ? uDiff : a.order - b.order;
      });
    }
    return [...gradeLessons].sort((a, b) => a.order - b.order);
  }, [selectedUnit, selectedBook, availableBooks, gradeLessons]);

  useEffect(() => {
    if (unitId && !selectableUnits.some((u) => u.id === unitId)) {
      setUnitId('');
    }
  }, [selectableUnits, unitId]);

  useEffect(() => {
    if (lessonId && !selectableLessons.some((l) => l.id === lessonId)) {
      setLessonId('');
    }
  }, [selectableLessons, lessonId]);

  useEffect(() => {
    endOfChatRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  const activeGrade = grades.find((g) => g.id === selectedGradeId);
  const activeLesson = selectableLessons.find((l) => l.id === lessonId) ?? null;

  async function handleSend(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if ((!input.trim() && !attachment) || sending) return;

    setError(null);
    const currentText = input.trim();
    const currentFile = attachment;

    const userMsg: TutorMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content:
        currentText ||
        (currentFile ? `مرفق للتحليل والحل: ${currentFile.name}` : ''),
      attachmentName: currentFile?.name,
      attachmentType: currentFile
        ? currentFile.type.includes('pdf')
          ? 'pdf'
          : 'image'
        : undefined,
      createdAt: new Date().toISOString(),
    };

    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setInput('');
    setAttachment(null);
    setSending(true);

    try {
      const res = await api.askTutor({
        message: currentText,
        gradeId: selectedGradeId,
        lessonId: lessonId || undefined,
        bookId: bookId || undefined,
        mode,
        history: nextMessages.slice(-6).map((m) => ({
          role: m.role,
          content: m.content,
        })),
        file: currentFile,
      });

      const botMsg: TutorMessage = {
        id: `a-${Date.now()}`,
        role: 'assistant',
        content: res.reply,
        engineNote: res.engineNote,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, botMsg]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  function insertTemplate(snippet: string, targetMode: TutorMode) {
    setMode(targetMode);
    setInput(snippet);
  }

  return (
    <div className="flex h-[calc(100dvh-6.25rem)] min-h-[460px] flex-col rounded-2xl border border-slate-200 bg-white sm:h-[calc(100dvh-7.5rem)] lg:h-[calc(100vh-8.5rem)] dark:border-slate-800 dark:bg-slate-900">
      {/* Top Tutor Context Bar */}
      <div className="border-b border-slate-200 p-3.5 sm:px-6 sm:py-4 dark:border-slate-800">
        {/* Title Row + Clear Chat Button */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <img
              src="/src/assets/images/tutor_avatar_emblem_1795101194119.jpg"
              alt="شعار مدرس الرياضيات الذكي"
              referrerPolicy="no-referrer"
              className="h-10 w-10 sm:h-11 sm:w-11 shrink-0 rounded-xl border border-slate-200 object-cover dark:border-slate-700"
            />
            <div className="min-w-0">
              <h1 className="truncate font-display text-base sm:text-lg font-bold text-slate-900 dark:text-white">
                مدرس الرياضيات الذكي
              </h1>
              <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                منهج {activeGrade?.name} وما قبله
                {selectedBook ? ` · ${selectedBook.title}` : ''}
                {selectedUnit ? ` · ${selectedUnit.chapterLabel}: ${selectedUnit.title}` : ''}
                {activeLesson ? ` · ${activeLesson.title}` : ''}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() =>
              setMessages([
                {
                  id: `welcome-${Date.now()}`,
                  role: 'assistant',
                  content:
                    'تم بدء جلسة محادثة جديدة. اختر الكتاب والوحدة والدرس أو اكتب سؤالك مباشرة أو أرفق صورة المسألة وسأساعدك خطوة بخطوة.',
                  createdAt: new Date().toISOString(),
                },
              ])
            }
            title="بدء محادثة جديدة"
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-3 text-xs font-medium text-slate-600 transition-colors hover:border-rose-300 hover:text-rose-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">محادثة جديدة</span>
          </button>
        </div>

        {/* Organized 4-Step Cascading Context Panel: Grade -> Book -> Unit -> Lesson */}
        <div className="mt-3 rounded-xl border border-slate-200/80 bg-slate-50/70 p-2.5 dark:border-slate-800 dark:bg-slate-800/40">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {/* 1. Grade */}
            <label className="flex flex-col gap-1 min-w-0">
              <span className="flex items-center gap-1 text-[11px] font-semibold text-slate-600 dark:text-slate-400">
                <GraduationCap className="h-3.5 w-3.5 text-blue-700 dark:text-sky-400" />
                <span>1. الصف الدراسي</span>
              </span>
              <select
                aria-label="اختر الصف الدراسي"
                value={selectedGradeId}
                onChange={(e) => {
                  const nextGrade = Number(e.target.value);
                  setBookId('');
                  setUnitId('');
                  setLessonId('');
                  onSelectGrade(nextGrade);
                }}
                className="min-h-[38px] w-full rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-900 outline-none transition-colors focus:border-blue-600 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
              >
                {grades.map((g) => (
                  <option key={g.id} value={g.id} disabled={g.id > maxAllowedGrade}>
                    {g.name}
                    {g.id > maxAllowedGrade ? ' (مقفل)' : ''}
                  </option>
                ))}
              </select>
            </label>

            {/* 2. Book */}
            <label className="flex flex-col gap-1 min-w-0">
              <span className="flex items-center gap-1 text-[11px] font-semibold text-slate-600 dark:text-slate-400">
                <BookOpen className="h-3.5 w-3.5 text-blue-700 dark:text-sky-400" />
                <span>2. الكتاب المرجعي</span>
              </span>
              <select
                aria-label="اختر الكتاب المرجعي"
                value={bookId}
                onChange={(e) => {
                  setBookId(e.target.value);
                  setUnitId('');
                  setLessonId('');
                }}
                className="min-h-[38px] w-full rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-900 outline-none transition-colors focus:border-blue-600 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
              >
                <option value="">كل كتب الصف وما قبله (تلقائي)</option>
                {availableBooks.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.title} ({grades.find((g) => g.id === b.gradeId)?.shortName})
                  </option>
                ))}
              </select>
            </label>

            {/* 3. Unit */}
            <label className="flex flex-col gap-1 min-w-0">
              <span className="flex items-center gap-1 text-[11px] font-semibold text-slate-600 dark:text-slate-400">
                <Layers className="h-3.5 w-3.5 text-teal-700 dark:text-teal-400" />
                <span>3. الوحدة</span>
              </span>
              <select
                aria-label="اختر الوحدة"
                value={unitId}
                onChange={(e) => {
                  const chosenUnitId = e.target.value;
                  setUnitId(chosenUnitId);
                  setLessonId('');
                  if (chosenUnitId && !bookId) {
                    const matched = selectableUnits.find((u) => u.id === chosenUnitId);
                    if (matched) setBookId(matched.bookId);
                  }
                }}
                disabled={selectableUnits.length === 0}
                className="min-h-[38px] w-full rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-900 outline-none transition-colors focus:border-blue-600 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
              >
                <option value="">
                  {selectedBook
                    ? `كل وحدات الكتاب (${selectableUnits.length})`
                    : selectableUnits.length > 0
                    ? 'اختر وحدة أو كل الوحدات'
                    : 'اختر كتاباً مفهرساً أولاً'}
                </option>
                {selectableUnits.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.chapterLabel}: {u.title}
                  </option>
                ))}
              </select>
            </label>

            {/* 4. Lesson / Unit Exercises */}
            <label className="flex flex-col gap-1 min-w-0">
              <span className="flex items-center gap-1 text-[11px] font-semibold text-slate-600 dark:text-slate-400">
                <ListChecks className="h-3.5 w-3.5 text-teal-700 dark:text-teal-400" />
                <span>4. الدرس أو تمرينات الوحدة</span>
              </span>
              <select
                aria-label="اختر الدرس أو تمرينات الوحدة"
                value={lessonId}
                onChange={(e) => {
                  const chosenLessonId = e.target.value;
                  setLessonId(chosenLessonId);
                  if (chosenLessonId) {
                    const matchedLesson = selectableLessons.find(
                      (l) => l.id === chosenLessonId
                    );
                    if (matchedLesson) {
                      if (!bookId) setBookId(matchedLesson.bookId);
                      if (!unitId) setUnitId(matchedLesson.unitId);
                    }
                  }
                }}
                disabled={selectableLessons.length === 0}
                className="min-h-[38px] w-full rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-900 outline-none transition-colors focus:border-blue-600 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
              >
                <option value="">
                  {selectedUnit
                    ? `كل محتوى الوحدة (${selectableLessons.length})`
                    : selectedBook
                    ? `كل دروس الكتاب (${selectableLessons.length})`
                    : 'كل دروس الصف (عام)'}
                </option>
                {selectableLessons.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.isUnitExercises ? `★ ${l.title}` : l.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {/* Mode Segmented Buttons */}
        <div className="mt-3 flex items-center gap-1.5 overflow-x-auto pb-1">
          {TUTOR_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setMode(m.id)}
              className={`min-h-[34px] shrink-0 rounded-lg px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
                mode === m.id
                  ? 'bg-blue-700 text-white dark:bg-blue-600'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* Chat Messages Viewport */}
      <div className="flex-1 space-y-4 overflow-y-auto p-3.5 sm:space-y-5 sm:p-6">
        {messages.map((msg) => {
          const isUser = msg.role === 'user';
          return (
            <div
              key={msg.id}
              className={`flex ${isUser ? 'justify-start' : 'justify-end'}`}
            >
              <div
                className={`min-w-0 max-w-[94%] rounded-2xl px-4 py-3 sm:max-w-[85%] sm:px-5 sm:py-4 lg:max-w-3xl ${
                  isUser
                    ? 'bg-blue-700 text-white dark:bg-blue-600'
                    : 'border border-slate-200 bg-slate-50/80 text-slate-900 dark:border-slate-800 dark:bg-slate-800/70 dark:text-slate-100'
                }`}
              >
                {msg.attachmentName && (
                  <div className="mb-2 flex items-center gap-2 rounded-lg bg-black/15 px-3 py-1.5 text-xs">
                    {msg.attachmentType === 'pdf' ? (
                      <FileText className="h-4 w-4 shrink-0" />
                    ) : (
                      <ImageIcon className="h-4 w-4 shrink-0" />
                    )}
                    <span className="truncate">{msg.attachmentName}</span>
                  </div>
                )}

                {msg.engineNote && (
                  <div className="mb-3 flex items-center gap-2 rounded-xl border border-teal-200 bg-teal-50 px-3 py-2 text-xs text-teal-900 dark:border-teal-800 dark:bg-teal-950/60 dark:text-teal-200">
                    <Calculator className="h-4 w-4 shrink-0" />
                    <span className="font-medium">
                      تحقق محرك المصفوفات والمعادلات المدمج
                    </span>
                  </div>
                )}

                {isUser ? (
                  <p className="whitespace-pre-wrap text-[15px] leading-7">
                    {msg.content}
                  </p>
                ) : (
                  <MathText text={msg.content} />
                )}
              </div>
            </div>
          );
        })}

        {sending && (
          <div className="flex justify-end">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-5 py-4 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-800 dark:text-slate-300">
              جارٍ تحليل المسألة وصياغة الحل خطوة بخطوة...
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">
            {error}
          </div>
        )}

        <div ref={endOfChatRef} />
      </div>

      {/* Quick Prompts + Composer */}
      <div className="border-t border-slate-200 p-4 dark:border-slate-800">
        {/* Quick Helpers integrated cleanly */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() =>
              insertTemplate(
                'احسب محدد ومعكوس المصفوفة [[3,1],[5,2]] خطوة بخطوة',
                'matrix_compute'
              )
            }
            className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-600 transition-colors hover:border-blue-400 hover:text-blue-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
          >
            مثال مصفوفة 2×2
          </button>
          <button
            type="button"
            onClick={() =>
              insertTemplate(
                'حل المعادلة 2x^2 - 5x + 2 = 0 عبر المميز دلتا',
                'solve'
              )
            }
            className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-600 transition-colors hover:border-blue-400 hover:text-blue-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
          >
            حل معادلة درجة ثانية
          </button>
          <button
            type="button"
            onClick={() =>
              insertTemplate(
                'صحح إجابتي: لحساب مشتق ln(x^2+1) كتبت 1/(x^2+1)، هل حلي صحيح؟',
                'grade_answer'
              )
            }
            className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-600 transition-colors hover:border-blue-400 hover:text-blue-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
          >
            تصحيح إجابة طالب
          </button>
          <button
            type="button"
            onClick={() =>
              insertTemplate(
                'أنشئ لي 3 تمارين مشابهة لدرس النهايات وحالات عدم التعيين مع الحل النهائي',
                'generate_practice'
              )
            }
            className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-600 transition-colors hover:border-blue-400 hover:text-blue-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
          >
            توليد تمارين مشابهة
          </button>
        </div>

        {attachment && (
          <div className="mb-2 flex items-center justify-between rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900 dark:border-blue-800 dark:bg-blue-950/50 dark:text-sky-200">
            <div className="flex items-center gap-2 truncate">
              {attachment.type.includes('pdf') ? (
                <FileText className="h-4 w-4 shrink-0" />
              ) : (
                <ImageIcon className="h-4 w-4 shrink-0" />
              )}
              <span className="truncate font-medium">
                {attachment.name} ({(attachment.size / (1024 * 1024)).toFixed(1)} MB)
              </span>
            </div>
            <button
              type="button"
              onClick={() => setAttachment(null)}
              aria-label="إزالة المرفق"
              className="rounded-lg p-1 hover:bg-blue-100 dark:hover:bg-blue-900"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        <form onSubmit={handleSend} className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,application/pdf"
            className="hidden"
            onChange={(e) => {
              const chosen = e.target.files?.[0] ?? null;
              if (chosen && chosen.size > 100 * 1024 * 1024) {
                setError('حجم الملف المرفق يتجاوز الحد الأقصى المسموح به (100 ميغابايت).');
                setAttachment(null);
                e.target.value = '';
                return;
              }
              setError(null);
              setAttachment(chosen);
            }}
          />

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title="إرفاق صورة مسألة أو ملف PDF"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-slate-600 transition-colors hover:border-blue-400 hover:text-blue-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
          >
            <Paperclip className="h-5 w-5" />
          </button>

          <textarea
            rows={2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={
              TUTOR_MODES.find((m) => m.id === mode)?.hint ||
              'اكتب سؤالك الرياضي هنا...'
            }
            className="min-h-[44px] max-h-32 flex-1 resize-none rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-900 outline-none transition-colors focus:border-blue-600 focus:bg-white dark:border-slate-700 dark:bg-slate-800 dark:text-white"
          />

          <button
            type="submit"
            disabled={sending || (!input.trim() && !attachment)}
            className="flex h-11 shrink-0 items-center gap-2 rounded-xl bg-blue-700 px-5 text-sm font-semibold text-white transition-colors hover:bg-blue-800 disabled:opacity-50 dark:bg-blue-600 dark:hover:bg-blue-700"
          >
            <Send className="h-4 w-4" />
            <span className="hidden sm:inline">إرسال</span>
          </button>
        </form>
      </div>
    </div>
  );
}
