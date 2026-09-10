import { getSkillsManager } from '../../modules/skills';
import { createSkillReadRuntime } from './readSkillRuntime';
export const { generateReadSkillDeclaration, getReadSkillTool, getReadSkillToolRegistration, hasAvailableSkills } = createSkillReadRuntime(getSkillsManager);
