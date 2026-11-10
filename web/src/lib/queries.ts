import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../ui/kit.tsx';
import * as A from './api.ts';
import { api, todayLocal } from './api.ts';

const MIN = 60_000;
const q = api.qs;

export const useStatus = () => useQuery({ queryKey: ['status'], queryFn: () => api.get<A.Status>('/status'), refetchInterval: MIN });

// ---- news ----
export const useNewsMeta = () => useQuery({ queryKey: ['news', 'meta'], queryFn: () => api.get<A.NewsMeta>('/news/meta'), staleTime: 5 * MIN });
export const useStories = (p: { hours: number; country?: string | null; topic?: string | null; limit?: number }) =>
  useQuery({ queryKey: ['news', 'stories', p], queryFn: () => api.get<A.StoryDto[]>(`/news/stories${q(p)}`), refetchInterval: 5 * MIN });
export const useStory = (id: number | null) => useQuery({ queryKey: ['news', 'story', id], queryFn: () => api.get<A.StoryDto>(`/news/stories/${id}`), enabled: id !== null });
export const useMap = (hours: number) => useQuery({ queryKey: ['news', 'map', hours], queryFn: () => api.get<A.MapCountry[]>(`/news/map${q({ hours })}`), refetchInterval: 5 * MIN });
export const useArticles = (p: Record<string, string | number | undefined | null>, enabled = true) =>
  useQuery({ queryKey: ['news', 'articles', p], queryFn: () => api.get<{ total: number; items: A.ArticleDto[] }>(`/news/articles${q(p)}`), enabled, placeholderData: (prev) => prev });
export const useTrend = (p: { country?: string | null; topic?: string | null; days: number }, enabled = true) =>
  useQuery({ queryKey: ['news', 'trend', p], queryFn: () => api.get<A.Trend>(`/news/trends${q(p)}`), enabled });
export const useGdelt = (query: string | null, span: string) =>
  useQuery({ queryKey: ['news', 'gdelt', query, span], queryFn: () => api.get<A.Gdelt>(`/news/gdelt${q({ q: query, span })}`), enabled: Boolean(query), staleTime: 60 * MIN, retry: false });
export const useSources = () => useQuery({ queryKey: ['news', 'sources'], queryFn: () => api.get<A.NewsSource[]>('/news/sources') });

// ---- markets ----
export const useBoard = () => useQuery({ queryKey: ['markets', 'board'], queryFn: () => api.get<A.BoardRow[]>('/markets/board'), refetchInterval: MIN });
export const useWatchlist = () => useQuery({ queryKey: ['markets', 'watchlist'], queryFn: () => api.get<A.WatchRow[]>('/markets/watchlist'), refetchInterval: MIN });
export const useHistory = (symbol: string, range: A.RangeKey) =>
  useQuery({ queryKey: ['markets', 'history', symbol, range], queryFn: () => api.get<A.History>(`/markets/history/${encodeURIComponent(symbol)}${q({ range })}`), staleTime: 5 * MIN, placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[2] === symbol ? prev : undefined) });
export const useCompany = (symbol: string) => useQuery({ queryKey: ['markets', 'company', symbol], queryFn: () => api.get<A.Company>(`/markets/company/${encodeURIComponent(symbol)}`), refetchInterval: MIN });
export const usePortfolio = () => useQuery({ queryKey: ['markets', 'portfolio'], queryFn: () => api.get<A.Portfolio>('/markets/portfolio'), refetchInterval: MIN });
export const usePortfolioRisk = (enabled: boolean) => useQuery({ queryKey: ['markets', 'portfolio', 'risk'], queryFn: () => api.get<A.PortfolioRisk>('/markets/portfolio/risk'), enabled, staleTime: 10 * MIN });
export const useTransactions = () => useQuery({ queryKey: ['markets', 'transactions'], queryFn: () => api.get<A.Transaction[]>('/markets/transactions') });
export const useNotes = (symbol?: string) => useQuery({ queryKey: ['markets', 'notes', symbol ?? 'all'], queryFn: () => api.get<A.Note[]>(`/markets/notes${q({ symbol })}`) });
export const useSymbolSearch = (term: string) =>
  useQuery({ queryKey: ['markets', 'search', term], queryFn: () => api.get<A.SearchHit[]>(`/markets/search${q({ q: term })}`), enabled: term.trim().length >= 1, staleTime: 60 * MIN, retry: false });

// ---- personal ----
export const usePersonal = () => useQuery({ queryKey: ['personal', 'overview', todayLocal()], queryFn: () => api.get<A.PersonalOverview>(`/personal/overview${q({ today: todayLocal() })}`) });
export const useTasks = () => useQuery({ queryKey: ['personal', 'tasks'], queryFn: () => api.get<A.Task[]>('/personal/tasks') });
export const useDeadlines = () => useQuery({ queryKey: ['personal', 'deadlines'], queryFn: () => api.get<A.Deadline[]>('/personal/deadlines') });
export const useRuns = () => useQuery({ queryKey: ['personal', 'runs'], queryFn: () => api.get<A.RunEntry[]>('/personal/runs') });

// ---- analyst ----
export const useConversations = () => useQuery({ queryKey: ['analyst', 'conversations'], queryFn: () => api.get<A.ConversationList>('/analyst/conversations') });
export const useConversation = (id: number | null) => useQuery({ queryKey: ['analyst', 'conversation', id], queryFn: () => api.get<A.Conversation>(`/analyst/conversations/${id}`), enabled: id !== null });
export const useReports = () => useQuery({ queryKey: ['analyst', 'reports'], queryFn: () => api.get<A.ReportSummary[]>('/analyst/reports') });
export const useReport = (id: number | null) => useQuery({ queryKey: ['analyst', 'report', id], queryFn: () => api.get<A.Report>(`/analyst/reports/${id}`), enabled: id !== null });

/**
 * Mutation that refreshes every query under the given key prefixes on success
 * and reports the outcome in a toast, so no action ever fails silently.
 */
export function useAct<V, T = unknown>(fn: (vars: V) => Promise<T>, opts: { invalidate: string[]; success?: string | ((data: T, vars: V) => string | undefined); onDone?: (data: T, vars: V) => void; quietError?: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data, vars) => {
      for (const key of opts.invalidate) void qc.invalidateQueries({ queryKey: [key] });
      const message = typeof opts.success === 'function' ? opts.success(data, vars) : opts.success;
      if (message) toast(message);
      opts.onDone?.(data, vars);
    },
    onError: (err) => {
      if (!opts.quietError) toast(err instanceof Error ? err.message : 'Something went wrong', true);
    },
  });
}
