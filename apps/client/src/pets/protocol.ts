import type { PetCommandInput, PetConfiguration, PetImport, PetParameter, PetResource } from '@graycode/contracts';
export interface PetRenderPayload { resource: PetResource; bundle: PetImport; runtime?: string }
export interface PetRenderer {
  parameters: PetParameter[];
  apply(command: PetCommandInput | null, configuration: Pick<PetConfiguration, 'stopped' | 'reducedMotion'>): Promise<void>;
  resize(width: number, height: number): void;
  destroy(): void;
}
