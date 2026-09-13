export interface CompanionConfiguration {
  enabled: boolean;
  characterId?: string;
  name: string;
  userName: string;
  tone: string;
}
export interface CompanionBinding {
  actorId: string;
  configuration: CompanionConfiguration;
  updatedAt: number;
}
export interface CompanionTurn extends CompanionBinding {
  identity: { name: string; personality: string };
  resource?: { id: string; revision: number | null; sha256: string };
  capturedAt: number;
}
