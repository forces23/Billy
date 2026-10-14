export interface PollCheckpointRepository {
  get(name: string): Promise<Date | null>;
  save(name: string, checkpoint: Date): Promise<void>;
}
