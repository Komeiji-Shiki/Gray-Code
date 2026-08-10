/**
 * useDependency - 依赖检查复用逻辑
 * 
 * 用于检查和管理工具所需的外部依赖
 */

import { ref, computed, onMounted, type Ref } from 'vue'
import { sendToExtension } from '../utils/vscode'

export interface DependencyInfo {
  name: string
  installed: boolean
  version?: string
  installedVersion?: string
  description?: string
}

export interface UseDependencyOptions {
  /**
   * 需要检查的依赖名称列表。
   * 支持静态数组（setup 时一次性捕获）或响应式源（Ref<string[]> / () => string[]，
   * 随响应式变化重新计算 allInstalled/missingDependencies）。
   * 约束：传入静态数组时只在 setup 时捕获一次，调用方后续更新数组不会反映到本 composable。
   */
  dependencies: string[] | Ref<string[]> | (() => string[])
  /** 是否在挂载时自动检查 */
  autoCheck?: boolean
}

export interface UseDependencyReturn {
  /** 依赖状态映射 */
  dependencyStatus: Ref<Map<string, boolean>>
  /** 是否正在加载 */
  loading: Ref<boolean>
  /** 是否所有依赖都已安装 */
  allInstalled: Ref<boolean>
  /** 获取缺失的依赖列表 */
  missingDependencies: Ref<string[]>
  /** 检查依赖状态 */
  checkDependencies: () => Promise<void>
  /** 检查单个依赖是否已安装 */
  isInstalled: (name: string) => boolean
}

function resolveDependencies(source: UseDependencyOptions['dependencies']): string[] {
  if (typeof source === 'function') return (source as () => string[])()
  if (Array.isArray(source)) return source
  return source.value
}

/**
 * 依赖检查 composable
 * 
 * @param options 配置选项
 * @returns 依赖状态和检查方法
 * 
 * @example
 * ```ts
 * const { allInstalled, missingDependencies, loading } = useDependency({
 *   dependencies: ['sharp'],
 *   autoCheck: true
 * })
 * ```
 */
export function useDependency(options: UseDependencyOptions): UseDependencyReturn {
  const { dependencies, autoCheck = true } = options

  // 依赖列表跟随响应式源（Ref/getter）变化；静态数组保持一次性捕获语义
  const dependencyList = computed(() => resolveDependencies(dependencies))
  
  const dependencyStatus = ref<Map<string, boolean>>(new Map())
  const loading = ref(false)
  
  // 计算是否所有依赖都已安装
  const allInstalled = computed(() => {
    const deps = dependencyList.value
    if (deps.length === 0) return true
    return deps.every(dep => dependencyStatus.value.get(dep) === true)
  })
  
  // 计算缺失的依赖列表
  const missingDependencies = computed(() => {
    return dependencyList.value.filter(dep => dependencyStatus.value.get(dep) !== true)
  })
  
  // 检查依赖状态
  async function checkDependencies(): Promise<void> {
    loading.value = true
    try {
      const result = await sendToExtension<{ dependencies: DependencyInfo[] }>('dependencies.list', {})
      dependencyStatus.value.clear()
      for (const dep of result.dependencies || []) {
        dependencyStatus.value.set(dep.name, dep.installed)
      }
    } catch (error) {
      console.error('Failed to check dependencies:', error)
      // 检查失败时，假设依赖未安装
      for (const dep of dependencyList.value) {
        dependencyStatus.value.set(dep, false)
      }
    } finally {
      loading.value = false
    }
  }
  
  // 检查单个依赖是否已安装
  function isInstalled(name: string): boolean {
    return dependencyStatus.value.get(name) === true
  }
  
  // 自动检查
  if (autoCheck) {
    onMounted(() => {
      checkDependencies()
    })
  }
  
  return {
    dependencyStatus,
    loading,
    allInstalled,
    missingDependencies,
    checkDependencies,
    isInstalled
  }
}

/**
 * 工具依赖配置
 * 定义哪些工具需要哪些依赖
 */
export const TOOL_DEPENDENCIES: Record<string, string[]> = {
  'remove_background': ['sharp'],
  'crop_image': ['sharp'],
  'resize_image': ['sharp'],
  'rotate_image': ['sharp']
}

/**
 * 获取工具所需的依赖
 */
export function getToolDependencies(toolName: string): string[] {
  return TOOL_DEPENDENCIES[toolName] || []
}

/**
 * 检查工具是否有依赖要求
 */
export function hasToolDependencies(toolName: string): boolean {
  return toolName in TOOL_DEPENDENCIES
}