/** OMP's persisted side conversations, never part of the main transcript or model context. */
export interface BtwTurn {
  question: string;
  answer: string;
  status: "running" | "complete" | "cancelled" | "error" | "interrupted";
  createdAt: number;
  updatedAt: number;
  error?: string;
}

export interface BtwTopic extends BtwTurn {
  id: string;
  leafId: string | null;
  followUps?: BtwTurn[];
}

export interface BtwHistory {
  topics: BtwTopic[];
}
