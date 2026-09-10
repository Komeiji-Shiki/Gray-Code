import * as host from '../../modules/memory';
import { createMemoryZoomRuntime } from './memory_zoomRuntime';
export const { createMemoryZoomDeclaration, createMemoryZoomTool, registerMemoryZoom } = createMemoryZoomRuntime(host);
