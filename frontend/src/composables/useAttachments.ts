/**
 * useAttachments - 附件处理 Composable
 * 
 * 功能：
 * - 文件选择和验证
 * - 附件预览
 * - 附件上传
 * - 附件管理
 */

import { ref, computed, type Ref } from 'vue'
import type { Attachment, AttachmentType } from '../types'
import {
  validateFile,
  getFileType,
  formatFileSize,
  createThumbnail,
  inferMimeType
} from '../utils/file'
import { generateId } from '../utils/format'
import { showNotification } from '../utils/vscode'
import { useI18n } from './useI18n'

export function useAttachments(externalAttachments?: Ref<Attachment[]>) {
  // i18n
  const { t } = useI18n()
  
  // 状态：优先使用外部传入的 ref（store 驱动），否则使用本地 ref
  const attachments: Ref<Attachment[]> = externalAttachments ?? ref<Attachment[]>([])
  const uploading = ref(false)
  const uploadProgress = ref(0)

  // 计算属性
  const hasAttachments = computed(() => attachments.value.length > 0)
  const attachmentCount = computed(() => attachments.value.length)
  
  const totalSize = computed(() => 
    attachments.value.reduce((sum, att) => sum + att.size, 0)
  )

  const images = computed(() => 
    attachments.value.filter(att => att.type === 'image')
  )

  const videos = computed(() => 
    attachments.value.filter(att => att.type === 'video')
  )

  const documents = computed(() => 
    attachments.value.filter(att => att.type === 'document')
  )

  /**
   * 添加附件
   */
  async function addAttachment(file: File): Promise<Attachment | null> {
    // 验证文件
    const validation = validateFile(file)
    if (!validation.valid) {
      const errorMessage = validation.error || t('composables.useAttachments.errors.validationFailed')
      console.error(t('composables.useAttachments.errors.validationFailed'), errorMessage)
      await showNotification(errorMessage, 'error')
      return null
    }

    // 推断 MIME 类型（处理浏览器无法识别的扩展名，如 .md）
    const mimeType = inferMimeType(file.name, file.type)
    const type = getFileType(mimeType)
    
    // 创建附件对象
    const attachment: Attachment = {
      id: generateId(),
      name: file.name,
      type,
      size: file.size,
      mimeType,
      metadata: {}
    }

    // 为图片创建缩略图
    if (type === 'image') {
      try {
        const thumbnail = await createThumbnail(file)
        attachment.thumbnail = thumbnail
        
        // 获取图片尺寸
        const img = new Image()
        img.src = thumbnail
        await new Promise((resolve) => {
          const timeoutId = setTimeout(() => {
            img.onload = null
            img.onerror = null
            resolve(null)
          }, 10000)
          img.onload = () => {
            clearTimeout(timeoutId)
            attachment.metadata = {
              width: img.width,
              height: img.height
            }
            resolve(null)
          }
          img.onerror = () => {
            clearTimeout(timeoutId)
            resolve(null)
          }
        })
      } catch (error) {
        console.error(t('composables.useAttachments.errors.createThumbnailFailed'), error)
      }
    }
    
    // 为视频创建预览 URL
    if (type === 'video') {
      try {
        // 创建视频缩略图（使用第一帧）
        const thumbnail = await createVideoThumbnail(file)
        attachment.thumbnail = thumbnail
      } catch (error) {
        console.error(t('composables.useAttachments.errors.createVideoThumbnailFailed'), error)
      }
    }
    
    // 为音频创建预览 URL（使用 data URL）
    if (type === 'audio') {
      // 音频不需要缩略图，使用 data 字段即可在播放器中播放
      attachment.thumbnail = '' // 标记已处理
    }

    // 读取文件内容（转为 base64）
    try {
      const base64 = await fileToBase64(file)
      attachment.data = base64
    } catch (error) {
      console.error(t('composables.useAttachments.errors.readFileFailed'), error)
      await showNotification(t('composables.useAttachments.errors.readFileFailed'), 'error')
      return null
    }

    attachments.value.push(attachment)
    return attachment
  }

  /**
   * 批量添加附件
   */
  async function addAttachments(files: File[]): Promise<Attachment[]> {
    uploading.value = true
    uploadProgress.value = 0

    const results: Attachment[] = []
    const total = files.length

    try {
      for (let i = 0; i < files.length; i++) {
        const attachment = await addAttachment(files[i])
        if (attachment) {
          results.push(attachment)
        }
        uploadProgress.value = Math.round(((i + 1) / total) * 100)
      }
    } finally {
      // 任何路径（含未捕获异常）都必须复位上传状态
      uploading.value = false
      uploadProgress.value = 0
    }

    return results
  }

  /**
   * 移除附件
   */
  function removeAttachment(id: string): void {
    const index = attachments.value.findIndex(att => att.id === id)
    if (index !== -1) {
      attachments.value.splice(index, 1)
    }
  }

  /**
   * 清空所有附件
   */
  function clearAttachments(): void {
    attachments.value = []
  }

  /**
   * 获取附件
   */
  function getAttachment(id: string): Attachment | undefined {
    return attachments.value.find(att => att.id === id)
  }

  /**
   * 按类型过滤附件
   */
  function filterByType(type: AttachmentType): Attachment[] {
    return attachments.value.filter(att => att.type === type)
  }

  /**
   * 获取附件总大小（格式化）
   */
  function getTotalSizeFormatted(): string {
    return formatFileSize(totalSize.value)
  }

  /**
   * 获取单个附件大小（格式化）
   */
  function getAttachmentSize(id: string): string {
    const attachment = getAttachment(id)
    return attachment ? formatFileSize(attachment.size) : '0 B'
  }

  /**
   * 创建视频缩略图
   * 尝试多个时间点截取非黑帧
   */
  function createVideoThumbnail(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video')
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error(t('composables.useAttachments.errors.loadVideoFailed')))
        return
      }
      
      // 设置预加载
      video.preload = 'metadata'
      video.muted = true
      
      // 要尝试的时间点（秒）
      const timePoints = [0.1, 1, 2, 5]
      let currentTimeIndex = 0
      // 是否已 settle（resolve/reject/超时任一发生），防止重复回调
      let settled = false

      /** 统一清理：清除超时定时器与对象 URL */
      function cleanup(): void {
        window.clearTimeout(timeoutId)
        URL.revokeObjectURL(video.src)
      }

      // 整体超时：防止 Promise 永不 settle
      // （如 duration 为 NaN 时 currentTime 设为 NaN 后 onseeked 永不触发）
      const timeoutId = window.setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        reject(new Error(t('composables.useAttachments.errors.loadVideoFailed')))
      }, 10000)
      
      video.onloadedmetadata = () => {
        if (settled) return
        // duration 非法（NaN/Infinity/<=0）时直接放弃截帧，
        // 避免设置无效 currentTime 后 onseeked 永不触发导致 Promise 挂起
        if (!Number.isFinite(video.duration) || video.duration <= 0) {
          settled = true
          cleanup()
          reject(new Error(t('composables.useAttachments.errors.loadVideoFailed')))
          return
        }
        // 使用视频时长的 10% 或第一个时间点
        const targetTime = Math.min(video.duration * 0.1, timePoints[0])
        video.currentTime = Math.min(video.duration, Math.max(0, targetTime))
      }
      
      video.onseeked = () => {
        if (settled) return
        // 设置缩略图大小
        const maxSize = 200
        let width = video.videoWidth || 320
        let height = video.videoHeight || 180
        
        if (width > height) {
          if (width > maxSize) {
            height = height * (maxSize / width)
            width = maxSize
          }
        } else {
          if (height > maxSize) {
            width = width * (maxSize / height)
            height = maxSize
          }
        }
        
        canvas.width = width
        canvas.height = height
        ctx.drawImage(video, 0, 0, width, height)
        
        // 检查是否为黑帧（简单检测）
        const imageData = ctx.getImageData(0, 0, width, height)
        const data = imageData.data
        let brightness = 0
        for (let i = 0; i < data.length; i += 4) {
          brightness += (data[i] + data[i + 1] + data[i + 2]) / 3
        }
        brightness /= (data.length / 4)
        
        // 如果帧太暗且还有其他时间点可尝试
        if (brightness < 10 && currentTimeIndex < timePoints.length - 1) {
          currentTimeIndex++
          const nextTime = Math.min(timePoints[currentTimeIndex], Math.max(0, video.duration - 0.1))
          if (nextTime <= video.currentTime && video.currentTime >= video.duration) {
            settled = true
            cleanup()
            resolve(canvas.toDataURL('image/jpeg', 0.8))
            return
          }
          video.currentTime = nextTime
          return
        }
        
        // 清理
        settled = true
        cleanup()
        resolve(canvas.toDataURL('image/jpeg', 0.8))
      }
      
      video.onerror = () => {
        if (settled) return
        settled = true
        cleanup()
        reject(new Error(t('composables.useAttachments.errors.loadVideoFailed')))
      }
      
      video.onabort = () => {
        if (settled) return
        settled = true
        cleanup()
        reject(new Error(t('composables.useAttachments.errors.loadVideoFailed')))
      }
      
      video.src = URL.createObjectURL(file)
    })
  }

  /**
   * 文件转 Base64
   */
  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          // 移除 data URL 前缀
          const base64 = reader.result.split(',')[1]
          resolve(base64)
        } else {
          reject(new Error(t('composables.useAttachments.errors.readResultNotString')))
        }
      }
      
      reader.onerror = () => reject(reader.error || new Error(t('composables.useAttachments.errors.readFileFailed')))
      reader.onabort = () => reject(new Error(t('composables.useAttachments.errors.readFileFailed')))
      reader.readAsDataURL(file)
    })
  }

  /**
   * 检查是否可以添加更多附件
   */
  function canAddMore(maxCount = 10): boolean {
    return attachments.value.length < maxCount
  }

  /**
   * 获取附件类型统计
   */
  function getTypeStats(): Record<AttachmentType, number> {
    const stats: Record<AttachmentType, number> = {
      image: 0,
      video: 0,
      audio: 0,
      document: 0,
      code: 0
    }

    attachments.value.forEach(att => {
      if (att.type in stats) {
        stats[att.type] = (stats[att.type] || 0) + 1
      }
    })

    return stats
  }

  return {
    // 状态
    attachments,
    uploading,
    uploadProgress,

    // 计算属性
    hasAttachments,
    attachmentCount,
    totalSize,
    images,
    videos,
    documents,

    // 方法
    addAttachment,
    addAttachments,
    removeAttachment,
    clearAttachments,
    getAttachment,
    filterByType,
    getTotalSizeFormatted,
    getAttachmentSize,
    canAddMore,
    getTypeStats
  }
}