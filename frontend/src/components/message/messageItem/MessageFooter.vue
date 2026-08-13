<script setup lang="ts">
/**
 * MessageFooter - 消息底部统计信息（时间 / TTFT / 响应时长 / Token 速率 / Token 用量）。
 * 从 MessageItem.vue 抽出（F-07）。
 */
import { useI18n } from '../../../i18n'
import type { UsageMetadata } from '../../../types'

const { t } = useI18n()

defineProps<{
  formattedTime: string | null
  ttft: string | null
  responseDuration: string | null
  tokenRate: string | null
  usage: UsageMetadata | undefined
  hasUsage: boolean
}>()
</script>

<template>
  <div class="message-footer">
    <div class="message-footer-left">
      <span v-if="formattedTime" class="message-time">{{ formattedTime }}</span>

      <!-- 首字延迟（TTFT） -->
      <span v-if="ttft" class="ttft" :title="t('components.message.stats.ttft')">
        <i class="codicon codicon-pulse" aria-hidden="true"></i>{{ ttft }}
      </span>

      <!-- 响应持续时间 -->
      <span v-if="responseDuration" class="response-duration" :title="t('components.message.stats.responseDuration')">
        <i class="codicon codicon-clock"></i>{{ responseDuration }}
      </span>

      <!-- Token 速率 -->
      <span v-if="tokenRate" class="token-rate" :title="t('components.message.stats.tokenRate')">
        <i class="codicon codicon-zap"></i>{{ t('components.message.stats.tokensPerSecond', { rate: tokenRate }) }}
      </span>
    </div>

    <!-- Token 使用统计 -->
    <div v-if="hasUsage" class="token-usage">
      <span v-if="usage?.totalTokenCount" class="token-total">
        {{ usage.totalTokenCount }}
      </span>
      <span v-if="usage?.promptTokenCount" class="token-item token-prompt">
        <span class="token-arrow">↑</span>{{ usage.promptTokenCount }}
      </span>
      <span v-if="usage?.cachedContentTokenCount" class="token-item token-cached">
        <span class="token-arrow">⚡</span>{{ usage.cachedContentTokenCount }}
      </span>
      <span v-if="usage?.candidatesTokenCount" class="token-item token-candidates">
        <span class="token-arrow">↓</span>{{ usage.candidatesTokenCount }}
      </span>
    </div>
  </div>
</template>

<style scoped>
/* 消息底部信息 */
.message-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: var(--spacing-sm, 8px);
}

.message-footer-left {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm, 8px);
}

.message-time {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  opacity: 0.7;
}

/* 响应持续时间 */
.response-duration {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  opacity: 0.7;
}

.response-duration .codicon {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
}

/* 首字延迟（TTFT） */
.ttft {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  opacity: 0.7;
}

/* 首字延迟图标用主题蓝点缀，与其他统计项区分，一眼可辨 */
.ttft .codicon {
  font-size: 10px;
  color: var(--vscode-charts-blue);
}

/* Token 速率 */
.token-rate {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  opacity: 0.7;
}

.token-rate .codicon {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
}

/* Token 使用统计 */
.token-usage {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm, 8px);
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  opacity: 0.7;
}

.token-total {
  font-weight: 500;
  color: var(--vscode-descriptionForeground);
}

.token-item {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.token-arrow {
  font-size: 10px;
  opacity: 0.8;
}

.token-prompt .token-arrow {
  color: var(--vscode-charts-green, #89d185);
}

.token-candidates .token-arrow {
  color: var(--vscode-charts-blue, #75beff);
}

.token-cached .token-arrow {
  color: var(--vscode-charts-yellow, #e2c08d);
}
</style>
