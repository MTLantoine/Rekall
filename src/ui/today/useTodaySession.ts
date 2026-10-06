import { useEffect, useReducer, useState } from "react";
import type {
  TodayReview,
  TodaySnapshot,
} from "../../application/today-review";
import type { Card } from "../../domain/deck";
import type { CardProgress, Rating } from "../../domain/review";
import {
  advanceTodayQueue,
  countDueTomorrow,
  startOfReviewDay,
  type TodayQueue,
} from "../../domain/today-queue";
import {
  browserStorage,
  readJsonRecord,
} from "../../infrastructure/browser-storage";

type SessionState = {
  readonly queue: TodayQueue;
  readonly progressByCardId: ReadonlyMap<string, CardProgress>;
  /** Moment où la réponse a été révélée ; sert de référence aux intervalles affichés. */
  readonly revealedAt: Date | null;
};

type SessionAction =
  | { readonly type: "revealed"; readonly at: Date }
  | {
      readonly type: "rated";
      readonly progress: CardProgress;
      readonly at: Date;
    };

function sessionReducer(
  state: SessionState,
  action: SessionAction,
): SessionState {
  switch (action.type) {
    case "revealed":
      return state.revealedAt === null
        ? { ...state, revealedAt: action.at }
        : state;

    case "rated":
      return {
        queue: advanceTodayQueue(state.queue, action.progress.dueAt, action.at),
        progressByCardId: new Map(state.progressByCardId).set(
          action.progress.cardId,
          action.progress,
        ),
        revealedAt: null,
      };
  }
}

const SESSION_STORAGE_KEY = "revisions-tech:session:v1";

type StoredSession = {
  readonly reviewDay: number;
  readonly pendingCardIds: readonly string[];
  readonly reviewedCount: number;
  readonly revealedAt: string | null;
};

function loadStoredSession(
  snapshot: TodaySnapshot,
  loadedAt: Date,
): SessionState | null {
  const storage = browserStorage();
  const stored = readJsonRecord(
    storage,
    SESSION_STORAGE_KEY,
  ) as Partial<StoredSession>;

  if (
    typeof stored.reviewDay !== "number" ||
    stored.reviewDay !== startOfReviewDay(loadedAt).getTime() ||
    !Array.isArray(stored.pendingCardIds) ||
    typeof stored.reviewedCount !== "number"
  ) {
    return null;
  }

  const cardsById = new Map(
    snapshot.decks.flatMap((deck) =>
      deck.cards.map((card) => [card.id, card] as const),
    ),
  );

  const pending = stored.pendingCardIds
    .filter((cardId): cardId is string => typeof cardId === "string")
    .map((cardId) => cardsById.get(cardId))
    .filter((card): card is Card => card !== undefined);

  let revealedAt: Date | null = null;

  if (typeof stored.revealedAt === "string") {
    const parsed = new Date(stored.revealedAt);
    if (!Number.isNaN(parsed.getTime())) {
      revealedAt = parsed;
    }
  }

  return {
    queue: {
      pending,
      reviewedCount: stored.reviewedCount,
    },
    progressByCardId: snapshot.progressByCardId,
    revealedAt,
  };
}

function createInitialSession(
  snapshot: TodaySnapshot,
  loadedAt: Date,
): SessionState {
  return (
    loadStoredSession(snapshot, loadedAt) ?? {
      queue: snapshot.queue,
      progressByCardId: snapshot.progressByCardId,
      revealedAt: null,
    }
  );
}

function saveSession(state: SessionState, loadedAt: Date): void {
  browserStorage().setItem(
    SESSION_STORAGE_KEY,
    JSON.stringify({
      reviewDay: startOfReviewDay(loadedAt).getTime(),
      pendingCardIds: state.queue.pending.map((card) => card.id),
      reviewedCount: state.queue.reviewedCount,
      revealedAt: state.revealedAt?.toISOString() ?? null,
    } satisfies StoredSession),
  );
}

export type SaveStatus = "idle" | "saving" | "failed";

/** État de la session de révision : carte courante, révélation, notation. */
export function useTodaySession(
  todayReview: TodayReview,
  snapshot: TodaySnapshot,
  loadedAt: Date,
) {
  const [state, dispatch] = useReducer(
    sessionReducer,
    snapshot,
    (initial): SessionState => createInitialSession(initial, loadedAt),
  );

  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");

  useEffect(() => {
    saveSession(state, loadedAt);
  }, [state, loadedAt]);

  const currentCard: Card | undefined = state.queue.pending[0];

  const currentProgress =
    currentCard === undefined
      ? undefined
      : state.progressByCardId.get(currentCard.id);

  const dueDates =
    currentCard !== undefined && state.revealedAt !== null
      ? todayReview.previewDueDates(
          currentCard,
          currentProgress,
          state.revealedAt,
        )
      : null;

  const isNew = (card: Card): boolean => !state.progressByCardId.has(card.id);

  const allCards = snapshot.decks.flatMap((deck) => deck.cards);

  function reveal(): void {
    if (currentCard !== undefined) {
      dispatch({ type: "revealed", at: new Date() });
    }
  }

  /** Enregistre la note ; renvoie false si l'enregistrement a échoué (la carte reste affichée). */
  async function rate(rating: Rating): Promise<boolean> {
    if (
      currentCard === undefined ||
      state.revealedAt === null ||
      saveStatus === "saving"
    ) {
      return false;
    }

    setSaveStatus("saving");

    try {
      const now = new Date();
      const progress = await todayReview.rate(
        currentCard,
        currentProgress,
        rating,
        now,
      );

      dispatch({
        type: "rated",
        progress,
        at: now,
      });

      setSaveStatus("idle");
      return true;
    } catch (error) {
      console.error("Enregistrement de la note impossible", error);
      setSaveStatus("failed");
      return false;
    }
  }

  return {
    currentCard,
    revealedAt: state.revealedAt,
    dueDates,
    saveStatus,
    reveal,
    rate,
    reviewedCount: state.queue.reviewedCount,
    remainingNewCount: state.queue.pending.filter(isNew).length,
    remainingReviewCount: state.queue.pending.filter((card) => !isNew(card))
      .length,
    dueTomorrow: countDueTomorrow(state.progressByCardId, loadedAt),
    unseenCount: allCards.filter(isNew).length,
    seenCardCount: state.progressByCardId.size,
    progressByCardId: state.progressByCardId,
    cards: allCards,
  };
}

export type TodaySession = ReturnType<typeof useTodaySession>;
