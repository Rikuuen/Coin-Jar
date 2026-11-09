import { createInitialState, getSummary, recommend, type Bill, type Preferences } from './domain';

export type HostedSnapshot = { revision: string; setupRequired?: boolean; capabilities?: { memory: boolean; wallet: boolean }; preferences?: Preferences & { confirmedWeekend?: boolean; openingCashCents?: number; openingCashDate?: string; setupComplete?: boolean; balanceAdjustments?: Array<{ id: string; date: string; deltaCents: number; createdAt: string }> }; bills?: Bill[]; walletAddress?: string | null; entries: Array<{ id: string; kind: 'income' | 'expense' | 'recorded_saving'; amount_centavos: string; entry_date: string; note: string; created_at?: string; voided_at?: string | null; void_reason?: string | null; replacement_id?: string | null }>; goal: null | { id: string; title: string; target_centavos: string; target_date: string | null; status?: 'active' | 'paused' | 'completed'; created_at?: string } };

export function hostedSavings(snapshot: HostedSnapshot, today: string) {
  const state = createInitialState(today);
  state.preferences = snapshot.preferences ?? state.preferences;
  state.openingCashCents = snapshot.preferences?.openingCashCents ?? 0;
  state.openingCashDate = snapshot.preferences?.openingCashDate;
  state.balanceAdjustments = snapshot.preferences?.balanceAdjustments;
  state.rememberedWeekendSpending = snapshot.preferences?.confirmedWeekend === true;
  if (state.rememberedWeekendSpending && snapshot.preferences?.limitProvenance?.restored) state.weekendProvenance = { restored: true, remoteId: snapshot.preferences.limitProvenance.remoteId, observations: snapshot.preferences.limitProvenance.observations };
  state.bills = snapshot.bills ?? [];
  state.entries = snapshot.entries.map((entry) => ({ id: entry.id, kind: entry.kind === 'recorded_saving' ? 'contribution' : entry.kind, amountCents: Number(entry.amount_centavos), date: entry.entry_date, note: entry.note, createdAt: entry.created_at ?? '', ...(entry.voided_at ? { voidedAt: entry.voided_at } : {}) }));
  if (snapshot.goal) state.goal = { id: snapshot.goal.id, title: snapshot.goal.title, targetCents: Number(snapshot.goal.target_centavos), targetDate: snapshot.goal.target_date ?? undefined, status: snapshot.goal.status ?? 'active', createdAt: snapshot.goal.created_at ?? '' };
  return { summary: getSummary(state, today), recommendation: recommend(state, today) };
}
