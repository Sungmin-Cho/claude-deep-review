export interface SessionStore {
  read(id: string): Promise<Session | null>;
  write(session: Session): Promise<void>;
}

export interface Session {
  id: string;
  userId: string;
  expiresAt: number;
}
