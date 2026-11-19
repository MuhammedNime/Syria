import {
  ActivityLog,
  CurriculumBook,
  GradeInfo,
  Lesson,
  PdfProcessingJob,
  StudentLessonProgress,
  TutorMode,
  Unit,
  UserProfile,
} from '../types';

const TOKEN_KEY = 'syrian_math_auth_token';

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token: string | null) {
  try {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    // Ignore storage errors
  }
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const token = getStoredToken();
  const headers = new Headers(options.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (!(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `خطأ في الخادم (${res.status})`);
  }
  return data as T;
}

export interface GradeWithCounts extends GradeInfo {
  booksCount: number;
  unitsCount: number;
  lessonsCount: number;
}

export interface EnrichedBook extends CurriculumBook {
  units: Unit[];
  lessons: Lesson[];
}

export const api = {
  health: () =>
    request<{
      ok: boolean;
      geminiConfigured: boolean;
      supabaseConfigured: boolean;
      persistentStoreActive: boolean;
    }>('/api/health'),

  login: (email: string, password: string, gradeId?: number) =>
    request<{ user: UserProfile; token: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password, gradeId }),
    }),

  register: (payload: {
    name: string;
    email: string;
    password: string;
    gradeId: number;
  }) =>
    request<{ user: UserProfile; token: string }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  me: () => request<{ user: UserProfile | null }>('/api/auth/me'),

  updateGrade: (gradeId: number) =>
    request<{ user: UserProfile }>('/api/auth/grade', {
      method: 'PATCH',
      body: JSON.stringify({ gradeId }),
    }),

  getGrades: () => request<{ grades: GradeWithCounts[] }>('/api/grades'),

  getCurriculum: (gradeId: number, includePrevious = false) =>
    request<{
      grade: GradeInfo;
      books: CurriculumBook[];
      units: Unit[];
      lessons: Lesson[];
    }>(`/api/curriculum?grade=${gradeId}${includePrevious ? '&includePrevious=true' : ''}`),

  getLibraryBooks: (params?: { grade?: number; q?: string }) => {
    const sp = new URLSearchParams();
    if (params?.grade) sp.set('grade', String(params.grade));
    if (params?.q) sp.set('q', params.q);
    const qs = sp.toString();
    return request<{ books: EnrichedBook[] }>(`/api/library/books${qs ? `?${qs}` : ''}`);
  },

  downloadBookPdf: async (bookId: string): Promise<Blob> => {
    const token = getStoredToken();
    const headers = new Headers();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const res = await fetch(`/api/library/books/${encodeURIComponent(bookId)}/pdf`, {
      headers,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error((data as { error?: string }).error || 'تعذر تنزيل ملف PDF');
    }
    return res.blob();
  },

  getLesson: (lessonId: string) =>
    request<{
      lesson: Lesson;
      unit: Unit | null;
      book: CurriculumBook | null;
      grade: GradeInfo | null;
      siblingLessons: Lesson[];
    }>(`/api/lessons/${encodeURIComponent(lessonId)}`),

  getProgress: () =>
    request<{
      progress: StudentLessonProgress[];
      activities: ActivityLog[];
      isGuestDemo: boolean;
    }>('/api/progress'),

  recordLessonProgress: (lessonId: string, completed?: boolean) =>
    request<{
      progress?: StudentLessonProgress[];
      activities?: ActivityLog[];
    }>('/api/progress/lesson', {
      method: 'POST',
      body: JSON.stringify({ lessonId, completed }),
    }),

  submitQuiz: (lessonId: string, answers: Record<string, number>) =>
    request<{
      score: number;
      total: number;
      results: Array<{
        questionId: string;
        selected?: number;
        correctIndex: number;
        isCorrect: boolean;
        explanation: string;
      }>;
    }>('/api/progress/quiz', {
      method: 'POST',
      body: JSON.stringify({ lessonId, answers }),
    }),

  askTutor: (payload: {
    message: string;
    gradeId: number;
    lessonId?: string;
    bookId?: string;
    mode: TutorMode;
    history: Array<{ role: 'user' | 'assistant'; content: string }>;
    file?: File | null;
  }) => {
    const fd = new FormData();
    fd.append('message', payload.message);
    fd.append('gradeId', String(payload.gradeId));
    if (payload.lessonId) fd.append('lessonId', payload.lessonId);
    if (payload.bookId) fd.append('bookId', payload.bookId);
    fd.append('mode', payload.mode);
    fd.append('history', JSON.stringify(payload.history));
    if (payload.file) fd.append('file', payload.file);
    return request<{ reply: string; engineNote?: string }>('/api/tutor/chat', {
      method: 'POST',
      body: fd,
    });
  },

  uploadPdfBook: (payload: { file: File; gradeId: number; title?: string }) => {
    const fd = new FormData();
    fd.append('pdf', payload.file);
    fd.append('gradeId', String(payload.gradeId));
    if (payload.title) fd.append('title', payload.title);
    return request<{
      book: CurriculumBook;
      units: Unit[];
      lessons: Lesson[];
      job: PdfProcessingJob;
    }>('/api/library/upload-pdf', {
      method: 'POST',
      body: fd,
    });
  },

  // Admin endpoints
  adminOverview: () =>
    request<{
      books: CurriculumBook[];
      units: Unit[];
      lessons: Lesson[];
      jobs: PdfProcessingJob[];
      usersCount: number;
    }>('/api/admin/overview'),

  adminCreateBook: (payload: Partial<CurriculumBook>) =>
    request<{ book: CurriculumBook }>('/api/admin/books', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  adminUpdateBook: (id: string, payload: Partial<CurriculumBook>) =>
    request<{ book: CurriculumBook }>(`/api/admin/books/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),

  adminDeleteBook: (id: string) =>
    request<{ ok: boolean }>(`/api/admin/books/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  adminReindexBook: (id: string) =>
    request<{
      book: CurriculumBook;
      units: Unit[];
      lessons: Lesson[];
      job: PdfProcessingJob;
    }>(`/api/admin/books/${encodeURIComponent(id)}/reindex`, {
      method: 'POST',
    }),

  adminCreateUnit: (payload: Partial<Unit>) =>
    request<{ unit: Unit }>('/api/admin/units', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  adminUpdateUnit: (id: string, payload: Partial<Unit>) =>
    request<{ unit: Unit }>(`/api/admin/units/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),

  adminDeleteUnit: (id: string) =>
    request<{ ok: boolean }>(`/api/admin/units/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  adminCreateLesson: (payload: Partial<Lesson>) =>
    request<{ lesson: Lesson }>('/api/admin/lessons', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  adminUpdateLesson: (id: string, payload: Partial<Lesson>) =>
    request<{ lesson: Lesson }>(`/api/admin/lessons/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),

  adminDeleteLesson: (id: string) =>
    request<{ ok: boolean }>(`/api/admin/lessons/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
};
