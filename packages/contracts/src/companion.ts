import type { PetModelCatalog } from './pets';

export type CompanionCharacterField = 'auto' | 'personality' | 'description' | 'both';

export interface CompanionConfiguration {
  enabled: boolean;
  characterId?: string;
  characterField?: CompanionCharacterField;
  petResourceId?: string;
  name: string;
  userName: string;
  tone: string;
}
export interface CompanionBinding {
  actorId: string;
  configuration: CompanionConfiguration;
  updatedAt: number;
  /** 保存陪伴配置时固定动作词表，后续回合不因播放器状态改变请求前缀。 */
  pet?: NonNullable<PetModelCatalog['resource']>;
  /** 仅比较已保存的词表内容；旧配置缺少指纹时视为已同步。 */
  petVocabularyFingerprint?: string;
}
export interface CompanionTurn extends CompanionBinding {
  identity: { name: string; personality: string };
  resource?: { id: string; revision: number | null; sha256: string };
  capturedAt: number;
}

export interface CompanionView {
  configuration: CompanionConfiguration;
  title?: string;
  metadataToken?: string;
  defaultsRevision: number | null;
  hasDefaults: boolean;
  characters: { id: string; name: string }[];
  pets: { id: string; name: string; kind: 'sprite' | 'live2d' }[];
  petHostAvailable: boolean;
  petVocabulary?: { resourceId: string; updated: boolean };
}

export type CompanionSaveInput = {
  conversationId?: string;
  metadataToken?: string;
  defaultsRevision?: number | null;
} & ({
  action?: 'save';
  configuration: CompanionConfiguration;
  saveAsDefault?: boolean;
} | {
  action: 'syncPetVocabulary';
  configuration?: never;
  saveAsDefault?: never;
});

export interface CompanionRpcMethods {
  'companion.get': { params: { conversationId?: string }; result: CompanionView };
  'companion.save': {
    params: CompanionSaveInput;
    result: { success: true; conversationId: string; view?: never } | { success: true; conversationId?: never; view: CompanionView };
  };
  'companion.defaults.clear': { params: { defaultsRevision: number | null }; result: { success: true } };
}
