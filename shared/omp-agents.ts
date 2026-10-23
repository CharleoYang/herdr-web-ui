/** Read-only checkpoints from the selected OMP session's direct child transcripts. */
export interface OmpAgent {
  id: string;
  agent: string | null;
  model: string | null;
  assignment: string;
  /** No terminal checkpoint is not proof that an in-process agent is still alive. */
  status: "unknown" | "submitted" | "failed" | "cancelled" | "interrupted";
  activity: string;
  updatedAt: string | null;
  result: string;
}

export interface OmpAgents {
  agents: OmpAgent[];
}
