// Every kind of card page, in one place: what it is called on air, which verdicts it takes, and the
// colours of the verdicts that are not the FactBox five (those live in the book's card look).
// SLIDEBOOK_PLAN.md §11.3.

export const CARD_KINDS = ['claim', 'fallacy', 'qa', 'moderation', 'contradiction', 'scorecard'] as const;
export type CardKind = typeof CARD_KINDS[number];

export const isCardKind = (k: string | undefined): k is CardKind => !!k && (CARD_KINDS as readonly string[]).includes(k);

export const KIND_NAME: Record<CardKind, string> = {
  claim: 'Claim', fallacy: 'Fallacy', qa: 'Q & A', moderation: 'Moderation', contradiction: 'Contradiction', scorecard: 'Scorecard',
};

export const KIND_LABEL: Partial<Record<CardKind, string>> = {
  qa: 'DID THEY ANSWER?', moderation: 'MODERATION', contradiction: 'CONTRADICTION', scorecard: 'SCORECARD',
};

export const KIND_VERDICTS: Partial<Record<CardKind, readonly string[]>> = {
  qa: ['ANSWERED', 'PARTIAL', 'DODGED'],
  moderation: ['FAIR', 'UNEVEN', 'ABSENT'],
};

export const VERDICT_WORD: Record<string, string> = { PARTIAL: 'PARTLY ANSWERED' };

export const EXTRA_COLORS: Record<string, string> = {
  ANSWERED: '#16a34a', PARTIAL: '#ca8a04', DODGED: '#dc2626',
  FAIR: '#16a34a', UNEVEN: '#ea580c', ABSENT: '#475569',
  contradiction: '#db2777', scorecard: '#0ea5e9',
};
